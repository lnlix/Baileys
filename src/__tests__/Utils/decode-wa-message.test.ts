import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import { initAuthCreds } from '../../Utils/auth-utils'
import { decodeMessageNode, decryptMessageNode } from '../../Utils/decode-wa-message'
import type { BinaryNode } from '../../WABinary'
import { makeSignalStore, signalLogger } from '../TestUtils/signal-store'

const ME_ID = '5511999999999@s.whatsapp.net'
const ME_LID = '111111111111111@lid'
const PEER_ID = '5511888888888@s.whatsapp.net'
const GROUP_ID = '120363000000000000@g.us'
const PEER_LID = '222222222222222@lid'

describe('decryption identity fallback', () => {
	it.each(['success', 'fallback', 'both fail', 'no alternate'] as const)(
		'preserves primary and alternate handling: %s',
		async scenario => {
			const store = makeSignalStore()
			const repository = makeLibSignalRepository({ creds: initAuthCreds(), keys: store.keys }, signalLogger)
			const encoded = Buffer.concat([proto.Message.encode({ conversation: 'test' }).finish(), Buffer.from([1])])
			const decrypt = jest.spyOn(repository, 'decryptMessage')
			if (scenario === 'success') decrypt.mockResolvedValue(encoded)
			else {
				decrypt.mockRejectedValueOnce(new Error('Bad MAC'))
				if (scenario === 'fallback') decrypt.mockResolvedValueOnce(encoded)
				else decrypt.mockRejectedValue(new Error('no session'))
			}

			try {
				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						id: 'FALLBACK',
						t: '1700000000',
						from: PEER_LID,
						...(scenario === 'no alternate' ? {} : { sender_pn: PEER_ID })
					},
					content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from([1, 2, 3]) }]
				}
				const result = decryptMessageNode(stanza, ME_ID, ME_LID, repository, signalLogger)
				await result.decrypt()
				expect(decrypt.mock.calls.map(([args]) => args.jid)).toEqual(
					scenario === 'success' || scenario === 'no alternate' ? [PEER_LID] : [PEER_LID, PEER_ID]
				)
				if (scenario === 'success' || scenario === 'fallback')
					expect(result.fullMessage.message?.conversation).toBe('test')
				else expect(result.fullMessage.messageStubParameters).toEqual(['Bad MAC'])
			} finally {
				decrypt.mockRestore()
				repository.close?.()
				await store.keys.dispose()
			}
		}
	)
})

const message = (attrs: Record<string, string>): BinaryNode => ({
	tag: 'message',
	attrs: { t: '1700000000', ...attrs },
	content: []
})

const captureThrow = (fn: () => unknown): unknown => {
	try {
		fn()
	} catch (err) {
		return err
	}

	throw new Error('expected function to throw')
}

describe('decodeMessageNode', () => {
	describe('validation', () => {
		it('throws Boom when stanza has no id attribute', () => {
			const stanza = message({ from: PEER_ID })
			const err = captureThrow(() => decodeMessageNode(stanza, ME_ID, ME_LID))
			expect(err).toBeInstanceOf(Boom)
			expect((err as Error).message).toMatch(/missing id/)
		})

		it('throws Boom when stanza has no from attribute', () => {
			const stanza = message({ id: 'MSG_1' })
			const err = captureThrow(() => decodeMessageNode(stanza, ME_ID, ME_LID))
			expect(err).toBeInstanceOf(Boom)
			expect((err as Error).message).toMatch(/missing from/)
		})

		it('throws Boom for an unknown jid type', () => {
			const stanza = message({ id: 'MSG_1', from: 'unknown@server' })
			expect(() => decodeMessageNode(stanza, ME_ID, ME_LID)).toThrow(/Unknown message type/)
		})

		it('throws Boom for group message without participant', () => {
			const stanza = message({ id: 'MSG_1', from: GROUP_ID })
			expect(() => decodeMessageNode(stanza, ME_ID, ME_LID)).toThrow(/No participant/)
		})
	})

	describe('happy paths', () => {
		it('decodes a 1:1 incoming chat message', () => {
			const stanza = message({ id: 'MSG_1', from: PEER_ID })
			const result = decodeMessageNode(stanza, ME_ID, ME_LID)

			expect(result.fullMessage.key.id).toBe('MSG_1')
			expect(result.fullMessage.key.remoteJid).toBe(PEER_ID)
			expect(result.fullMessage.key.fromMe).toBeFalsy()
			expect(result.author).toBe(PEER_ID)
		})

		it('decodes an outgoing chat message (recipient set, from = me)', () => {
			const stanza = message({ id: 'MSG_2', from: ME_ID, recipient: PEER_ID })
			const result = decodeMessageNode(stanza, ME_ID, ME_LID)

			expect(result.fullMessage.key.fromMe).toBe(true)
			expect(result.fullMessage.key.remoteJid).toBe(PEER_ID)
		})

		it('rejects a recipient-tagged message that is not from me', () => {
			const stanza = message({ id: 'MSG_3', from: PEER_ID, recipient: ME_ID })
			expect(() => decodeMessageNode(stanza, ME_ID, ME_LID)).toThrow(/not from me/)
		})

		it('decodes a group message', () => {
			const stanza = message({ id: 'MSG_G', from: GROUP_ID, participant: PEER_ID })
			const result = decodeMessageNode(stanza, ME_ID, ME_LID)

			expect(result.fullMessage.key.remoteJid).toBe(GROUP_ID)
			expect(result.fullMessage.key.participant).toBe(PEER_ID)
			expect(result.author).toBe(PEER_ID)
		})
	})
})
