// libsignal 6.x counts both open and closed states toward this limit.
export const MAX_SIGNAL_STATES = 40

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the whole record before removing anything, preserving enumeration order for ties. */
export function pruneSignalStates(sessions: unknown, limit = MAX_SIGNAL_STATES): number {
	if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid signal state limit')
	if (!isObject(sessions)) throw new Error('Invalid signal sessions object')
	const keys = Object.keys(sessions)
	const candidates: Array<{ key: string; closedAt: number; order: number }> = []
	for (const [order, key] of keys.entries()) {
		const state = sessions[key]
		const index = isObject(state) ? state.indexInfo : undefined
		const closed = isObject(index) ? index.closed : undefined
		if (typeof closed !== 'number' || !Number.isFinite(closed)) {
			throw new Error('Invalid signal state close timestamp')
		}

		if (closed !== -1) candidates.push({ key, closedAt: closed, order })
	}

	if (keys.length - candidates.length > limit) throw new Error('Signal record has too many open states')
	const excess = Math.max(0, keys.length - limit)
	if (!excess) return 0
	candidates.sort((a, b) => a.closedAt - b.closedAt || a.order - b.order)
	for (const candidate of candidates.slice(0, excess)) delete sessions[candidate.key]
	return excess
}

/** Deserialization can migrate legacy entries in place, so never pass it shared cached objects. */
export function boundedSessionRecord<T>(record: T): T {
	if (!isObject(record) || !isObject(record._sessions)) throw new Error('Invalid serialized signal record')
	const sessions = { ...record._sessions }
	pruneSignalStates(sessions)
	return {
		...record,
		_sessions: Object.fromEntries(Object.entries(sessions).map(([key, value]) => [key, { ...(value as object) }]))
	}
}
