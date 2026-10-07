import { jest } from '@jest/globals'
import P from 'pino'
import type { SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'

export const signalLogger = P({ level: 'silent' })

export function makeSignalStore() {
	const data: Record<string, Record<string, unknown>> = {}
	const state: SignalKeyStore = {
		get: async (type, ids) =>
			Object.fromEntries(
				ids.filter(id => data[type]?.[id] !== null && data[type]?.[id] !== undefined).map(id => [id, data[type]?.[id]])
			) as Record<string, SignalDataTypeMap[typeof type]>,
		set: jest.fn<SignalKeyStore['set']>(async updates => {
			for (const [type, values] of Object.entries(updates)) Object.assign((data[type] ??= {}), values)
		})
	}
	const keys = addTransactionCapability(state, signalLogger, { maxCommitRetries: 2, delayBetweenTriesMs: 1 })
	return { data, state, keys }
}
