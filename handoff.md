# Handoff — encryption review branch

> **Temporary.** Delete or gitignore once the VM session catches up.

## Where you are

- Branch: `claude/review-encryption-security-41EjT` (pushed to origin)
- Last commits:
  - `85deb99` — staging helper scripts (this is the one you're about to run)
  - `22f9c0d` — Phase 1 encryption hardening
  - `3e84c66` — Phase 0 test scaffold + lint guard
- Plan file (don't commit): `/root/.claude/plans/review-current-encryption-built-federated-sedgewick.md`

## What you're about to do

Run `scripts/staging.sh` on the dev VM to spin up a throwaway env (MinIO +
fresh Supabase project) and exercise the Phase 1 changes against it without
touching prod.

## Quick start (copy-paste)

```bash
# 0. Create a fresh Supabase project at supabase.com/dashboard
#    Capture: project URL, anon key, service-role key, postgres password

# 1. Boot local S3
./scripts/staging.sh up

# 2. Generate env templates and fill in the Supabase blocks
./scripts/staging.sh env > /tmp/staging.env
#    split the two sections into backend/.env.staging and frontend/.env.local.staging
#    (the SUPABASE_* lines are the only fill-ins)

# 3. Apply schema to the Supabase project
./scripts/staging.sh schema "postgresql://postgres:PW@db.xxx.supabase.co:5432/postgres"

# 4. Run backend + frontend
(cd backend && set -a && . .env.staging && set +a && npm install && npm run dev)
# in another shell:
(cd frontend && cp .env.local.staging .env.local && npm install --legacy-peer-deps && npm run dev)

# 5. Sign up via http://localhost:3000
#    Grab your JWT: DevTools → Application → Local Storage → sb-...-auth-token

# 6. Smoke test
./scripts/staging.sh smoke http://localhost:3001 <jwt>

# 7. When done
./scripts/staging.sh down
```

Prereqs the VM needs: `docker` (compose v2), `psql`, `curl`, `jq`, Node 20+.

## What to eyeball in the UI

- **Settings → API Keys**: save a Claude key → "Configured" pill appears.
  Replace + Clear both work. The raw key is never visible after save.
- **Upload a document**: tail backend logs, confirm no document text or
  `firstChars=…` appears. With MinIO Console
  (http://127.0.0.1:9001, login `stagingaccesskey` / `stagingsecretkey`),
  `mc stat local/mike/documents/...` should show
  `X-Amz-Server-Side-Encryption: AES256`.
- **Download a doc** (from chat or doc panel): still works. Both legacy
  tokens (no `iat`) and new tokens (with `iat`) verify.
- **Response headers**: `curl -sSI http://localhost:3001/health` shows
  `Strict-Transport-Security`.

The smoke command also asserts `/user/api-keys/status` never returns an
`*_api_key` field — the booleans-only contract.

## What's already done on this branch

### Phase 0 (commit `3e84c66`)
- `vitest` + `npm test` in backend
- 43 unit tests: downloadTokens, storage helpers, access control
- ESLint rule banning hardcoded `http://localhost` URLs

### Phase 1 (commit `22f9c0d`)
- LLM raw-stream logs gated behind `LOG_LLM_RAW=1` (default off)
- `firstChars=…` document-content log dropped
- `ServerSideEncryption` set on every S3 PutObject (KMS if `KMS_KEY_ID`,
  AES256 otherwise)
- `signDownload` throws if no secret env; `iat` added to payload;
  `"dev-secret"` fallback removed
- `helmet` + 1y HSTS on backend
- New backend endpoints: `GET /user/api-keys/status`,
  `PUT /user/api-keys/:provider`
- `UserProfileContext` no longer pulls API keys into React state — just
  booleans (`claudeKeyConfigured` / `geminiKeyConfigured`)
- Account / models page UX: "Configured" pill + Replace / Clear (no longer
  reveals saved keys)
- New `apiBase()` helper, throws at module load if
  `NEXT_PUBLIC_API_BASE_URL` is missing or non-https in prod
- All 13 `?? "http://localhost:3001"` fallback sites replaced
- 45 backend tests pass, tsc clean on both, ESLint guard reports 0
  violations

## Deferred from the original plan (do NOT silently re-attempt)

1. **Download token TTL + userId binding.** Chat-rendered links persist in
   `chat_messages.content` forever — universal 15-min TTL would break them
   all. Needs a separate migration of `backend/src/lib/chatTools.ts`
   link-rendering to a fetch-on-demand stub before TTL/userId can ship.
2. **Pre-existing 36 ESLint errors / 68 warnings.** Mostly React 19 strict
   rules (`set-state-in-effect`, `exhaustive-deps`) — needs a careful
   per-call-site audit on its own branch. ~80% are cosmetic
   (unused-vars, explicit-any, unescaped-entities,
   `require()` in a build script).
3. **Phase 2 (envelope encryption).** Per-tenant DEK wrapped by AWS KMS,
   `bytea` ciphertext for `user_profiles.{claude,gemini}_api_key` and
   `workflow_shares.shared_with_email` (with HMAC index for lookup).
   Build `backend/src/lib/crypto/{kms,aead,searchable,migrate}.ts` first.
4. **Phase 3.** Encrypt remaining PII columns + S3 object envelope
   encryption + RLS on every tenant-scoped table.

## Important gotchas

- `NEXT_PUBLIC_API_BASE_URL` is now mandatory. The frontend throws at
  module load if it's missing, or non-https in production. If a deploy
  fails to load with a cryptic error, that's almost always it.
- `DOWNLOAD_SIGNING_SECRET` is also mandatory now. `SUPABASE_SECRET_KEY`
  is still accepted as a fallback, so existing prod deploys should be
  fine — but a fresh deploy that lacks both will throw on the first
  download mint.
- HSTS is 1y `includeSubDomains`. Once a browser hits prod with the new
  helmet config, it will refuse plain HTTP for that origin (and all
  subdomains) for a year. Almost certainly fine, but worth knowing.
- Frontend `npm install` needs `--legacy-peer-deps` due to a pre-existing
  conflict between `@opennextjs/cloudflare` and `next 16.2.6`.

## If something breaks during the smoke run

- Backend won't start with "DOWNLOAD_SIGNING_SECRET must be set" → set it
  in `backend/.env.staging` (the `env` subcommand template already has a
  placeholder).
- Frontend won't load with "NEXT_PUBLIC_API_BASE_URL must be set" →
  ensure `.env.local` has it and the dev server was restarted after the
  copy.
- Schema apply fails with "extension pgcrypto already exists" → ignore;
  the migration is idempotent.
- MinIO bucket missing → `./scripts/staging.sh down && ./scripts/staging.sh up`
  to re-run the init container.

## Coming next

Once the staging run validates Phase 1, the natural next step is **Phase
2** (envelope encryption of secrets — `user_profiles` API keys + email
HMACs). Read the plan file linked above for the design.
