/**
 * Deterministic searchable index for shared-by-email lookups.
 *
 * The `workflow_shares` table is queried by email ("find shares addressed to
 * X") before we know which tenant owns the row, so we cannot use a
 * per-tenant key here. Instead we derive a 32-byte HMAC-SHA256 of the
 * normalised email under a single global pepper held in Secrets Manager
 * (`mike/email-hmac-pepper`). The pepper never touches the database, so a
 * Postgres-only breach (read replica leak, dump exfiltration) cannot reverse
 * the index — both the DB *and* the pepper would have to be compromised.
 *
 * Pepper rotation is treated as a stop-the-world operation: rewrite every
 * `shared_with_email_hmac` row under the new pepper inside a maintenance
 * window. We accept that cost in exchange for the smaller per-row overhead
 * of bare 32-byte HMACs (no version prefix).
 */

import { createHmac } from "crypto";

const PEPPER_HEX_LEN = 64; // 32 bytes hex-encoded

let cachedPepper: Buffer | null = null;

function getPepper(): Buffer {
    if (cachedPepper) return cachedPepper;
    const hex = process.env.EMAIL_HMAC_PEPPER;
    if (!hex) {
        throw new Error(
            "EMAIL_HMAC_PEPPER must be set (32 bytes hex from Secrets Manager mike/email-hmac-pepper)",
        );
    }
    if (hex.length !== PEPPER_HEX_LEN || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error(
            `EMAIL_HMAC_PEPPER must be ${PEPPER_HEX_LEN} hex chars (32 bytes), got ${hex.length}`,
        );
    }
    cachedPepper = Buffer.from(hex, "hex");
    return cachedPepper;
}

/**
 * Normalises an email for indexing: trims surrounding whitespace and
 * lowercases. We deliberately do NOT do anything Gmail-specific (stripping
 * "+tags" or dots) — the goal is to mirror what users would type when
 * sharing, not to canonicalise inboxes.
 */
export function normaliseEmail(raw: string): string {
    return raw.trim().toLowerCase();
}

/**
 * Returns the 32-byte HMAC-SHA256 index for an email. Stored in
 * `workflow_shares.shared_with_email_hmac` and used as the lookup key.
 */
export function emailIndex(email: string): Buffer {
    const normalised = normaliseEmail(email);
    return createHmac("sha256", getPepper()).update(normalised).digest();
}

/** Test-only escape hatch. Resets the module-scope pepper cache so tests
 *  can swap pepper values mid-run. */
export function _resetPepperCacheForTests(): void {
    cachedPepper = null;
}
