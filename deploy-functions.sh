#!/usr/bin/env bash
# deploy-functions.sh — deploys all Tempo Edge Functions to production Supabase.
# Run with:  bash deploy-functions.sh
# Or in Claude Code terminal:  ! bash deploy-functions.sh
#
# JWT verification policy per function:
#   gcal-oauth       → JWT ON  (called from the frontend with a user JWT)
#   send-reminders   → JWT OFF (called by pg_cron with AUTOMATION_SECRET bearer)
#   whatsapp-webhook → JWT OFF (called by Whapi.cloud with WEBHOOK_SECRET in query string)

set -euo pipefail

PROJECT_REF="tyckebaxdgqscxbpilqm"

if command -v supabase &>/dev/null; then
  CLI="supabase"
else
  CLI="npx --yes supabase@latest"
fi

echo "Using: $CLI"
echo ""

# ── Auth check ──────────────────────────────────────────────────────────────
# `supabase projects list` exits non-zero if not logged in.
if ! $CLI projects list >/dev/null 2>&1; then
  echo "Not logged in to Supabase CLI — running 'supabase login' (browser will open)..."
  $CLI login
fi

# ── Link project (idempotent) ───────────────────────────────────────────────
$CLI link --project-ref "$PROJECT_REF"

# ── Deploy ──────────────────────────────────────────────────────────────────
echo ""
echo "Deploying gcal-oauth (JWT verification ON)..."
$CLI functions deploy gcal-oauth --project-ref "$PROJECT_REF"

echo ""
echo "Deploying send-reminders (--no-verify-jwt; auth via AUTOMATION_SECRET)..."
$CLI functions deploy send-reminders --no-verify-jwt --project-ref "$PROJECT_REF"

echo ""
echo "Deploying whatsapp-webhook (--no-verify-jwt; auth via WEBHOOK_SECRET query param)..."
$CLI functions deploy whatsapp-webhook --no-verify-jwt --project-ref "$PROJECT_REF"

# ── Verify ──────────────────────────────────────────────────────────────────
echo ""
echo "Deployed. Current functions:"
$CLI functions list --project-ref "$PROJECT_REF"

echo ""
echo "URLs:"
echo "  https://${PROJECT_REF}.supabase.co/functions/v1/gcal-oauth"
echo "  https://${PROJECT_REF}.supabase.co/functions/v1/send-reminders"
echo "  https://${PROJECT_REF}.supabase.co/functions/v1/whatsapp-webhook"
