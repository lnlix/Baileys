import { jest } from '@jest/globals'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import { makeLIDSessionRefresher } from '../../Signal/session-init'
import { initAuthCreds } from '../../Utils/auth-utils'
import { makeSignalStore, signalLogger } from '../TestUtils/signal-store'

describe('USync session refresh reasons', () => {
	it('forces new/changed mappings once and validates repeated mappings without force', async () => {
		const store = makeSignalStore()
		const repository = makeLibSignalRepository({ creds: initAuthCreds(), keys: store.keys }, signalLogger)
		const assertSessions = jest.fn<(jids: string[], force?: boolean) => Promise<boolean>>().mockResolvedValue(true)
		const refresh = makeLIDSessionRefresher(store.keys, repository, assertSessions, signalLogger)
		try {
			const pair = { pn: '100@s.whatsapp.net', lid: '200@lid' }
			await Promise.all([refresh([pair]), refresh([pair]), refresh([pair])])
			expect(assertSessions.mock.calls).toEqual([
				[['200@lid'], true],
				[['200@lid'], false],
				[['200@lid'], false]
			])
			await refresh([{ ...pair, lid: '300@lid' }])
			expect(assertSessions).toHaveBeenLastCalledWith(['300@lid'], true)
		} finally {
			repository.close?.()
			await store.keys.dispose()
		}
	})
	it('propagates persistence failure without initializing against an uncommitted mapping', async () => {
		const store = makeSignalStore()
		const repository = makeLibSignalRepository({ creds: initAuthCreds(), keys: store.keys }, signalLogger)
		const assertSessions = jest.fn<(jids: string[], force?: boolean) => Promise<boolean>>()
		const refresh = makeLIDSessionRefresher(store.keys, repository, assertSessions, signalLogger)
		try {
			jest.mocked(store.state.set).mockImplementation(async () => {
				throw new Error('write failed')
			})
			await expect(refresh([{ pn: '100@s.whatsapp.net', lid: '200@lid' }])).rejects.toThrow('write failed')
			expect(assertSessions).not.toHaveBeenCalled()
		} finally {
			repository.close?.()
			await store.keys.dispose()
		}
	})
})
