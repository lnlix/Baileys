import { Boom } from '@hapi/boom'
import { createHash, createHmac, randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type {
	AuthenticationState,
	BaileysEventEmitter,
	SendPasskeyPrologueOptions,
	SendPasskeyResponseOptions,
	WABrowserDescription
} from '../Types'
import {
	aesEncryptGCM,
	Curve,
	hkdf
} from './crypto'
import { getCompanionPlatformId } from './companion-reg-client-utils'
import { bytesToCrockford } from './generics'
import type { ILogger } from './logger'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	S_WHATSAPP_NET
} from '../WABinary'

type PasskeyRuntimeCache = {
	keyPair: ReturnType<typeof Curve.generateKeyPair>
	companionNonce: Buffer
	pairingRef: string
	deviceType: number
	encryptionKey?: Buffer
}

type PasskeyHandoffKey = {
	hmac: Buffer
	createdAt: number
}

type PasskeyLinkingManagerConfig = {
	authState: AuthenticationState
	query: (node: BinaryNode, timeoutMs?: number) => Promise<any>
	ev: BaileysEventEmitter
	logger: ILogger
	browser: WABrowserDescription
	generateMessageTag: () => string
}

export class PasskeyLinkingManager {
	private linkingCache?: PasskeyRuntimeCache
	private handoffKey?: PasskeyHandoffKey
	private skipHandoffUx = false
	private linkingInProgress = false

	constructor(private readonly config: PasskeyLinkingManagerConfig) {}

	get isLinkingInProgress() {
		return this.linkingInProgress
	}

	clearLinkingInProgress() {
		this.linkingInProgress = false
	}

	requestPasskeyRequestOptions = async () => {
		const { publicKey } = await this.requestPasskeyRequestOptionsNode()
		return publicKey
	}

	requestForcedPasskeyLogin = async () => {
		const { authState, ev } = this.config
		if (authState.creds.me) {
			return
		}

		try {
			this.prepareHandoff()
			this.linkingInProgress = true

			const { publicKey, rawOptions, rawNode } = await this.requestPasskeyRequestOptionsNode()
			ev.emit('passkey.update', {
				type: 'prologue-request',
				publicKey,
				rawOptions,
				rawNode,
				forced: true
			})
			return { publicKey, rawOptions, rawNode, forced: true, emitted: true }
		} catch (error: any) {
			this.linkingInProgress = false
			ev.emit('passkey.update', {
				type: 'error',
				error
			})
			return undefined
		}
	}

	handlePrologueRequest = async (node: BinaryNode) => {
		const { ev } = this.config
		try {
			const rawOptions = getBinaryNodeChildBuffer(node, 'passkey_request_options')
			this.prepareHandoff()
			this.linkingInProgress = true
			ev.emit('passkey.update', {
				type: 'prologue-request',
				publicKey: rawOptions ? JSON.parse(Buffer.from(rawOptions).toString('utf-8')) : undefined,
				rawOptions,
				rawNode: node
			})
		} catch (error) {
			ev.emit('passkey.update', {
				type: 'error',
				error: error instanceof Error ? error : new Error(`${error}`),
				rawNode: node
			})
		}
	}

	handleContinuation = async (node: BinaryNode) => {
		const { ev } = this.config
		try {
			const primaryEphemeralIdentityBuffer = toRequiredBuffer(
				getBinaryNodeChildBuffer(node, 'primary_ephemeral_identity')
			)
			ev.emit('passkey.update', {
				type: 'debug',
				stage: 'passkey-continuation-received',
				data: {
					primaryEphemeralIdentityLength: primaryEphemeralIdentityBuffer.length,
					nodeAttrs: node.attrs
				}
			})
			const primaryEphemeralIdentity = proto.PrimaryEphemeralIdentity.decode(primaryEphemeralIdentityBuffer)
			if (primaryEphemeralIdentity.publicKey?.length !== 32) {
				throw new Boom('Invalid primary ephemeral public key in passkey continuation')
			}

			if (primaryEphemeralIdentity.nonce?.length !== 32) {
				throw new Boom('Invalid primary nonce in passkey continuation')
			}

			const cache = this.linkingCache
			if (!cache) {
				throw new Boom('Received passkey continuation without a linking cache')
			}

			const primaryPublicKey = Buffer.from(primaryEphemeralIdentity.publicKey)
			const primaryNonce = Buffer.from(primaryEphemeralIdentity.nonce)
			const companionSharedKey = Curve.sharedKey(cache.keyPair.private, primaryPublicKey)

			await this.sendPasskeyCompanionNonce(cache.companionNonce)
			ev.emit('passkey.update', {
				type: 'debug',
				stage: 'passkey-companion-nonce-sent',
				data: {
					companionNonceLength: cache.companionNonce.length,
					deviceType: cache.deviceType,
					pairingRefLength: cache.pairingRef.length
				}
			})

			cache.encryptionKey = Buffer.from(
				hkdf(companionSharedKey, 32, {
					salt: Buffer.from(`Companion Pairing ${cache.deviceType} with ref ${cache.pairingRef}`),
					info: 'Pairing Information Encryption Key'
				})
			)
			const digest = createHash('sha256')
				.update(Buffer.concat([cache.companionNonce, primaryPublicKey]))
				.digest()
			const codeBytes = Buffer.alloc(5)
			for (let i = 0; i < codeBytes.length; i++) {
				codeBytes[i] = primaryNonce[i]! ^ digest[i]!
			}

			const encodedCode = bytesToCrockford(codeBytes)
			ev.emit('passkey.update', {
				type: 'confirmation',
				code: `${encodedCode.slice(0, 4)}-${encodedCode.slice(4)}`,
				skipHandoffUx: this.skipHandoffUx
			})
		} catch (error) {
			ev.emit('passkey.update', {
				type: 'error',
				error: error instanceof Error ? error : new Error(`${error}`),
				rawNode: node
			})
		}
	}

