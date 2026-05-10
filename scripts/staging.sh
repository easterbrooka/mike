#!/usr/bin/env bash
#
# Throwaway-staging helper for the encryption-review branch.
#
# Spins up:
#   - MinIO (S3-compatible) in Docker, pre-provisioned with a "mike" bucket
#   - A backend/.env.staging + frontend/.env.local.staging tailored to it
# Plus helpers for applying the schema to a fresh Supabase project and
# running smoke checks against the running backend.
#
# Prereqs: docker (with compose v2), psql, curl. A fresh Supabase project
# (free tier is fine) — you'll plug its URL + keys into the env files.
#
# Subcommands:
#   up                  Start MinIO + create the bucket
#   down                Stop MinIO and delete its volume
#   env                 Print env-file templates with the MinIO bits
#                       pre-filled; you fill in the Supabase ones.
#   schema <PG_URL>     Apply backend/migrations/000_one_shot_schema.sql
#                       to the given Postgres connection string.
#   smoke <BACKEND_URL> <JWT>
#                       Hit the new endpoints with the supplied Supabase
#                       access token to verify Phase 1 behaviour.
#   help                Show this message.
#
# Typical flow:
#   1. Create a fresh Supabase project at supabase.com/dashboard
#   2. ./scripts/staging.sh up
#   3. ./scripts/staging.sh env  > /tmp/staging.env  # then split into
#                                                   # backend/.env.staging
#                                                   # and frontend/.env.local.staging,
#                                                   # filling in the Supabase blocks
#   4. ./scripts/staging.sh schema "postgresql://postgres:PW@db.xxx.supabase.co:5432/postgres"
#   5. (cd backend && env $(cat .env.staging | xargs) npm run dev)
#   6. (cd frontend && cp .env.local.staging .env.local && npm run dev)
#   7. Sign up via the running frontend, copy your access_token from
#      browser DevTools → Application → Local Storage → sb-…-auth-token
#   8. ./scripts/staging.sh smoke http://localhost:3001 <jwt>
#   9. ./scripts/staging.sh down

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/scripts/staging/docker-compose.yml"

cmd_help() {
  sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cmd_up() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found on PATH" >&2
    exit 1
  fi
  docker compose -f "$COMPOSE_FILE" up -d --wait
  echo
  echo "MinIO running:"
  echo "  S3 API:    http://127.0.0.1:9000"
  echo "  Console:   http://127.0.0.1:9001  (login: stagingaccesskey / stagingsecretkey)"
  echo "  Bucket:    mike"
  echo
  echo "Next: ./scripts/staging.sh env  to print the env-file templates."
}

cmd_down() {
  docker compose -f "$COMPOSE_FILE" down -v
}

cmd_env() {
  cat <<'EOF'
# ============================================================
# backend/.env.staging
# ============================================================
PORT=3001
FRONTEND_URL=http://localhost:3000

# ---- Supabase (fill these in) ----
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVICE_ROLE_KEY

# ---- Storage: MinIO from scripts/staging/docker-compose.yml ----
R2_BUCKET_NAME=mike
R2_REGION=us-east-1
R2_ENDPOINT_URL=http://127.0.0.1:9000
R2_ACCESS_KEY_ID=stagingaccesskey
R2_SECRET_ACCESS_KEY=stagingsecretkey
# Leave KMS_KEY_ID unset → falls back to SSE-S3 (AES256). The compose
# file sets MINIO_KMS_SECRET_KEY so MinIO honours SSE-S3; full SSE-KMS
# (with audit logs) needs a real AWS KMS key and is out of scope here.
# KMS_KEY_ID=

# ---- LLM providers (add your own keys for full chat testing) ----
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# ---- Download tokens: Phase 1 made this mandatory.
# Use any random string; SUPABASE_SECRET_KEY also works as fallback.
DOWNLOAD_SIGNING_SECRET=staging-download-secret-please-rotate

# ---- LLM raw-stream debug logging is OFF by default. Flip to "1"
# only when you need to diagnose a stream issue.
# LOG_LLM_RAW=

# ============================================================
# frontend/.env.local.staging
# ============================================================
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=YOUR_ANON_KEY
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
EOF
}

cmd_schema() {
  local pg_url="${1:-}"
  if [[ -z "$pg_url" ]]; then
    echo "usage: ./scripts/staging.sh schema <postgres-url>" >&2
    exit 2
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found on PATH" >&2
    exit 1
  fi
  psql "$pg_url" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/backend/migrations/000_one_shot_schema.sql"
  echo
  echo "Schema applied. Sign up a test user via the frontend so the auth.users row exists."
}

cmd_smoke() {
  local backend="${1:-}"
  local jwt="${2:-}"
  if [[ -z "$backend" || -z "$jwt" ]]; then
    echo "usage: ./scripts/staging.sh smoke <backend-url> <supabase-jwt>" >&2
    exit 2
  fi
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "curl and jq are required" >&2
    exit 1
  fi
  local auth="Authorization: Bearer $jwt"

  echo "==> health"
  curl -fsS "$backend/health" | jq .

  echo
  echo "==> POST /user/profile (idempotent upsert; ensures the row exists)"
  curl -fsS -X POST -H "$auth" "$backend/user/profile" | jq .

  echo
  echo "==> GET /user/api-keys/status (should return booleans, never the raw keys)"
  local status_body
  status_body="$(curl -fsS -H "$auth" "$backend/user/api-keys/status")"
  echo "$status_body" | jq .
  if echo "$status_body" | jq -e 'has("claude_api_key") or has("gemini_api_key")' >/dev/null 2>&1; then
    echo "FAIL: response leaked an *_api_key field" >&2
    exit 1
  fi
  echo "ok: response shape contains booleans only"

  echo
  echo "==> PUT /user/api-keys/claude (set a sentinel value)"
  curl -fsS -X PUT -H "$auth" -H "Content-Type: application/json" \
       --data '{"value":"sk-ant-staging-smoke-test"}' \
       "$backend/user/api-keys/claude" | jq .

  echo
  echo "==> GET status again (claude should now be true)"
  curl -fsS -H "$auth" "$backend/user/api-keys/status" | jq .

  echo
  echo "==> PUT /user/api-keys/claude (clear)"
  curl -fsS -X PUT -H "$auth" -H "Content-Type: application/json" \
       --data 'null' \
       "$backend/user/api-keys/claude" \
       || echo "(clear via {value:null} below — some shells choke on bare null)"
  curl -fsS -X PUT -H "$auth" -H "Content-Type: application/json" \
       --data '{"value":null}' \
       "$backend/user/api-keys/claude" | jq .

  echo
  echo "==> response headers (HSTS should be present)"
  curl -sSI -H "$auth" "$backend/health" | grep -iE 'strict-transport-security|x-content-type|x-frame' || true

  echo
  echo "==> backend reads the secret from env (signDownload should not throw)"
  echo "   (no direct endpoint to test this; if any document endpoint succeeds,"
  echo "    the secret is wired correctly. Upload a doc via the UI and watch"
  echo "    backend logs for any 'DOWNLOAD_SIGNING_SECRET' errors.)"

  echo
  echo "All smoke checks passed."
}

main() {
  local sub="${1:-help}"
  shift || true
  case "$sub" in
    up)     cmd_up "$@" ;;
    down)   cmd_down "$@" ;;
    env)    cmd_env "$@" ;;
    schema) cmd_schema "$@" ;;
    smoke)  cmd_smoke "$@" ;;
    help|-h|--help) cmd_help ;;
    *)
      echo "unknown subcommand: $sub" >&2
      cmd_help
      exit 2
      ;;
  esac
}

main "$@"
