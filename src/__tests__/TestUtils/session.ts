import { jest } from '@jest/globals'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { useMultiFileAuthState } from '../..'
import { WebSocketClient } from '../../Socket/Client/websocket'

/**
 * Creates a temporary, isolated authentication state for tests.
 * This prevents tests from interfering with each other or with a real session.
 * @returns An object with the authentication state and a cleanup function.
 */
export const makeSession = async () => {
	// Create a temporary directory for the session files
	const dir = join(tmpdir(), `baileys-test-session-${Date.now()}`)
	await fs.mkdir(dir, { recursive: true })

	// Use the multi-file auth state with the temporary directory
	const { state, saveCreds } = await useMultiFileAuthState(dir)

	return {
		state,
		saveCreds,
		/**
		 * Cleans up the temporary session files.
		 * Call this at the end of your test.
		 */
		clear: async () => {
			await fs.rm(dir, { recursive: true, force: true })
		}
	}
}

export const mockWebSocket = () => {
	// ESM imports are already evaluated here; jest.mock cannot replace this class.
	const connect = jest.spyOn(WebSocketClient.prototype, 'connect').mockImplementation(() => undefined)
	const isOpen = jest.spyOn(WebSocketClient.prototype, 'isOpen', 'get').mockReturnValue(true)
	const send = jest.spyOn(WebSocketClient.prototype, 'send').mockImplementation((_data, callback) => {
		callback?.()
		return true
	})
	afterAll(() => {
		connect.mockRestore()
		isOpen.mockRestore()
		send.mockRestore()
	})
}
