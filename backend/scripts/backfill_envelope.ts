/**
 * One-shot backfill for envelope-encryption Phase 2.
 *
 * Migration 001 added _ct (and _hmac for workflow_shares) columns alongside
 * the existing plaintext columns. This script walks every row, seals the
 * plaintext value under the owning user's DEK, and writes the ciphertext +
 * HMAC index columns. After the dual-read/dual-write code is live, the
 * plaintext columns can be dropped by migration 002.
 *
 * Idempotent: rows whose ciphertext is already set are skipped.
 *
 * Required env vars:
 *   - SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - KMS_KEY_ID            (alias or full ARN for the KEK)
 *   - EMAIL_HMAC_PEPPER     (32 bytes hex)
 *   - AWS_REGION            (defaults to ap-southeast-2)
 *
 * Run from backend/ on mike-builder via SSM:
 *   npx tsx scripts/backfill_envelope.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { bufferToBytea, ensureUserHasDek } from "../src/lib/crypto/migrate";
import { seal } from "../src/lib/crypto/aead";
import { emailIndex } from "../src/lib/crypto/searchable";

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
}

async function main() {
    requireEnv("KMS_KEY_ID");
    requireEnv("EMAIL_HMAC_PEPPER");
    const db = createClient(
        requireEnv("SUPABASE_URL"),
        requireEnv("SUPABASE_SECRET_KEY"),
        { auth: { persistSession: false } },
    );

    // Per-user DEK cache so we mint/unwrap at most once per user across both
    // tables — the same DEK is used for api keys and shared emails.
    const dekByUser = new Map<string, { dekId: number; dek: Buffer }>();
    async function dekFor(userId: string) {
        let entry = dekByUser.get(userId);
        if (!entry) {
            entry = await ensureUserHasDek(db, userId);
            dekByUser.set(userId, entry);
        }
        return entry;
    }

    // --- user_profiles -----------------------------------------------------
    const { data: profiles, error: profErr } = await db
        .from("user_profiles")
        .select(
            "user_id, claude_api_key, gemini_api_key, claude_api_key_ct, gemini_api_key_ct",
        );
    if (profErr) throw new Error(`select user_profiles: ${profErr.message}`);

    let profilesUpdated = 0;
    for (const p of profiles ?? []) {
        const updates: Record<string, string> = {};
        if (p.claude_api_key && !p.claude_api_key_ct) {
            const { dekId, dek } = await dekFor(p.user_id as string);
            updates.claude_api_key_ct = bufferToBytea(
                seal(p.claude_api_key as string, dek, dekId),
            );
        }
        if (p.gemini_api_key && !p.gemini_api_key_ct) {
            const { dekId, dek } = await dekFor(p.user_id as string);
            updates.gemini_api_key_ct = bufferToBytea(
                seal(p.gemini_api_key as string, dek, dekId),
            );
        }
        if (Object.keys(updates).length === 0) continue;
        const { error } = await db
            .from("user_profiles")
            .update(updates)
            .eq("user_id", p.user_id);
        if (error) throw new Error(`update user_profiles ${p.user_id}: ${error.message}`);
        profilesUpdated += 1;
    }

    // --- workflow_shares ---------------------------------------------------
    const { data: shares, error: shErr } = await db
        .from("workflow_shares")
        .select(
            "id, shared_by_user_id, shared_with_email, shared_with_email_ct, shared_with_email_hmac",
        );
    if (shErr) throw new Error(`select workflow_shares: ${shErr.message}`);

    let sharesUpdated = 0;
    for (const s of shares ?? []) {
        if (s.shared_with_email_ct && s.shared_with_email_hmac) continue;
        const email = (s.shared_with_email as string | null)?.trim().toLowerCase();
        if (!email) continue;
        const sharerId = s.shared_by_user_id as string | null;
        if (!sharerId) {
            console.warn(
                `workflow_shares id=${s.id} has no shared_by_user_id; skipping`,
            );
            continue;
        }
        const updates: Record<string, string> = {};
        if (!s.shared_with_email_ct) {
            const { dekId, dek } = await dekFor(sharerId);
            updates.shared_with_email_ct = bufferToBytea(seal(email, dek, dekId));
        }
        if (!s.shared_with_email_hmac) {
            updates.shared_with_email_hmac = bufferToBytea(emailIndex(email));
        }
        const { error } = await db
            .from("workflow_shares")
            .update(updates)
            .eq("id", s.id);
        if (error) throw new Error(`update workflow_shares ${s.id}: ${error.message}`);
        sharesUpdated += 1;
    }

    console.log(
        `Backfill complete: ${profilesUpdated} user_profiles rows, ${sharesUpdated} workflow_shares rows, ${dekByUser.size} DEKs touched.`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
