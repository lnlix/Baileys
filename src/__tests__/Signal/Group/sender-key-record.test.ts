import { SenderKeyRecord, type SenderKeyStateStructure } from '../../../Signal/Group/sender-key-record'
import { SenderMessageKey } from '../../../Signal/Group/sender-message-key'
import { BufferJSON } from '../../../Utils/generics'

const state = (id: number, skipped = 2): SenderKeyStateStructure => ({
	senderKeyId: id,
	senderChainKey: { iteration: skipped, seed: Buffer.alloc(32, id) },
	senderSigningKey: { public: Buffer.alloc(33, id + 1), private: Buffer.alloc(32, id + 2) },
	senderMessageKeys: Array.from({ length: skipped }, (_, iteration) => ({
		iteration,
		seed: Buffer.alloc(32, iteration % 256)
	}))
})
const reload = (json: string) => SenderKeyRecord.deserialize(Buffer.from(json))

describe('sender-key Buffer compatibility', () => {
	it.each(['legacy', 'base64', 'mixed', 'uint8'] as const)('preserves every stored binary field: %s', format => {
		const expected = [state(1), state(2)]
		let json: string
		if (format === 'legacy') json = JSON.stringify(expected)
		else if (format === 'base64') json = JSON.stringify(expected, BufferJSON.replacer)
		else if (format === 'mixed')
			json = `[${JSON.stringify(expected[0])},${JSON.stringify(expected[1], BufferJSON.replacer)}]`
		else
			json = JSON.stringify(expected, (_key, value: unknown) => {
				if (
					value !== null &&
					typeof value === 'object' &&
					'type' in value &&
					value.type === 'Buffer' &&
					'data' in value &&
					Array.isArray(value.data)
				)
					return new Uint8Array(value.data)
				return value
			})
		const record = reload(json)
		expect(record.serialize()).toEqual(expected)
		for (const structure of record.serialize()) {
			expect(Buffer.isBuffer(structure.senderChainKey.seed)).toBe(true)
			expect(Buffer.isBuffer(structure.senderSigningKey.public)).toBe(true)
			expect(Buffer.isBuffer(structure.senderSigningKey.private)).toBe(true)
			for (const key of structure.senderMessageKeys) expect(Buffer.isBuffer(key.seed)).toBe(true)
		}

		expect(record.getSenderKeyState(1)?.removeSenderMessageKey(0)?.getSeed()).toEqual(Buffer.alloc(32))
	})
	it('preserves all five states and 2000 skipped keys through mixed reload and rotation', () => {
		const expected = Array.from({ length: 5 }, (_, i) => state(i + 1, 2000))
		const record = reload(
			`[${expected.map((entry, i) => JSON.stringify(entry, i % 2 ? BufferJSON.replacer : undefined)).join(',')}]`
		)
		expect(record.serialize()).toEqual(expected)
		const retained = record.getSenderKeyState(5)!
		expect(retained.removeSenderMessageKey(0)?.getSeed()).toEqual(Buffer.alloc(32))
		expect(retained.removeSenderMessageKey(1999)?.getSeed()).toEqual(Buffer.alloc(32, 1999 % 256))
		record.addSenderKeyState(6, 0, Buffer.alloc(32), Buffer.alloc(33))
		const rotated = reload(JSON.stringify(record.serialize(), BufferJSON.replacer))
		expect(rotated.serialize()).toHaveLength(5)
		expect(rotated.getSenderKeyState(1)).toBeUndefined()
		expect(rotated.getSenderKeyState()?.getKeyId()).toBe(6)
		expect(rotated.getSenderKeyState(5)?.getStructure().senderMessageKeys).toHaveLength(1998)
	})
	it.each([-1, 256, 1.5, null, '1'])('rejects corrupt legacy byte arrays: %s', byte => {
		const json = JSON.stringify([
			{ ...state(1), senderChainKey: { iteration: 0, seed: { type: 'Buffer', data: [byte] } } }
		])
		expect(() => reload(json)).toThrow('Invalid sender-key Buffer byte array')
	})
	it('reads empty records and absent private signing keys', () => {
		expect(reload('[]').isEmpty()).toBe(true)
		const structure = state(1)
		delete structure.senderSigningKey.private
		expect(reload(JSON.stringify([structure])).serialize()).toEqual([structure])
	})
	it('retains the 2000-key window when a reloaded state receives another skipped key', () => {
		const record = reload(JSON.stringify([state(1, 2000)]))
		const sender = record.getSenderKeyState()!
		sender.addSenderMessageKey(new SenderMessageKey(2000, Buffer.alloc(32, 123)))
		const restored = reload(JSON.stringify(record.serialize(), BufferJSON.replacer)).getSenderKeyState()!
		expect(restored.getStructure().senderMessageKeys).toHaveLength(2000)
		expect(restored.removeSenderMessageKey(0)).toBeNull()
		expect(restored.removeSenderMessageKey(1)?.getSeed()).toEqual(Buffer.alloc(32, 1))
		expect(restored.removeSenderMessageKey(2000)?.getSeed()).toEqual(Buffer.alloc(32, 123))
	})
})
