import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { AuthenticationState, MessageRelayOptions, WAMessageContent } from '../../Types'
import { type BinaryNode } from '../../WABinary'

const sendNode = jest.fn(async () => undefined)
const relayMessage = jest.fn<(jid: string, message: WAMessageContent, options: MessageRelayOptions) => Promise<string>>(
	async () => 'old-id'
)
const onUnexpectedError = jest.fn()
const keys = {
	get: jest.fn(async () => ({})),
	set: jest.fn(async () => undefined),
	transaction: jest.fn(async (work: () => Promise<unknown>) => await work()),
	isInTransaction: jest.fn(() => false)
}
const authState: { creds: { me?: { id: string; lid: string } }; keys: typeof keys } = {
	creds: {},
	keys
}
const evHandlers = new Map<string, Array<(arg: unknown) => void>>()
const ev = {
	on: jest.fn((event: string, handler: (arg: unknown) => void) => {
		const handlers = evHandlers.get(event) ?? []
		handlers.push(handler)
		evHandlers.set(event, handlers)
	}),
	buffer: jest.fn(),
	flush: jest.fn(),
	emit: jest.fn((event: string, arg: unknown) => {
		for (const handler of evHandlers.get(event) ?? []) {
			handler(arg)
		}
	})
}

jest.unstable_mockModule('../../Socket/messages-send', () => ({
	makeMessagesSocket: jest.fn(() => ({
		authState,
		sendNode,
		relayMessage,
		receiptMutex: { mutex: async (work: () => Promise<void>) => work() },
		assertSessions: jest.fn(async () => true),
		ws: { on: jest.fn(), isOpen: true },
		ev,
		registerSocketEndHandler: jest.fn(),
		onUnexpectedError,
		signalRepository: {
			jidToSignalProtocolAddress: (jid: string) => jid,
			lidMapping: {
				getLIDForPN: jest.fn()
			}
		}
	}))
}))

const { makeMessagesRecvSocket } = await import('../../Socket/messages-recv')

describe('messages-recv socket', () => {
	beforeEach(() => {
		authState.creds = {
			me: {
				id: 'me@s.whatsapp.net',
				lid: 'me@lid'
			}
		}
		authState.keys.get.mockClear()
		authState.keys.set.mockClear()
		authState.keys.transaction.mockClear()
		authState.keys.isInTransaction.mockClear()
		sendNode.mockClear()
		relayMessage.mockClear()
		onUnexpectedError.mockClear()
		evHandlers.clear()
		ev.on.mockClear()
		ev.emit.mockClear()
	})

	it.each(['200@s.whatsapp.net', '200:0@s.whatsapp.net', '200:2@s.whatsapp.net', '200@lid', '200:0@lid', '200:2@lid'])(
		'keeps a stored group message retry targeted to %s',
		async participant => {
			const message = { conversation: 'Fictional stored message' }
			const getMessage = jest.fn(async () => message)
			const sock = makeMessagesRecvSocket({
				...DEFAULT_CONNECTION_CONFIG,
				auth: authState as unknown as AuthenticationState,
				getMessage
			})
			const onCalls = (sock.ws.on as jest.Mock).mock.calls as [string, (node: BinaryNode) => Promise<void>][]
			const handler = onCalls.find(([tag]) => tag === 'CB:receipt')?.[1]
			expect(handler).toBeDefined()
			await handler?.({
				tag: 'receipt',
				attrs: { from: '300@g.us', participant, id: 'old-id', type: 'retry', edit: '1' },
				content: [{ tag: 'retry', attrs: { count: '1', t: '1700000000' } }]
			})

			expect(onUnexpectedError).not.toHaveBeenCalled()
			expect(getMessage).toHaveBeenCalledWith(expect.objectContaining({ remoteJid: '300@g.us', id: 'old-id' }))
			expect(relayMessage).toHaveBeenCalledTimes(1)
			expect(relayMessage).toHaveBeenCalledWith('300@g.us', message, {
				messageId: 'old-id',
				participant: { jid: participant, count: 1 },
				additionalAttributes: { t: '1700000000', edit: '1' }
			})
			expect(keys.set).not.toHaveBeenCalled()
			expect(ev.emit).not.toHaveBeenCalled()
			expect(sendNode).toHaveBeenCalledWith(expect.objectContaining({ tag: 'ack' }))
		}
	)

	it('stores a tctoken riding along on an incoming message, wired through the real CB:message handler', async () => {
		const sock = makeMessagesRecvSocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: authState as unknown as AuthenticationState
		})

		// Grab the handler messages-recv registered for incoming <message> stanzas
		const onCalls = (sock.ws.on as jest.Mock).mock.calls as [string, (node: BinaryNode) => Promise<void>][]
		const messageHandler = onCalls.find(([tag]) => tag === 'CB:message')?.[1]
		expect(messageHandler).toBeDefined()

		const node: BinaryNode = {
			tag: 'message',
			attrs: { from: 'contact@s.whatsapp.net', id: 'msg-1' },
			content: [
				{
					tag: 'tctoken',
					attrs: { t: '1700000000' },
					content: new Uint8Array([1, 2, 3, 4])
				}
			]
		}

		await messageHandler!(node)
		// Token capture is fire-and-forget (doesn't gate message processing) — flush microtasks
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(authState.keys.set).toHaveBeenCalledWith({
			tctoken: {
				'contact@s.whatsapp.net': {
					token: Buffer.from([1, 2, 3, 4]),
					timestamp: '1700000000'
				}
			}
		})
		sock.ev.emit('connection.update', { connection: 'close' })
		await new Promise(resolve => setTimeout(resolve, 0))
	})

	it('acknowledges notifications before credentials identify the device', async () => {
		authState.creds = {}
		const sock = makeMessagesRecvSocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: authState as unknown as AuthenticationState
		})
		const node: BinaryNode = {
			tag: 'notification',
			attrs: {
				id: 'pre-login-notification',
				from: 's.whatsapp.net',
				type: 'companion_reg_refresh'
			}
		}

		await expect(sock.sendMessageAck(node)).resolves.toBeUndefined()
		expect(sendNode).toHaveBeenCalledWith({
			tag: 'ack',
			attrs: {
				id: 'pre-login-notification',
				to: 's.whatsapp.net',
				class: 'notification',
				type: 'companion_reg_refresh'
			}
		})
	})
})
