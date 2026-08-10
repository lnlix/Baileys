import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { AuthenticationState } from '../../Types'
import { type BinaryNode } from '../../WABinary'

const sendNode = jest.fn(async () => undefined)
const authState = {
	creds: {
		me: {
			id: 'me@s.whatsapp.net',
			lid: 'me@lid'
		}
	},
	keys: {
		get: jest.fn(async () => ({})),
		set: jest.fn(async () => undefined),
		transaction: jest.fn(async (work: () => Promise<unknown>) => await work()),
		isInTransaction: jest.fn(() => false)
	}
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
		ws: { on: jest.fn(), isOpen: true },
		ev,
		registerSocketEndHandler: jest.fn(),
		onUnexpectedError: jest.fn(),
		signalRepository: {
			lidMapping: {
				getLIDForPN: jest.fn()
			}
		}
	}))
}))

const { makeMessagesRecvSocket } = await import('../../Socket/messages-recv')

describe('incoming message tctoken capture (Baileys#2698/#2707)', () => {
	beforeEach(() => {
		authState.keys.get.mockClear()
		authState.keys.set.mockClear()
		authState.keys.transaction.mockClear()
		authState.keys.isInTransaction.mockClear()
		sendNode.mockClear()
		evHandlers.clear()
		ev.on.mockClear()
		ev.emit.mockClear()
	})

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
})
