import type { PasskeyLinkingManager } from '../Utils/passkey-linking-manager'
import type { BinaryNode } from '../WABinary'

export const handlePasskeyNotification = async (node: BinaryNode, passkeyLinkingManager: PasskeyLinkingManager) => {
	switch (node.attrs.type) {
		case 'passkey_prologue_request':
			await passkeyLinkingManager.handlePrologueRequest(node)
			return true
		case 'crsc_continuation':
			await passkeyLinkingManager.handleContinuation(node)
			return true
		default:
			return false
	}
}
