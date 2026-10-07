import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import { initAuthCreds } from '../../Utils/auth-utils'
import { makeSignalStore, signalLogger } from '../TestUtils/signal-store'

class FakeWebSocket extends EventEmitter {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSING = 2
	static readonly CLOSED = 3
	readyState = FakeWebSocket.OPEN
	send(_data: Uint8Array | string, cb?: (err?: Error) => void) {
		cb?.()
	}
	close() {
		this.readyState = FakeWebSocket.CLOSED
		this.emit('close')
	}
}

jest.unstable_mockModule('ws', () => ({ default: FakeWebSocket }))
const { DEFAULT_CONNECTION_CONFIG } = await import('../../Defaults')
const { makeSocket } = await import('../../Socket/socket')

describe('socket transaction disposal', () => {
	it('can close inside a transaction without deadlock and leaves another socket usable', async () => {
		const a = makeSignalStore(),
			b = makeSignalStore()
		const first = makeSocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: a.state },
			logger: signalLogger
		})
		const second = makeSocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: b.state },
			logger: signalLogger
		})
		try {
			await first.authState.keys.transaction(async () => {
				await first.end(undefined)
				await first.authState.keys.set({ 'lid-mapping': { peer: 'drained' } })
			}, 'peer')
			await first.authState.keys.dispose()
			await first.end(undefined)
			await expect(first.authState.keys.get('lid-mapping', ['peer'])).rejects.toThrow('disposed')
			expect(a.data['lid-mapping']).toEqual({ peer: 'drained' })
			await second.authState.keys.transaction(async () => {
				await second.authState.keys.set({ 'lid-mapping': { peer: 'alive' } })
			}, 'peer')
			expect(b.data['lid-mapping']).toEqual({ peer: 'alive' })
		} finally {
			await first.end(undefined)
			await second.end(undefined)
			await Promise.all([
				first.authState.keys.dispose(),
				second.authState.keys.dispose(),
				a.keys.dispose(),
				b.keys.dispose()
			])
		}
	})
})