	sendPasskeyResponse = async ({ credential }: SendPasskeyResponseOptions) => {
		const { browser, ev } = this.config
		const companionRef = await this.getCompanionRef()
		const companionEphemeralKeyPair = Curve.generateKeyPair()
		const companionNonce = randomBytes(32)
		const deviceType = Number(getCompanionPlatformId(browser)) || proto.DeviceProps.PlatformType.CHROME
		const companionEphemeralIdentity = proto.CompanionEphemeralIdentity.encode({
			publicKey: companionEphemeralKeyPair.public,
			deviceType,
			ref: companionRef
		}).finish()
		const commitment = createHash('sha256')
			.update(Buffer.concat([Buffer.from(companionEphemeralIdentity), companionNonce]))
			.digest()
		const prologuePayload = proto.ProloguePayload.encode({
			companionEphemeralIdentity,
			commitment: { hash: commitment }
		}).finish()

		const marshaledAssertion = Buffer.from(JSON.stringify(credential), 'utf-8')
		const credentialId = base64UrlToBuffer(credential.rawId || credential.id)
		const handoffKey = this.handoffKey
		const hasValidHandoffKey = !!handoffKey && Date.now() - handoffKey.createdAt < 5 * 60 * 1000
		const pairingHandoffProof = hasValidHandoffKey
			? createHmac('sha256', handoffKey.hmac).update(Buffer.from(prologuePayload)).digest()
			: undefined
		ev.emit('passkey.update', {
			type: 'debug',
			stage: 'passkey-prologue-build',
			data: {
				credentialIdLength: credentialId.length,
				assertionLength: marshaledAssertion.length,
				prologuePayloadLength: prologuePayload.length,
				companionIdentityLength: companionEphemeralIdentity.length,
				companionNonceLength: companionNonce.length,
				deviceType,
				companionRefLength: companionRef.length,
				hasAuthenticatorData: !!credential.response?.authenticatorData,
				hasClientDataJSON: !!credential.response?.clientDataJSON,
				hasSignature: !!credential.response?.signature,
				hasUserHandle: credential.response?.userHandle !== undefined && credential.response?.userHandle !== null,
				hasPasskeyHandoffKey: !!handoffKey,
				hasValidPasskeyHandoffKey: hasValidHandoffKey,
				hasPairingHandoffProof: !!pairingHandoffProof
			}
		})

		this.linkingCache = {
			keyPair: companionEphemeralKeyPair,
			companionNonce,
			pairingRef: companionRef,
			deviceType
		}
		this.skipHandoffUx = !!pairingHandoffProof

		await this.sendPasskeyPrologue({
			credentialId,
			webauthnAssertion: marshaledAssertion,
			prologuePayload,
			pairingHandoffProof
		})
		this.handoffKey = undefined

		return {
			status: 'prologue_sent',
			requestId: undefined,
			credentialId: credential.id
		}
	}

