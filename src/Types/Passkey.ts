import type { BinaryNode } from '../WABinary'

export type WebAuthnAllowedCredential = {
	id: string
	type: string
	transports?: string[]
}

export type WebAuthnPublicKeyCredentialRequestOptions = {
	challenge: string
	timeout?: number
	rpId?: string
	allowCredentials?: WebAuthnAllowedCredential[]
	userVerification?: string
	extensions?: Record<string, unknown>
}

export type WebAuthnAssertionResponseJSON = {
	id: string
	rawId: string
	type: string
	response: {
		clientDataJSON: string
		authenticatorData: string
		signature: string
		userHandle?: string | null
	}
}

export type PasskeyLinkingUpdate =
	| {
			type: 'prologue-request'
			publicKey?: WebAuthnPublicKeyCredentialRequestOptions
			rawOptions?: Uint8Array
			rawNode: BinaryNode
			forced?: boolean
	  }
	| {
			type: 'continuation'
			primaryEphemeralIdentity?: Uint8Array
			rawNode: BinaryNode
	  }
	| {
			type: 'confirmation'
			code: string
			skipHandoffUx: boolean
	  }
	| {
			type: 'debug'
			stage: string
			data?: Record<string, unknown>
	  }
	| {
			type: 'error'
			error: Error
			rawNode?: BinaryNode
	  }

export type SendPasskeyPrologueOptions = {
	credentialId: Uint8Array | Buffer | string
	webauthnAssertion: WebAuthnAssertionResponseJSON | Uint8Array | Buffer | string
	prologuePayload: Uint8Array | Buffer | string
	pairingHandoffProof?: Uint8Array | Buffer | string
}

export type SendPasskeyResponseOptions = {
	requestId?: string
	credential: WebAuthnAssertionResponseJSON
}
