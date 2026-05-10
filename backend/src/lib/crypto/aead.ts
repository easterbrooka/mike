/**
 * Authenticated encryption (AEAD) for Mike's envelope-encrypted columns.
 *
 * AES-256-GCM with a self-describing envelope:
 *
 *     offset  len   field
 *     ------  ---   -----
 *     0       1     version          (currently always 0x01)
 *     1       4     dek_id           (uint32 BE; FK to tenant_deks.id)
 *     5       12    iv               (random 96-bit nonce per encryption)
 *     17      N     ciphertext
 *     17+N    16    auth_tag         (GCM tag)
 *
 * The version byte is mandatory and checked on every decrypt; v2 is reserved
 * for adding AAD (table/column/row binding) once we need it.
 *
 * This module is pure — no KMS dependency, no I/O. The caller supplies the
 * 32-byte DEK to seal() and a resolver function to open(). Tests live at
 * __tests__/aead.test.ts.
 */

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
} from "crypto";

const VERSION = 0x01;
const HEADER_LEN = 1 + 4 + 12; // version + dek_id + iv = 17 bytes
const TAG_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

export interface EnvelopeHeader {
    version: number;
    dekId: number;
}

export class CryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CryptoError";
    }
}

/**
 * Encrypts plaintext with AES-256-GCM under the given DEK and returns a
 * self-describing envelope buffer. The dekId is encoded so open() can
 * recover the right DEK without an external sidecar.
 */
export function seal(
    plaintext: Buffer | string,
    dek: Buffer,
    dekId: number,
): Buffer {
    if (dek.length !== KEY_LEN) {
        throw new CryptoError(
            `seal: dek must be ${KEY_LEN} bytes, got ${dek.length}`,
        );
    }
    if (!Number.isInteger(dekId) || dekId < 0 || dekId > 0xffffffff) {
        throw new CryptoError(
            `seal: dekId must be a uint32, got ${dekId}`,
        );
    }
    const pt = typeof plaintext === "string"
        ? Buffer.from(plaintext, "utf8")
        : plaintext;

    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt8(VERSION, 0);
    header.writeUInt32BE(dekId, 1);
    iv.copy(header, 5);

    return Buffer.concat([header, ct, tag]);
}

/**
 * Parses the envelope header without touching the ciphertext. Throws if the
 * envelope is malformed or the version is unknown.
 */
export function parseHeader(envelope: Buffer): EnvelopeHeader {
    if (envelope.length < HEADER_LEN + TAG_LEN) {
        throw new CryptoError(
            `parseHeader: envelope too short (${envelope.length} bytes)`,
        );
    }
    const version = envelope.readUInt8(0);
    if (version !== VERSION) {
        throw new CryptoError(
            `parseHeader: unsupported envelope version 0x${version.toString(16)}`,
        );
    }
    const dekId = envelope.readUInt32BE(1);
    return { version, dekId };
}

/**
 * Decrypts an envelope. The resolver callback maps dekId → 32-byte plaintext
 * DEK; it's the caller's responsibility to look up the right tenant DEK.
 *
 * Throws CryptoError on tamper, version mismatch, or missing DEK.
 */
export async function open(
    envelope: Buffer,
    resolveDek: (dekId: number) => Promise<Buffer>,
): Promise<Buffer> {
    const { dekId } = parseHeader(envelope);
    const dek = await resolveDek(dekId);
    if (!dek || dek.length !== KEY_LEN) {
        throw new CryptoError(
            `open: resolver returned invalid DEK for id ${dekId}`,
        );
    }
    const iv = envelope.subarray(5, HEADER_LEN);
    const ct = envelope.subarray(HEADER_LEN, envelope.length - TAG_LEN);
    const tag = envelope.subarray(envelope.length - TAG_LEN);

    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (err) {
        // Node throws a generic "Unsupported state or unable to authenticate
        // data" — wrap it so callers can pattern-match on CryptoError.
        throw new CryptoError(
            `open: authentication failed (envelope tampered or wrong DEK): ${
                (err as Error).message
            }`,
        );
    }
}
