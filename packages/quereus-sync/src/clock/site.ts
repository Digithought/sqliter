/**
 * Site ID management - unique identifier for each replica.
 *
 * Site IDs are 16-byte UUIDs that uniquely identify a replica in the
 * distributed system. They are used for:
 * - Breaking ties in HLC comparison
 * - Tracking which changes came from which replica
 * - Peer-to-peer sync state tracking
 */

/**
 * 16-byte unique identifier for a replica.
 */
export type SiteId = Uint8Array;

/**
 * Generate a new random site ID (UUID v4).
 */
export function generateSiteId(): SiteId {
  const id = new Uint8Array(16);

  // Use crypto.getRandomValues if available (browser and Node 19+)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(id);
  } else {
    // Fallback for older Node.js
    for (let i = 0; i < 16; i++) {
      id[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set version to 4 (random UUID)
  id[6] = (id[6] & 0x0f) | 0x40;
  // Set variant to RFC 4122
  id[8] = (id[8] & 0x3f) | 0x80;

  return id;
}

// Base64url alphabet (RFC 4648 Section 5)
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Convert a Uint8Array to base64url encoding (no padding).
 */
// NOTE: @quereus/quereus has an identical encoder in src/util/hash.ts, but it is not part of that
// package's public API. If a third copy appears, or the two ever need to agree on a change, promote
// one to a shared export instead of copying again.
export function toBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const byte1 = bytes[i];
    const byte2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const byte3 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    const triplet = (byte1 << 16) | (byte2 << 8) | byte3;

    result += BASE64URL_CHARS[(triplet >>> 18) & 0x3f];
    result += BASE64URL_CHARS[(triplet >>> 12) & 0x3f];
    if (i + 1 < bytes.length) {
      result += BASE64URL_CHARS[(triplet >>> 6) & 0x3f];
    }
    if (i + 2 < bytes.length) {
      result += BASE64URL_CHARS[triplet & 0x3f];
    }
  }
  return result;
}

/**
 * Convert a base64url string to Uint8Array.
 */
export function fromBase64Url(str: string): Uint8Array {
  // Build reverse lookup table
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_CHARS.length; i++) {
    lookup[BASE64URL_CHARS[i]] = i;
  }

  // Calculate output length (no padding in base64url)
  const len = str.length;
  const outputLen = Math.floor((len * 3) / 4);
  const result = new Uint8Array(outputLen);

  let writePos = 0;
  for (let i = 0; i < len; i += 4) {
    const c1 = lookup[str[i]] ?? 0;
    const c2 = lookup[str[i + 1]] ?? 0;
    const c3 = i + 2 < len ? lookup[str[i + 2]] ?? 0 : 0;
    const c4 = i + 3 < len ? lookup[str[i + 3]] ?? 0 : 0;

    const triplet = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;

    if (writePos < outputLen) result[writePos++] = (triplet >>> 16) & 0xff;
    if (writePos < outputLen) result[writePos++] = (triplet >>> 8) & 0xff;
    if (writePos < outputLen) result[writePos++] = triplet & 0xff;
  }

  return result;
}

/**
 * Convert site ID to base64url string for serialization.
 * 16 bytes → 22 characters (no padding).
 */
export function siteIdToBase64(siteId: SiteId): string {
  return toBase64Url(siteId);
}

/**
 * Parse site ID from base64url string.
 */
export function siteIdFromBase64(base64: string): SiteId {
  if (base64.length !== 22) {
    throw new Error(`Invalid site ID base64 length: ${base64.length}, expected 22`);
  }
  return fromBase64Url(base64);
}

/**
 * Compare two site IDs for equality.
 */
export function siteIdEquals(a: SiteId, b: SiteId): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Storage key for site identity.
 */
export const SITE_ID_KEY = 'si:';

/**
 * Site identity record stored in the KV store.
 */
export interface SiteIdentity {
  siteId: SiteId;
  createdAt: number;  // Timestamp when this replica was first initialized
}

/**
 * Serialize site identity for storage.
 */
export function serializeSiteIdentity(identity: SiteIdentity): Uint8Array {
  const buffer = new Uint8Array(24);  // 16 bytes siteId + 8 bytes timestamp
  buffer.set(identity.siteId, 0);

  const view = new DataView(buffer.buffer);
  view.setBigUint64(16, BigInt(identity.createdAt), false);

  return buffer;
}

/**
 * Deserialize site identity from storage.
 */
export function deserializeSiteIdentity(buffer: Uint8Array): SiteIdentity {
  if (buffer.length !== 24) {
    throw new Error(`Invalid site identity buffer length: ${buffer.length}, expected 24`);
  }

  const siteId = new Uint8Array(buffer.slice(0, 16));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const createdAt = Number(view.getBigUint64(16, false));

  return { siteId, createdAt };
}

