/**
 * AWS KMS wrapper for envelope-encryption DEK lifecycle.
 *
 * The KEK is an AWS KMS symmetric key (alias `alias/mike-app-data` in
 * production). The application never sees the KEK plaintext — KMS does the
 * wrap/unwrap on its side. All this module does is:
 *
 *   - generateDek(): mint a fresh 32-byte DEK + the KMS-wrapped ciphertext
 *     blob to store alongside it. Called once per new tenant.
 *   - unwrapDek(): unwrap a previously-wrapped DEK so the app can decrypt
 *     ciphertext rows. Called on-demand and cached by the caller.
 *
 * The KMS key id comes from `KMS_KEY_ID` (alias or full ARN; the SDK
 * resolves either). `assertKmsConfigured()` is called at process startup in
 * production so misconfigured deploys fail fast rather than at the first
 * request that actually needs encryption.
 */

import {
    DecryptCommand,
    GenerateDataKeyCommand,
    KMSClient,
} from "@aws-sdk/client-kms";

export interface WrappedDek {
    /** KMS-wrapped DEK ciphertext, suitable for storing in tenant_deks.wrapped_dek. */
    wrapped: Buffer;
    /** Full ARN of the KMS key that wrapped this DEK. Stored alongside the
     *  wrapped blob so future Decrypt calls don't depend on an alias that
     *  could be repointed. */
    kmsKeyArn: string;
}

export interface FreshDek {
    /** 32-byte plaintext DEK. Caller should use it then drop the reference. */
    plaintext: Buffer;
    wrapped: WrappedDek;
}

let cachedClient: KMSClient | null = null;

function getClient(): KMSClient {
    if (cachedClient) return cachedClient;
    const region = process.env.AWS_REGION ?? "ap-southeast-2";
    cachedClient = new KMSClient({ region });
    return cachedClient;
}

function getKeyId(): string {
    const id = process.env.KMS_KEY_ID;
    if (!id) {
        throw new Error(
            "KMS_KEY_ID must be set (alias like alias/mike-app-data or full ARN)",
        );
    }
    return id;
}

/**
 * Generates a fresh DEK via KMS GenerateDataKey. Returns both the plaintext
 * 32-byte key (to use immediately for AES-GCM seal) and the KMS-wrapped
 * ciphertext (to persist in tenant_deks.wrapped_dek).
 */
export async function generateDek(): Promise<FreshDek> {
    const out = await getClient().send(
        new GenerateDataKeyCommand({
            KeyId: getKeyId(),
            KeySpec: "AES_256",
        }),
    );
    if (!out.Plaintext || !out.CiphertextBlob || !out.KeyId) {
        throw new Error(
            "kms.generateDek: KMS response missing Plaintext/CiphertextBlob/KeyId",
        );
    }
    return {
        plaintext: Buffer.from(out.Plaintext),
        wrapped: {
            wrapped: Buffer.from(out.CiphertextBlob),
            kmsKeyArn: out.KeyId,
        },
    };
}

/**
 * Unwraps a previously-wrapped DEK. KMS Decrypt validates that the caller
 * is authorised against the key policy of whichever KMS key originally
 * wrapped the blob; we don't need to pass KeyId for symmetric Decrypt.
 */
export async function unwrapDek(wrapped: Buffer): Promise<Buffer> {
    const out = await getClient().send(
        new DecryptCommand({ CiphertextBlob: wrapped }),
    );
    if (!out.Plaintext) {
        throw new Error("kms.unwrapDek: KMS Decrypt returned no Plaintext");
    }
    const buf = Buffer.from(out.Plaintext);
    if (buf.length !== 32) {
        throw new Error(
            `kms.unwrapDek: expected 32-byte DEK, got ${buf.length}`,
        );
    }
    return buf;
}

/**
 * Throws if KMS_KEY_ID is unset. Call this at process startup in
 * production so misconfigured deploys fail fast.
 */
export function assertKmsConfigured(): void {
    getKeyId();
}

/** Test-only: reset the module-scope KMS client cache so tests can swap
 *  the client (or the AWS_REGION env) between cases. */
export function _resetKmsClientForTests(): void {
    cachedClient = null;
}
