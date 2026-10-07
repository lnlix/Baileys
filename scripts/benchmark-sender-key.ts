import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { SenderKeyRecord, type SenderKeyStateStructure } from '../src/Signal/Group/sender-key-record'
import { BufferJSON } from '../src/Utils/generics'

if (!globalThis.gc) throw new Error('Run with node --expose-gc --import tsx scripts/benchmark-sender-key.ts')
const fixture: SenderKeyStateStructure[] = Array.from({ length: 5 }, (_, senderKeyId) => ({
	senderKeyId,
	senderChainKey: { iteration: 2000, seed: randomBytes(32) },
	senderSigningKey: { public: randomBytes(33), private: randomBytes(32) },
	senderMessageKeys: Array.from({ length: 2000 }, (_, iteration) => ({ iteration, seed: randomBytes(32) }))
}))
const expected = JSON.stringify(fixture, BufferJSON.replacer)

for (const format of ['legacy', 'base64'] as const) {
	const input = Buffer.from(JSON.stringify(fixture, format === 'base64' ? BufferJSON.replacer : undefined))
	if (JSON.stringify(SenderKeyRecord.deserialize(input).serialize(), BufferJSON.replacer) !== expected)
		throw new Error('Fixture round trip failed')
	const times: number[] = []
	const startCPU = process.cpuUsage()
	for (let i = 0; i < 15; i++) {
		const start = performance.now()
		SenderKeyRecord.deserialize(input)
		times.push(performance.now() - start)
	}
	const cpu = process.cpuUsage(startCPU)
	globalThis.gc()
	const before = process.memoryUsage()
	const retained = Array.from({ length: 20 }, () => SenderKeyRecord.deserialize(input))
	globalThis.gc()
	const after = process.memoryUsage()
	process.stdout.write(
		JSON.stringify({
			format,
			serializedBytes: input.length,
			medianMs: times.sort((a, b) => a - b)[7],
			cpuMsFor15Reads: (cpu.user + cpu.system) / 1000,
			heapBytesPerRecord: (after.heapUsed - before.heapUsed) / retained.length,
			externalBytesPerRecord: (after.external - before.external) / retained.length
		}) + '\n'
	)
	retained.length = 0
	globalThis.gc()
}
