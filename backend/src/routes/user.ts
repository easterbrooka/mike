import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { bufferToBytea, getTenantCrypto } from "../lib/crypto/migrate";

export const userRouter = Router();

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/api-keys/status
//
// Returns booleans only — never the keys themselves. The frontend uses this
// to gate model selection and render "configured / not configured" state in
// the API-keys settings page. Keeping the keys server-side closes the XSS
// exfiltration path that existed when the frontend pulled the raw key
// strings into React state via Supabase RLS.
userRouter.get("/api-keys/status", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select(
      "claude_api_key, gemini_api_key, claude_api_key_ct, gemini_api_key_ct",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  const claudePt = (data?.claude_api_key as string | null | undefined)?.trim();
  const geminiPt = (data?.gemini_api_key as string | null | undefined)?.trim();
  res.json({
    claude: Boolean(claudePt || data?.claude_api_key_ct),
    gemini: Boolean(geminiPt || data?.gemini_api_key_ct),
  });
});

// PUT /user/api-keys/:provider
//
// Set or clear (body.value === null) the user's API key for a single
// provider. Lives on the backend so the key never has to round-trip
// through the browser after configuration — a future migration of the
// settings page can collect the key in a form, POST once, and never store
// it client-side at all.
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { provider } = req.params;
  if (provider !== "claude" && provider !== "gemini") {
    return void res.status(400).json({ detail: "Unknown provider" });
  }
  const raw = (req.body as { value?: unknown } | undefined)?.value;
  const value =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : raw === null
        ? null
        : undefined;
  if (value === undefined) {
    return void res.status(400).json({
      detail: "value must be a non-empty string or explicit null",
    });
  }
  const dbField = provider === "claude" ? "claude_api_key" : "gemini_api_key";
  const ctField = `${dbField}_ct`;
  // Dual-write: seal the value under the user's DEK and write to BOTH the
  // plaintext column (for rollback safety during the cutover soak) and the
  // ciphertext column. A clear (value === null) zeroes both columns.
  // bufferToBytea is required: supabase-js JSON.stringify-s the body and a
  // raw Buffer would serialise to `{"type":"Buffer",...}` which bytea rejects.
  const sealed = value === null
    ? null
    : bufferToBytea(await getTenantCrypto().sealForUser(userId, value));
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .update({
      [dbField]: value,
      [ctField]: sealed,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true, configured: value !== null });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
