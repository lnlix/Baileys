import type { SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import { isLidUser } from '../WABinary'

/** 7 days in seconds — matches WA Web AB prop tctoken_duration */
const TC_TOKEN_BUCKET_DURATION = 604800
/** 4 buckets → ~28-day rolling window — matches WA Web AB prop tctoken_num_buckets */
const TC_TOKEN_NUM_BUCKETS = 4

/**
 * Check if a received token is expired using WA Web's rolling bucket algorithm.
 * Reference: WAWebTrustedContactsUtils.isTokenExpired
 *
 * Uses Receiver mode constants (tctoken_duration, tctoken_num_buckets).
 * NOTE: WA Web distinguishes Sender vs Receiver mode via AB props
 * (tctoken_duration_sender / tctoken_num_buckets_sender). Currently both
 * use identical values (604800 / 4), so we use a single function for both.
 * If WA ever diverges these, add a `mode` parameter here.
 */
export function isTcTokenExpired(timestamp: number | string | undefined): boolean {
	if (timestamp === null || timestamp === undefined) return true
	const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp
	if (isNaN(ts)) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
	const cutoffTimestamp = cutoffBucket * TC_TOKEN_BUCKET_DURATION
	return ts < cutoffTimestamp
}

/**
 * Check if we should issue a new token to this contact (bucket boundary crossed).
 * Reference: WAWebTrustedContactsUtils.shouldSendNewToken
 *
 * Returns true if senderTimestamp is null/undefined or in a previous bucket.
 */
export function shouldSendNewTcToken(senderTimestamp: number | undefined): boolean {
	if (senderTimestamp === undefined) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
	return currentBucket > senderBucket
}

/**
 * Resolve a JID to its LID for tctoken storage, mirroring how Signal sessions
 * use LID keys via resolveLIDSignalAddress.
 *
 * WA Web always resolves to LID before storing/looking up tctokens:
 * `senderLid ?? toLid(from)` (WAWebSetTcTokenChatAction.handleIncomingTcToken)
 *
 * @param jid - The JID to resolve (can be PN or LID)
 * @param getLIDForPN - Resolver function (from lidMapping)
 * @returns The LID if mapping exists, otherwise the original JID
 */
export async function resolveTcTokenJid(
	jid: string,
	getLIDForPN: (pn: string) => Promise<string | null>
): Promise<string> {
	if (isLidUser(jid)) return jid
	const lid = await getLIDForPN(jid)
	return lid ?? jid
}

type TcTokenParams = {
	jid: string
	baseContent?: BinaryNode[]
	authState: {
		keys: SignalKeyStoreWithTransaction
	}
	getLIDForPN?: (pn: string) => Promise<string | null>
}

export async function buildTcTokenFromJid({
	authState,
	jid,
	baseContent = [],
	getLIDForPN
}: TcTokenParams): Promise<BinaryNode[] | undefined> {
	try {
		const storageJid = getLIDForPN ? await resolveTcTokenJid(jid, getLIDForPN) : jid
		const tcTokenData = await authState.keys.get('tctoken', [storageJid])
		const entry = tcTokenData?.[storageJid]
		const tcTokenBuffer = entry?.token

		if (!tcTokenBuffer?.length || isTcTokenExpired(entry?.timestamp)) {
			// Opportunistic cleanup: remove expired token from store
			if (tcTokenBuffer) {
				await authState.keys.set({ tctoken: { [storageJid]: null } })
			}

			return baseContent.length > 0 ? baseContent : undefined
		}

		baseContent.push({
			tag: 'tctoken',
			attrs: {},
			content: tcTokenBuffer
		})

		return baseContent
	} catch (error) {
		return baseContent.length > 0 ? baseContent : undefined
	}
}
