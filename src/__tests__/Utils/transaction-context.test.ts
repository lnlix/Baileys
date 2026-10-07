import { jest } from '@jest/globals'
import { makeSignalStore } from '../TestUtils/signal-store'

function gate() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe('transaction context ownership and disposal', () => {
	it('isolates concurrent accounts and restores a nested cross-owner context', async () => {
		const a = makeSignalStore(),
			b = makeSignalStore()
		a.data['lid-mapping'] = { peer: 'a' }
		b.data['lid-mapping'] = { peer: 'b' }
		try {
			await a.keys.transaction(async () => {
				await a.keys.set({ 'lid-mapping': { peer: 'a-updated' } })
				expect(b.keys.isInTransaction()).toBe(false)
				expect(await b.keys.get('lid-mapping', ['peer'])).toEqual({ peer: 'b' })
				await b.keys.transaction(async () => {
					expect(a.keys.isInTransaction()).toBe(false)
					await b.keys.set({ 'lid-mapping': { peer: 'b-updated' } })
					await b.keys.transaction(async () => {
						expect(await b.keys.get('lid-mapping', ['peer'])).toEqual({ peer: 'b-updated' })
					}, 'same')
				}, 'same')
				expect(a.keys.isInTransaction()).toBe(true)
				expect(await a.keys.get('lid-mapping', ['peer'])).toEqual({ peer: 'a-updated' })
			}, 'same')
			await Promise.all(
				[a, b].map((store, i) =>
					store.keys.transaction(async () => {
						await store.keys.set({ 'lid-mapping': { parallel: String(i) } })
						await Promise.resolve()
						expect(await store.keys.get('lid-mapping', ['parallel'])).toEqual({ parallel: String(i) })
					}, 'same')
				)
			)
			expect(a.data['lid-mapping']).toEqual({ peer: 'a-updated', parallel: '0' })
			expect(b.data['lid-mapping']).toEqual({ peer: 'b-updated', parallel: '1' })
		} finally {
			await a.keys.dispose()
			await b.keys.dispose()
		}
	})
	it('reuses same-owner context, rolls back failure, and retries commits', async () => {
		const { keys, state, data } = makeSignalStore()
		try {
			await expect(
				keys.transaction(async () => {
					await keys.set({ 'lid-mapping': { peer: 'discard' } })
					await keys.transaction(async () => {
						expect(await keys.get('lid-mapping', ['peer'])).toEqual({ peer: 'discard' })
					}, 'nested')
					throw new Error('rollback')
				}, 'peer')
			).rejects.toThrow('rollback')
			expect(state.set).not.toHaveBeenCalled()
			jest.mocked(state.set).mockImplementationOnce(async () => {
				throw new Error('transient')
			})
			await keys.transaction(async () => {
				await keys.set({ 'lid-mapping': { peer: 'commit' } })
			}, 'peer')
			expect(state.set).toHaveBeenCalledTimes(2)
			expect(data['lid-mapping']).toEqual({ peer: 'commit' })
			jest.mocked(state.set).mockImplementation(async () => {
				throw new Error('permanent')
			})
			await expect(
				keys.transaction(async () => {
					await keys.set({ 'lid-mapping': { peer: 'failed' } })
				}, 'peer')
			).rejects.toThrow('permanent')
			expect(data['lid-mapping']).toEqual({ peer: 'commit' })
		} finally {
			await keys.dispose()
		}
	})
	it('drains admitted and queued transactions, rejects new work, and leaves other owners running', async () => {
		const a = makeSignalStore(),
			b = makeSignalStore()
		const entered = gate(),
			release = gate()
		const first = a.keys.transaction(async () => {
			entered.resolve()
			await release.promise
			await a.keys.set({ 'lid-mapping': { peer: 'first' } })
		}, 'peer')
		await entered.promise
		const second = a.keys.transaction(async () => {
			await a.keys.set({ 'lid-mapping': { peer: 'second' } })
		}, 'peer')
		const disposal = a.keys.dispose()
		expect(a.keys.dispose()).toBe(disposal)
		await expect(a.keys.get('lid-mapping', ['peer'])).rejects.toThrow('disposed')
		await expect(a.keys.set({})).rejects.toThrow('disposed')
		await expect(a.keys.transaction(async () => undefined, 'other')).rejects.toThrow('disposed')
		await b.keys.transaction(async () => {
			await b.keys.set({ 'lid-mapping': { peer: 'alive' } })
		}, 'peer')
		release.resolve()
		await Promise.all([first, second, disposal])
		expect(a.data['lid-mapping']).toEqual({ peer: 'second' })
		expect(b.data['lid-mapping']).toEqual({ peer: 'alive' })
		await b.keys.dispose()
	})
	it('does not reuse a transaction inherited by detached work after completion', async () => {
		const store = makeSignalStore(),
			release = gate()
		let detached!: Promise<void>
		await store.keys.transaction(async () => {
			detached = release.promise.then(async () => {
				expect(store.keys.isInTransaction()).toBe(false)
				await store.keys.set({ 'lid-mapping': { peer: 'later' } })
			})
		}, 'peer')
		release.resolve()
		await detached
		expect(store.data['lid-mapping']).toEqual({ peer: 'later' })
		await store.keys.dispose()
	})
	it('supports repeated owner create/dispose cycles', async () => {
		for (let i = 0; i < 126; i++) {
			const store = makeSignalStore()
			await store.keys.transaction(async () => {
				await store.keys.set({ 'lid-mapping': { peer: String(i) } })
			}, 'peer')
			await store.keys.dispose()
			expect(store.keys.isInTransaction()).toBe(false)
		}
	})
})
