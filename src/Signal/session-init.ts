import type { LIDMapping, SignalKeyStore, SignalRepositoryWithLIDStore } from '../Types'
import type { ILogger } from '../Utils/logger'
import { makeMutex } from '../Utils/make-mutex'
import { jidDecode } from '../WABinary'

export function makeLIDSessionRefresher(
	keys: SignalKeyStore,
	repository: SignalRepositoryWithLIDStore,
	assertSessions: (jids: string[], force?: boolean) => Promise<boolean>,
	logger: ILogger
) {
	const mutex = makeMutex()
	return (pairs: LIDMapping[]) =>
		mutex.mutex(async () => {
			const users = pairs.map(pair => jidDecode(pair.pn)?.user).filter((user): user is string => !!user)
			const previous = await keys.get('lid-mapping', users)
			const changed = new Set<string>()
			const unchanged = new Set<string>()
			for (const pair of pairs) {
				const pn = jidDecode(pair.pn)
				const lid = jidDecode(pair.lid)
				if (!pn || !lid) continue
				const target = previous[pn.user] === lid.user ? unchanged : changed
				target.add(pair.lid)
			}

			await repository.lidMapping.storeLIDPNMappings(pairs)
			logger.debug({ changed: changed.size, unchanged: unchanged.size }, 'USync session initialization reasons')
			try {
				if (changed.size) await assertSessions([...changed], true)
				if (unchanged.size) await assertSessions([...unchanged], false)
			} catch (err) {
				logger.warn({ err, count: pairs.length }, 'failed to refresh sessions for LID mappings')
			}
		})
}
