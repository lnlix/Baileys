import { jest } from '@jest/globals'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import { initAuthCreds } from '../../Utils/auth-utils'
import { Curve, generateSignalPubKey } from '../../Utils/crypto'
import { makeSignalStore, signalLogger } from '../TestUtils/signal-store'

type Serialized = { version: string; _sessions: Record<string, { indexInfo: { closed: number } }> }
const peer = '200@lid'
const local = '100@lid'

function client() {
	const store = makeSignalStore()
	const creds = initAuthCreds()
	const repository = makeLibSignalRepository({ creds, keys: store.keys }, signalLogger)
	const bundle = {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: {
			keyId: creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
			signature: creds.signedPreKey.signature
		}
	}
	return { ...store, repository, bundle }
}

describe('Signal persistence through the real session builder', () => {
	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		jest.restoreAllMocks()
	})
	it('preserves prekey consumption and allows identity and registration replacement', async () => {
		const alice = client(),
			bob = client(),
			replacement = client()
		try {
			const preKey = Curve.generateKeyPair()
			await bob.keys.set({ 'pre-key': { '7': preKey } })
			await alice.repository.injectE2ESession({
				jid: peer,
				session: { ...bob.bundle, preKey: { keyId: 7, publicKey: generateSignalPubKey(preKey.public) } }
			})
			const message = await alice.repository.encryptMessage({ jid: peer, data: Buffer.from('prekey') })
			expect(Buffer.from(await bob.repository.decryptMessage({ jid: local, ...message })).toString()).toBe('prekey')
			expect(bob.data['pre-key']?.['7']).toBeNull()
			await alice.repository.injectE2ESession({ jid: peer, session: replacement.bundle })
			expect((await alice.repository.getSessionInfo(peer))?.registrationId).toBe(replacement.bundle.registrationId)
			const renewed = await alice.repository.encryptMessage({ jid: peer, data: Buffer.from('renewed') })
			expect(Buffer.from(await replacement.repository.decryptMessage({ jid: local, ...renewed })).toString()).toBe(
				'renewed'
			)
		} finally {
			for (const instance of [alice, bob, replacement]) {
				instance.repository.close?.()
				await instance.keys.dispose()
			}
		}
	})
	it('rejects a corrupt cached record without replacing it', async () => {
		const alice = client(),
			bob = client()
		try {
			const address = alice.repository.jidToSignalProtocolAddress(peer)
			const corrupt = { version: 'v1', _sessions: { bad: { indexInfo: { closed: 'invalid' } } } }
			alice.data.session = { [address]: corrupt }
			await expect(alice.repository.injectE2ESession({ jid: peer, session: bob.bundle })).rejects.toThrow(
				'close timestamp'
			)
			expect(alice.data.session[address]).toBe(corrupt)
			expect(alice.state.set).not.toHaveBeenCalled()
		} finally {
			alice.repository.close?.()
			bob.repository.close?.()
			await alice.keys.dispose()
			await bob.keys.dispose()
		}
	})
	it('bounds repeated retry injection without encryption, including concurrent calls', async () => {
		const alice = client(),
			bob = client()
		try {
			for (let i = 0; i < 45; i++) {
				await alice.repository.injectE2ESession({ jid: peer, session: bob.bundle })
				const record = alice.data.session?.[alice.repository.jidToSignalProtocolAddress(peer)] as Serialized
				expect(Object.keys(record._sessions).length).toBe(Math.min(i + 1, 40))
			}

			await Promise.all(
				Array.from({ length: 5 }, () => alice.repository.injectE2ESession({ jid: peer, session: bob.bundle }))
			)
			const record = alice.data.session?.[alice.repository.jidToSignalProtocolAddress(peer)] as Serialized
			expect(Object.keys(record._sessions)).toHaveLength(40)
			expect(Object.values(record._sessions).filter(state => state.indexInfo.closed === -1)).toHaveLength(1)
		} finally {
			alice.repository.close?.()
			bob.repository.close?.()
			await alice.keys.dispose()
			await bob.keys.dispose()
		}
	})
	it('repairs 7500 states on an ordinary save and retains late messages in the window', async () => {
		const alice = client(),
			bob = client()
		try {
			await alice.repository.injectE2ESession({ jid: peer, session: bob.bundle })
			const first = await alice.repository.encryptMessage({ jid: peer, data: Buffer.from('first') })
			expect(Buffer.from(await bob.repository.decryptMessage({ jid: local, ...first })).toString()).toBe('first')
			const late = await bob.repository.encryptMessage({ jid: local, data: Buffer.from('late') })
			const address = alice.repository.jidToSignalProtocolAddress(peer)
			const original = alice.data.session?.[address] as Serialized
			const open = Object.entries(original._sessions).find(([, state]) => state.indexInfo.closed === -1)!
			const oversized = {
				...original,
				_sessions: {
					...Object.fromEntries(
						Array.from({ length: 7499 }, (_, i) => [
							`old${i}`,
							{ ...open[1], indexInfo: { ...open[1].indexInfo, closed: i } }
						])
					),
					[open[0]]: open[1]
				}
			}
			alice.data.session![address] = oversized
			alice.data.session!.unrelated = original
			await alice.repository.encryptMessage({ jid: peer, data: Buffer.from('next') })
			const repaired = alice.data.session![address] as Serialized
			expect(Object.keys(repaired._sessions)).toHaveLength(40)
			expect(repaired._sessions[open[0]]?.indexInfo.closed).toBe(-1)
			expect(Object.keys(repaired._sessions)).toEqual([
				...Array.from({ length: 39 }, (_, i) => `old${7460 + i}`),
				open[0]
			])
			expect(Object.keys(oversized._sessions)).toHaveLength(7500)
			expect(alice.data.session!.unrelated).toBe(original)
			await alice.repository.injectE2ESession({ jid: peer, session: bob.bundle })
			expect(Buffer.from(await alice.repository.decryptMessage({ jid: peer, ...late })).toString()).toBe('late')
		} finally {
			alice.repository.close?.()
			bob.repository.close?.()
			await alice.keys.dispose()
			await bob.keys.dispose()
		}
	})
	it('bounds migration copies and propagates failed persistence', async () => {
		const alice = client(),
			bob = client()
		try {
			const pn = '200@s.whatsapp.net'
			await alice.repository.injectE2ESession({ jid: pn, session: bob.bundle })
			const address = alice.repository.jidToSignalProtocolAddress(pn)
			const record = alice.data.session![address] as Serialized
			const open = Object.values(record._sessions)[0]!
			const oversized = {
				...record,
				extra: 'keep',
				_sessions: {
					...Object.fromEntries(
						Array.from({ length: 7499 }, (_, i) => [
							`old${i}`,
							{ ...open, indexInfo: { ...open.indexInfo, closed: i } }
						])
					),
					...record._sessions
				}
			}
			alice.data.session![address] = oversized
			alice.data['device-list'] = { '200': ['0'] }
			const fail = async () => {
				throw new Error('migration write failed')
			}

			jest.mocked(alice.state.set).mockImplementationOnce(fail).mockImplementationOnce(fail)
			await expect(alice.repository.migrateSession(pn, peer)).rejects.toThrow('migration write failed')
			expect(alice.data.session![address]).toBe(oversized)
			expect(alice.data.session![alice.repository.jidToSignalProtocolAddress(peer)]).toBeUndefined()
			await alice.repository.migrateSession(pn, peer)
			const migrated = alice.data.session![alice.repository.jidToSignalProtocolAddress(peer)] as Serialized & {
				extra: string
			}
			expect(Object.keys(migrated._sessions)).toHaveLength(40)
			expect(migrated.extra).toBe('keep')
			expect(Object.keys(oversized._sessions)).toHaveLength(7500)
			jest.mocked(alice.state.set).mockImplementation(async () => {
				throw new Error('durable write failed')
			})
			await expect(alice.repository.injectE2ESession({ jid: peer, session: bob.bundle })).rejects.toThrow(
				'durable write failed'
			)
			expect(alice.data.session![alice.repository.jidToSignalProtocolAddress(peer)]).toBe(migrated)
		} finally {
			alice.repository.close?.()
			bob.repository.close?.()
			await alice.keys.dispose()
			await bob.keys.dispose()
		}
	})
})
