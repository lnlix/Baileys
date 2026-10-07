import { performance } from 'node:perf_hooks'
import { pruneSignalStates } from '../src/Signal/session-retention'

for (const count of [40, 7500, 15000]) {
	const sessions = Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`state${i}`, { indexInfo: { closed: i === 0 ? -1 : i } }])
	)
	const start = performance.now()
	const removed = pruneSignalStates(sessions)
	process.stdout.write(
		JSON.stringify({ count, removed, retained: Object.keys(sessions).length, elapsedMs: performance.now() - start }) +
			'\n'
	)
}
