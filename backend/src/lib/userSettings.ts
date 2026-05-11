import { createServerSupabase } from "./supabase";
import { byteaToBuffer, getTenantCrypto } from "./crypto/migrate";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise Claude Haiku. With no user keys set, defaults to Gemini
// (the dev-mode env fallback).
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

// Dual-read: prefer the envelope-encrypted ciphertext column, fall back to the
// legacy plaintext column for rows that haven't been backfilled yet. Returns
// the plaintext value (or null) regardless of which column it came from, so
// downstream callers don't need to know which storage path was used.
async function openIfPresent(
    ct: unknown,
    fallback: unknown,
): Promise<string | null> {
    if (ct) {
        const buf = byteaToBuffer(ct);
        return await getTenantCrypto().open(buf);
    }
    if (typeof fallback === "string" && fallback.length > 0) return fallback;
    return null;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "tabular_model, claude_api_key, gemini_api_key, claude_api_key_ct, gemini_api_key_ct",
        )
        .eq("user_id", userId)
        .single();

    const api_keys: UserApiKeys = {
        claude: await openIfPresent(
            data?.claude_api_key_ct,
            data?.claude_api_key,
        ),
        gemini: await openIfPresent(
            data?.gemini_api_key_ct,
            data?.gemini_api_key,
        ),
    };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "claude_api_key, gemini_api_key, claude_api_key_ct, gemini_api_key_ct",
        )
        .eq("user_id", userId)
        .single();
    return {
        claude: await openIfPresent(
            data?.claude_api_key_ct,
            data?.claude_api_key,
        ),
        gemini: await openIfPresent(
            data?.gemini_api_key_ct,
            data?.gemini_api_key,
        ),
    };
}
