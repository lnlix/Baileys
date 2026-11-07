import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import { unpadRandomMax16 } from '../../Utils/generics'
import type { BinaryNode } from '../../WABinary'
import { getBinaryNodeChild, getBinaryNodeChildren, jidDecode, jidEncode } from '../../WABinary'

const sentFrames: Uint8Array[] = []

// Stands in for the WebSocket so relayMessage can run offline; it records each frame sent.
class RecordingSocketClient extends EventEmitter {
	isOpen = true
	isClosed = false
	isClosing = false
	isConnecting = false
	connect() {}
	close() {
		this.isOpen = false
		this.isClosed = true
	}
	send(data: Uint8Array, cb?: (err?: Error) => void) {
		sentFrames.push(Uint8Array.from(data))
		cb?.()
		return true
	}
}

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({ WebSocketClient: RecordingSocketClient }))

const { buildRetryResendAddressing, isOwnDeviceJid } = await import('../../Socket/messages-send')
const { default: makeWASocket } = await import('../../Socket')
const { DEFAULT_CONNECTION_CONFIG } = await import('../../Defaults')
const { initAuthCreds } = await import('../../Utils/auth-utils')
const { decodeBinaryNode } = await import('../../WABinary')

const meId = '5511999999999:4@s.whatsapp.net'
const meLid = '123456789012345:4@lid'

describe('isOwnDeviceJid', () => {
	it('matches our PN and LID devices', () => {
		expect(isOwnDeviceJid('5511999999999:7@s.whatsapp.net', meId, meLid)).toBe(true)
		expect(isOwnDeviceJid('123456789012345:7@lid', meId, meLid)).toBe(true)
		expect(isOwnDeviceJid('123456789012345:99@hosted.lid', meId, meLid)).toBe(true)
	})

	it('compares a PN device only with our PN, even when it shares digits with our LID', () => {
		expect(isOwnDeviceJid('123456789012345:7@s.whatsapp.net', meId, meLid)).toBe(false)
	})

	it('compares a LID device only with our LID, even when it shares digits with our PN', () => {
		expect(isOwnDeviceJid('5511999999999:7@lid', meId, meLid)).toBe(false)
	})

	it('does not treat a LID device as ours when our LID is unknown', () => {
		expect(isOwnDeviceJid('123456789012345:7@lid', meId, undefined)).toBe(false)
	})
})

describe('buildRetryResendAddressing', () => {
	it('sends a group retry to the group with the device as participant', () => {
		expect(buildRetryResendAddressing('120363000000000000@g.us', '987654321098765:2@lid', meId, meLid)).toEqual({
			to: '120363000000000000@g.us',
			participant: '987654321098765:2@lid'
		})
	})

	it('names the chat as recipient for one of our own PN devices', () => {
		expect(
			buildRetryResendAddressing('5511888888888@s.whatsapp.net', '5511999999999:7@s.whatsapp.net', meId, meLid)
		).toEqual({
			to: '5511999999999:7@s.whatsapp.net',
			recipient: '5511888888888@s.whatsapp.net'
		})
	})

	it('names the chat as recipient for one of our own LID devices', () => {
		expect(buildRetryResendAddressing('222222222222222@lid', '123456789012345:7@lid', meId, meLid)).toEqual({
			to: '123456789012345:7@lid',
			recipient: '222222222222222@lid'
		})
	})

	it('sends a retry for another user straight to their device', () => {
		expect(buildRetryResendAddressing('222222222222222@lid', '222222222222222:3@lid', meId, meLid)).toEqual({
			to: '222222222222222:3@lid'
		})
	})
})

