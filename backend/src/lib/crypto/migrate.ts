/**
 * TenantCrypto — the user-facing wrapper that ties kms.ts, aead.ts, and the
 * `tenant_deks` table together. Call sites (userSettings.ts, routes/user.ts,
 * routes/workflows.ts, chatTools.ts) should import this rather than the
 * lower-level modules.
 *
 * Lifecycle:
 *   - sealForUser(userId, plaintext): finds (or creates) the user's active
 *     wrapped DEK, unwraps it via KMS once and caches by dek_id, then
 *     AES-GCM seals the plaintext under it.
 *   - open(envelope): parses the dek_id out of the envelope, looks up the
 *     wrapped DEK row, unwraps via KMS (cached), AES-GCM opens.
 *
 * Cache: a bounded Map<dek_id, Buffer> at process scope. KMS Decrypt is
 * called at most once per dek_id per process lifetime. For our scale
 * (hundreds to a few thousand users) we can afford to keep all active DEKs
 * resident; the cap is defensive only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "../supabase";
import { open as aeadOpen, seal as aeadSeal } from "./aead";
import { generateDek as kmsGenerateDek, unwrapDek } from "./kms";

const DEK_CACHE_MAX = 1024;

export interface TenantCrypto {
    /** Seal under the user's active DEK, minting one if the user has none yet. */
    sealForUser(userId: string, plaintext: string): Promise<Buffer>;

    /** Convenience: returns null if plaintext is null/empty, else seals. */
    sealNullable(
        userId: string,
        plaintext: string | null | undefined,
    ): Promise<Buffer | null>;

    /** Decrypt an envelope previously sealed by anyone (DEK looked up by id). */
    open(envelope: Buffer): Promise<string>;
}

interface DekRow {
    id: number;
    wrapped_dek: string; // bytea — Supabase returns hex-prefixed string
    is_active: boolean;
}

/**
 * Convert a Supabase-returned bytea string into a Node Buffer.
 * Supabase serialises bytea as a `\x`-prefixed hex string by default.
 */
export function byteaToBuffer(s: unknown): Buffer {
    if (typeof s !== "string") {
        throw new Error(`byteaToBuffer: expected string, got ${typeof s}`);
    }
    if (s.startsWith("\\x")) return Buffer.from(s.slice(2), "hex");
    if (s.startsWith("0x")) return Buffer.from(s.slice(2), "hex");
    // Fallback: assume already-hex
    return Buffer.from(s, "hex");
}

/**
 * Inverse of byteaToBuffer: emits the `\x`-prefixed hex string PostgREST
 * expects when writing or filtering bytea columns. supabase-js calls
 * JSON.stringify on insert/upsert bodies and URL-encodes filter values; a
 * raw Buffer would round-trip as `{"type":"Buffer","data":[...]}` (rejected
 * by bytea) or as utf8 garbage in a filter param. Use this on every Buffer
 * value before it crosses the supabase-js boundary.
 */
export function bufferToBytea(buf: Buffer): string {
    return "\\x" + buf.toString("hex");
}

