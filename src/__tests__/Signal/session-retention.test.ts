import { boundedSessionRecord, pruneSignalStates } from '../../Signal/session-retention'

const entry = (closed: number) => ({ indexInfo: { closed }, extra: 'preserved' })

describe('signal state retention', () => {
	it('retains every open state and the newest closed states with deterministic ties', () => {
		const sessions = { first: entry(0), second: entry(0), newer: entry(10), open: entry(-1) }
		expect(pruneSignalStates(sessions, 3)).toBe(1)
		expect(Object.keys(sessions)).toEqual(['second', 'newer', 'open'])
	})
	it('bounds a legacy copy without mutating shared input or losing metadata', () => {
		const record = {
			registrationId: 123,
			extra: 'preserved',
			_sessions: Object.fromEntries(Array.from({ length: 7500 }, (_, i) => [`state${i}`, entry(i === 0 ? -1 : i)]))
		}
		const copy = boundedSessionRecord(record)
		expect(Object.keys(copy._sessions)).toEqual(['state0', ...Array.from({ length: 39 }, (_, i) => `state${7461 + i}`)])
		expect(copy.extra).toBe(record.extra)
		expect(copy.registrationId).toBe(123)
		expect(Object.keys(record._sessions)).toHaveLength(7500)
		expect(copy._sessions.state0).toEqual(record._sessions.state0)
		expect(copy._sessions.state0).not.toBe(record._sessions.state0)
	})
	it.each([NaN, Infinity, undefined, '1', null])('rejects malformed timestamps atomically: %s', closed => {
		const sessions = { oldest: entry(0), bad: { indexInfo: { closed } }, open: entry(-1) }
		expect(() => pruneSignalStates(sessions, 1)).toThrow()
		expect(Object.keys(sessions)).toHaveLength(3)
	})
	it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid limits: %s', limit => {
		expect(() => pruneSignalStates({}, limit)).toThrow()
	})
	it.each([null, [], { bad: null }, { bad: {} }])('rejects malformed structures', sessions => {
		expect(() => pruneSignalStates(sessions)).toThrow()
	})
	it('rejects excess open states before deleting closed states', () => {
		const sessions = { old: entry(0), a: entry(-1), b: entry(-1) }
		expect(() => pruneSignalStates(sessions, 1)).toThrow('too many open states')
		expect(Object.keys(sessions)).toHaveLength(3)
	})
	it('accepts finite legacy timestamps and leaves bounded records intact', () => {
		const sessions = { epoch: entry(0), fractional: entry(1.5), negative: entry(-2) }
		expect(pruneSignalStates(sessions)).toBe(0)
		expect(pruneSignalStates(sessions, 2)).toBe(1)
		expect(Object.keys(sessions)).toEqual(['epoch', 'fractional'])
	})
})
