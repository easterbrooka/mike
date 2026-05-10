-- 001_envelope_encryption.sql
--
-- Phase 2 of the encryption hardening: envelope-encrypt secret columns
-- (user_profiles.{claude,gemini}_api_key, workflow_shares.shared_with_email)
-- under per-tenant DEKs that are themselves wrapped by an AWS KMS key.
--
-- This migration is purely additive. It introduces:
--   * tenant_deks                          — wrapped DEKs, one active per user.
--   * user_profiles.{claude,gemini}_api_key_ct
--   * workflow_shares.shared_with_email_ct
--   * workflow_shares.shared_with_email_hmac (deterministic HMAC index)
--
-- The old plaintext columns and indexes are left in place. The application
-- runs in dual-read / dual-write mode against both old and new columns so a
-- redeploy can roll backward at any time. A separate later migration
-- (002_drop_plaintext_secret_columns.sql) drops the old columns once the
-- ciphertext path is verified in production.

-- ---------------------------------------------------------------------------
-- Per-tenant wrapped DEKs
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_deks (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kms_key_arn   text not null,
  wrapped_dek   bytea not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  retired_at    timestamptz
);

-- One active DEK per user. Retired DEKs (is_active = false) accumulate so
-- that ciphertext sealed under an old DEK can still be opened during a
-- rotation; a separate cleanup step archives or deletes them later.
create unique index if not exists tenant_deks_user_active_unique
  on public.tenant_deks(user_id) where is_active;

create index if not exists tenant_deks_user_idx
  on public.tenant_deks(user_id);

alter table public.tenant_deks enable row level security;
-- No RLS policy is created. The backend uses the Supabase service role,
-- which bypasses RLS; deny-by-default for everyone else (including the
-- user themselves over PostgREST) is exactly what we want — the wrapped
-- DEK is useless without KMS Decrypt rights but defence in depth is cheap.

-- ---------------------------------------------------------------------------
-- user_profiles ciphertext columns
-- ---------------------------------------------------------------------------

alter table public.user_profiles
  add column if not exists claude_api_key_ct bytea,
  add column if not exists gemini_api_key_ct bytea;

-- ---------------------------------------------------------------------------
-- workflow_shares ciphertext + HMAC index
-- ---------------------------------------------------------------------------

alter table public.workflow_shares
  add column if not exists shared_with_email_ct   bytea,
  add column if not exists shared_with_email_hmac bytea;

-- Preserves the (workflow_id, shared_with_email) uniqueness invariant on the
-- new columns. The old workflow_shares_workflow_email_unique constraint stays
-- in place during the dual-write window; the migration that drops the
-- plaintext column also drops the old constraint.
create unique index if not exists workflow_shares_workflow_hmac_unique
  on public.workflow_shares(workflow_id, shared_with_email_hmac);

-- Lookup index for the share-by-email read path
-- (resolveWorkflowAccess, GET /workflows shared listing, chatTools).
create index if not exists workflow_shares_email_hmac_idx
  on public.workflow_shares(shared_with_email_hmac);