	sendPasskeyConfirmation = async () => {
		const { authState } = this.config
		const cache = this.linkingCache
		if (!cache) {
			throw new Boom('No passkey linking cache available')
		}

		if (!cache.encryptionKey) {
			throw new Boom('Passkey linking cache does not have an encryption key yet')
		}

		const pairingRequest = proto.PairingRequest.encode({
			companionPublicKey: authState.creds.noiseKey.public,
			companionIdentityKey: authState.creds.signedIdentityKey.public,
			advSecret: Buffer.from(authState.creds.advSecretKey, 'base64')
		}).finish()
		const iv = randomBytes(12)
		const encryptedPayload = aesEncryptGCM(pairingRequest, cache.encryptionKey, iv, Buffer.alloc(0))
		const encryptedPairingRequest = proto.EncryptedPairingRequest.encode({
			encryptedPayload,
			iv
		}).finish()

		await this.sendPasskeyEncryptedPairingRequest(encryptedPairingRequest)
		this.linkingCache = undefined
		this.linkingInProgress = false

		return { status: 'pairing_request_sent' }
	}

	sendPasskeyPrologue = async ({
		credentialId,
		webauthnAssertion,
		prologuePayload,
		pairingHandoffProof
	}: SendPasskeyPrologueOptions) => {
		const { ev, query } = this.config
		const content: BinaryNode[] = [
			{ tag: 'credential_id', attrs: {}, content: toPasskeyBuffer(credentialId) },
			{ tag: 'webauthn_assertion', attrs: {}, content: toPasskeyBuffer(webauthnAssertion) },
			{ tag: 'prologue_payload', attrs: {}, content: toPasskeyBuffer(prologuePayload) }
		]

		if (pairingHandoffProof) {
			content.push({ tag: 'pairing_handoff_proof', attrs: {}, content: toPasskeyBuffer(pairingHandoffProof) })
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'md'
			},
			content: [{ tag: 'passkey_prologue', attrs: {}, content }]
		})
		ev.emit('passkey.update', {
			type: 'debug',
			stage: 'passkey-prologue-ack',
			data: {
				resultTag: result.tag,
				resultType: result.attrs?.type,
				childTags: Array.isArray(result.content)
					? result.content.map((child: unknown) =>
							typeof child === 'object' && child !== null && 'tag' in child
								? (child as { tag: string }).tag
								: typeof child
						)
					: typeof result.content
			}
		})
	}

	sendPasskeyCompanionNonce = async (nonce: Uint8Array | Buffer | string) => {
		await this.config.query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'md'
			},
			content: [{ tag: 'companion_nonce', attrs: {}, content: toPasskeyBuffer(nonce) }]
		})
	}

	sendPasskeyEncryptedPairingRequest = async (encryptedPairingRequest: Uint8Array | Buffer | string) => {
		await this.config.query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'md'
			},
			content: [{ tag: 'encrypted_pairing_request', attrs: {}, content: toPasskeyBuffer(encryptedPairingRequest) }]
		})
	}

	private requestPasskeyRequestOptionsNode = async () => {
		const result = await this.config.query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'md'
			},
			content: [{ tag: 'passkey_request_options', attrs: {} }]
		})
		const optionsNode = getBinaryNodeChild(result, 'passkey_request_options')
		const rawOptions = optionsNode?.content
		if (!Buffer.isBuffer(rawOptions)) {
			throw new Boom('Passkey request options response did not contain binary options', { data: result })
		}

		return {
			publicKey: JSON.parse(rawOptions.toString('utf-8')),
			rawOptions,
			rawNode: result
		}
	}

	private prepareHandoff() {
		const { authState } = this.config
		this.handoffKey = {
			hmac: Buffer.from(
				hkdf(Buffer.from(authState.creds.advSecretKey, 'base64'), 32, {
					info: 'shortcake-passkey-handoff-v1'
				})
			),
			createdAt: Date.now()
		}
		authState.creds.advSecretKey = randomBytes(32).toString('base64')
	}

	private getCompanionRef = async () => {
		const result = await this.config.query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'md'
			},
			content: [{ tag: 'ref', attrs: {} }]
		})
		const ref = getBinaryNodeChild(result, 'ref')
		if (!ref || !Buffer.isBuffer(ref.content)) {
			throw new Boom('Companion ref response did not contain a binary ref', { data: result })
		}

		return ref.content.toString('utf-8')
	}
}

function toPasskeyBuffer(value: Uint8Array | Buffer | string | object) {
	if (Buffer.isBuffer(value)) {
		return value
	}

	if (value instanceof Uint8Array) {
		return Buffer.from(value)
	}

	if (typeof value === 'string') {
		return Buffer.from(value, 'utf-8')
	}

	return Buffer.from(JSON.stringify(value), 'utf-8')
}

function base64UrlToBuffer(value: string) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	return Buffer.from(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='), 'base64')
}

function toRequiredBuffer(data: Uint8Array | Buffer | undefined) {
	if (data === undefined) {
		throw new Boom('Invalid buffer', { statusCode: 400 })
	}

	return data instanceof Buffer ? data : Buffer.from(data)
}