export function tenantCrypto(db: SupabaseClient): TenantCrypto {
    // Process-scoped cache. Map preserves insertion order, which we use as a
    // crude LRU when we hit the cap.
    const dekCache = new Map<number, Buffer>();

    function cacheDek(dekId: number, dek: Buffer): void {
        if (dekCache.has(dekId)) {
            // Re-insert to bump LRU position
            dekCache.delete(dekId);
        } else if (dekCache.size >= DEK_CACHE_MAX) {
            const oldest = dekCache.keys().next().value;
            if (oldest !== undefined) dekCache.delete(oldest);
        }
        dekCache.set(dekId, dek);
    }

    async function loadDekById(dekId: number): Promise<Buffer> {
        const cached = dekCache.get(dekId);
        if (cached) return cached;

        const { data, error } = await db
            .from("tenant_deks")
            .select("id, wrapped_dek")
            .eq("id", dekId)
            .single();
        if (error || !data) {
            throw new Error(
                `tenantCrypto: dek_id ${dekId} not found in tenant_deks: ${
                    error?.message ?? "no row"
                }`,
            );
        }
        const dek = await unwrapDek(byteaToBuffer(data.wrapped_dek));
        cacheDek(dekId, dek);
        return dek;
    }

    async function ensureActiveDek(
        userId: string,
    ): Promise<{ dekId: number; dek: Buffer }> {
        const existing = await db
            .from("tenant_deks")
            .select("id, wrapped_dek, is_active")
            .eq("user_id", userId)
            .eq("is_active", true)
            .maybeSingle();

        if (existing.data) {
            const row = existing.data as DekRow;
            const cached = dekCache.get(row.id);
            const dek = cached ?? await unwrapDek(byteaToBuffer(row.wrapped_dek));
            if (!cached) cacheDek(row.id, dek);
            return { dekId: row.id, dek };
        }
        if (existing.error && existing.error.code !== "PGRST116") {
            // PGRST116 = "Cannot coerce the result to a single JSON object"
            throw new Error(
                `tenantCrypto.ensureActiveDek: lookup failed: ${existing.error.message}`,
            );
        }

        // No active DEK — mint one via KMS and insert.
        const fresh = await kmsGenerateDek();
        const inserted = await db
            .from("tenant_deks")
            .insert({
                user_id: userId,
                kms_key_arn: fresh.wrapped.kmsKeyArn,
                wrapped_dek: bufferToBytea(fresh.wrapped.wrapped),
                is_active: true,
            })
            .select("id")
            .single();
        if (inserted.error || !inserted.data) {
            throw new Error(
                `tenantCrypto.ensureActiveDek: insert failed: ${
                    inserted.error?.message ?? "no row returned"
                }`,
            );
        }
        const dekId = (inserted.data as { id: number }).id;
        cacheDek(dekId, fresh.plaintext);
        return { dekId, dek: fresh.plaintext };
    }

    return {
        async sealForUser(userId: string, plaintext: string): Promise<Buffer> {
            const { dekId, dek } = await ensureActiveDek(userId);
            return aeadSeal(plaintext, dek, dekId);
        },

        async sealNullable(userId, plaintext) {
            if (plaintext === null || plaintext === undefined) return null;
            if (plaintext === "") return null;
            return this.sealForUser(userId, plaintext);
        },

        async open(envelope: Buffer): Promise<string> {
            const out = await aeadOpen(envelope, loadDekById);
            return out.toString("utf8");
        },
    };
}

/**
 * Process-wide TenantCrypto singleton. The dek cache lives in the closure
 * inside `tenantCrypto(db)`, so call sites must share one instance to amortise
 * KMS Decrypt calls across requests. Tests bypass this and instantiate
 * `tenantCrypto(fakeDb)` directly.
 */
let cachedTenantCrypto: TenantCrypto | null = null;

export function getTenantCrypto(): TenantCrypto {
    if (!cachedTenantCrypto) {
        cachedTenantCrypto = tenantCrypto(createServerSupabase());
    }
    return cachedTenantCrypto;
}

/**
 * Backfill helper: mint a DEK for a user if they don't have one yet, and
 * return the dek_id + plaintext key. Used by scripts/backfill_envelope.ts.
 */
export async function ensureUserHasDek(
    db: SupabaseClient,
    userId: string,
): Promise<{ dekId: number; dek: Buffer }> {
    const existing = await db
        .from("tenant_deks")
        .select("id, wrapped_dek")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle();
    if (existing.data) {
        const row = existing.data as DekRow;
        const dek = await unwrapDek(byteaToBuffer(row.wrapped_dek));
        return { dekId: row.id, dek };
    }
    const fresh = await kmsGenerateDek();
    const inserted = await db
        .from("tenant_deks")
        .insert({
            user_id: userId,
            kms_key_arn: fresh.wrapped.kmsKeyArn,
            wrapped_dek: bufferToBytea(fresh.wrapped.wrapped),
            is_active: true,
        })
        .select("id")
        .single();
    if (inserted.error || !inserted.data) {
        throw new Error(
            `ensureUserHasDek: insert failed: ${
                inserted.error?.message ?? "no row"
            }`,
        );
    }
    return { dekId: (inserted.data as { id: number }).id, dek: fresh.plaintext };
}
