import { jest } from '@jest/globals'
import { SenderKeyMessage } from '../../../Signal/Group/sender-key-message'
import { SenderKeyRecord } from '../../../Signal/Group/sender-key-record'
import { makeLibSignalRepository } from '../../../Signal/libsignal'
import { initAuthCreds } from '../../../Utils/auth-utils'
import { makeSignalStore, signalLogger } from '../../TestUtils/signal-store'

type Format = 'legacy' | 'base64' | 'mixed'
const group = '100@g.us'
const author = '200@lid'

function client(format: Format) {
	const store = makeSignalStore()
	const originalSet = jest.mocked(store.state.set).getMockImplementation()!
	let writes = 0
	const writer = jest.spyOn(store.state, 'set').mockImplementation(async updates => {
		const senderKeys = updates['sender-key']
		if (senderKeys && (format === 'legacy' || (format === 'mixed' && writes++ % 2 === 0))) {
			updates = {
				...updates,
				'sender-key': Object.fromEntries(
					Object.entries(senderKeys).map(([id, value]) => [
						id,
						value ? Buffer.from(JSON.stringify(SenderKeyRecord.deserialize(value).serialize())) : value
					])
				)
			}
		}

		await originalSet(updates)
	})
	const repository = makeLibSignalRepository({ creds: initAuthCreds(), keys: store.keys }, signalLogger)
	return { ...store, repository, writer }
}

describe('group encryption across sender-key persistence formats', () => {
	const formats: Format[] = ['legacy', 'base64', 'mixed']
	const combinations = formats.flatMap(sender =>
		formats.flatMap(receiver => ['in order', 'late'].map(order => ({ sender, receiver, order })))
	)
	it.each(combinations)(
		'$sender sender and $receiver receiver, $order messages',
		async ({ sender, receiver, order }) => {
			const alice = client(sender),
				bob = client(receiver)
			try {
				const distribution = await alice.repository.getSenderKeyDistributionMessage({ group, meId: author })
				await bob.repository.processSenderKeyDistributionMessage({
					authorJid: author,
					item: { groupId: group, axolotlSenderKeyDistributionMessage: distribution }
				})
				const messages: Uint8Array[] = []
				for (let i = 0; i < 8; i++)
					messages.push(
						(await alice.repository.encryptGroupMessage({ group, meId: author, data: Buffer.from(`message${i}`) }))
							.ciphertext
					)
				for (const i of order === 'late' ? [7, 0, 3, 1, 6, 2, 5, 4] : [0, 1, 2, 3, 4, 5, 6, 7]) {
					expect(
						Buffer.from(
							await bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[i]! })
						).toString()
					).toBe(`message${i}`)
				}

				const value = Object.values(bob.data['sender-key']!)[0] as Uint8Array
				const state = SenderKeyRecord.deserialize(value).getSenderKeyState()!
				for (const msg of messages) {
					const iteration = new SenderKeyMessage(null, null, null, null, msg).getIteration()
					expect(state.hasSenderMessageKey(iteration)).toBe(false)
				}

				await expect(
					bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[0]! })
				).rejects.toThrow('old counter')
				if (sender === 'base64') {
					const stored = Buffer.from(Object.values(alice.data['sender-key']!)[0] as Uint8Array).toString()
					expect(stored).toMatch(/"type":"Buffer","data":"/)
					expect(stored).not.toMatch(/"type":"Buffer","data":\[/)
				}
			} finally {
				for (const instance of [alice, bob]) {
					instance.writer.mockRestore()
					instance.repository.close?.()
					await instance.keys.dispose()
				}
			}
		}
	)
	it('decrypts retained old states after rotation and preserves the five-state bound', async () => {
		const bob = client('mixed')
		const senders = Array.from({ length: 6 }, () => client('base64'))
		const messages: Uint8Array[] = []
		try {
			for (const [i, alice] of senders.entries()) {
				const distribution = await alice.repository.getSenderKeyDistributionMessage({ group, meId: author })
				await bob.repository.processSenderKeyDistributionMessage({
					authorJid: author,
					item: { groupId: group, axolotlSenderKeyDistributionMessage: distribution }
				})
				messages.push(
					(await alice.repository.encryptGroupMessage({ group, meId: author, data: Buffer.from(`rotation${i}`) }))
						.ciphertext
				)
				if (i === 4)
					expect(
						Buffer.from(
							await bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[0]! })
						).toString()
					).toBe('rotation0')
			}

			const record = SenderKeyRecord.deserialize(Object.values(bob.data['sender-key']!)[0] as Uint8Array)
			expect(record.serialize()).toHaveLength(5)
			await expect(bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[0]! })).rejects.toThrow(
				'No session'
			)
			expect(
				Buffer.from(
					await bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[1]! })
				).toString()
			).toBe('rotation1')
			expect(
				Buffer.from(
					await bob.repository.decryptGroupMessage({ group, authorJid: author, msg: messages[5]! })
				).toString()
			).toBe('rotation5')
		} finally {
			for (const instance of [...senders, bob]) {
				instance.writer.mockRestore()
				instance.repository.close?.()
				await instance.keys.dispose()
			}
		}
	})
})