describe('relayMessage retry to a single device', () => {
	// Before the Noise handshake a frame is the intro header (first frame only), a 3-byte length, then the node.
	const decodeSentNode = async (frame: Uint8Array): Promise<BinaryNode> => {
		for (let offset = 0; offset + 3 <= frame.length; offset++) {
			const length = (frame[offset]! << 16) | (frame[offset + 1]! << 8) | frame[offset + 2]!
			if (length === frame.length - offset - 3) {
				return decodeBinaryNode(Buffer.from(frame.subarray(offset + 3)))
			}
		}

		throw new Error('frame without a length prefix')
	}

	const relayRetry = async (destinationJid: string, participantJid: string) => {
		const encryptMessage = jest.fn(async ({ data }: { data: Uint8Array }) => {
			return { type: 'msg' as const, ciphertext: data }
		})
		const encryptGroupMessage = jest.fn(async () => {
			throw new Error('Retry must not broadcast group ciphertext')
		})
		const senderKey = new Uint8Array([4, 5, 6])
		const creds = initAuthCreds()
		creds.me = { id: meId, lid: meLid, name: 'Test' }
		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			logger: P({ level: 'silent' }),
			auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
			makeSignalRepository: (auth, logger, pnFromLIDUSync) => ({
				...DEFAULT_CONNECTION_CONFIG.makeSignalRepository(auth, logger, pnFromLIDUSync),
				validateSession: async () => ({ exists: true }),
				encryptMessage,
				encryptGroupMessage,
				hasSenderKey: async () => true,
				getSenderKeyDistributionMessage: async () => senderKey
			})
		})

		try {
			sentFrames.length = 0
			await sock.relayMessage(
				destinationJid,
				{ conversation: 'hello' },
				{
					messageId: 'RETRY_1',
					participant: { jid: participantJid, count: 1 },
					additionalAttributes: { t: '1700000000', edit: '1' }
				}
			)
			const nodes = await Promise.all(sentFrames.map(decodeSentNode))
			const stanza = nodes.find(node => node.tag === 'message' && node.attrs.id === 'RETRY_1')
			expect(stanza).toBeDefined()
			expect(encryptMessage).toHaveBeenCalledTimes(1)
			expect(encryptMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ jid: participantJid }))
			expect(encryptGroupMessage).not.toHaveBeenCalled()
			return stanza!
		} finally {
			// let the socket's startup tasks settle first, or end() leaves the event buffer timer running
			await new Promise(resolve => setTimeout(resolve, 50))
			await sock.end(undefined)
		}
	}

	it('names the chat as recipient when resending to our own LID device', async () => {
		const { attrs } = await relayRetry('222222222222222@lid', '123456789012345:7@lid')
		expect(attrs.to).toBe('123456789012345:7@lid')
		expect(attrs.recipient).toBe('222222222222222@lid')
	})

	it('sends a retry for another user straight to their device without a recipient', async () => {
		const { attrs } = await relayRetry('222222222222222@lid', '222222222222222:3@lid')
		expect(attrs.to).toBe('222222222222222:3@lid')
		expect(attrs.recipient).toBeUndefined()
	})

	it.each([
		'222222222222222@s.whatsapp.net',
		'222222222222222:0@s.whatsapp.net',
		'222222222222222:3@s.whatsapp.net',
		'222222222222222@lid',
		'222222222222222:0@lid',
		'222222222222222:3@lid',
		'123456789012345:7@lid'
	])('sends one encrypted group retry with its sender key only to %s', async participant => {
		const stanza = await relayRetry('120363000000000000@g.us', participant)
		const target = jidDecode(participant)
		if (!target) throw new Error('Invalid fixture participant')
		expect(stanza.attrs).toEqual(
			expect.objectContaining({
				to: '120363000000000000@g.us',
				participant: jidEncode(target.user, target.server, target.device),
				id: 'RETRY_1',
				t: '1700000000',
				edit: '1'
			})
		)
		expect(getBinaryNodeChild(stanza, 'participants')).toBeUndefined()
		const encrypted = getBinaryNodeChildren(stanza, 'enc')
		expect(encrypted).toHaveLength(1)
		expect(encrypted[0]?.attrs).toEqual({ v: '2', type: 'msg', count: '1' })
		const content = encrypted[0]?.content
		expect(content).toBeInstanceOf(Uint8Array)
		if (!(content instanceof Uint8Array)) throw new Error('Missing retry ciphertext')
		const message = proto.Message.decode(unpadRandomMax16(content))
		expect(message.conversation).toBe('hello')
		expect(message.deviceSentMessage).toBeNull()
		expect(message.senderKeyDistributionMessage?.groupId).toBe('120363000000000000@g.us')
		expect(message.senderKeyDistributionMessage?.axolotlSenderKeyDistributionMessage).toEqual(Buffer.from([4, 5, 6]))
	})
})
