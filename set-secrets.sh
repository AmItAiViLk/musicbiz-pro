#!/usr/bin/env bash
# set-secrets.sh — sets all required Supabase Edge Function secrets for Tempo
# Run with:  bash set-secrets.sh
# Or in Claude Code terminal:  ! bash set-secrets.sh
#
# NOTE: WHAPI_TOKEN is NOT set here. It is stored per-user in user_settings.whapi_token
# (entered through the app's Settings screen by each teacher).

set -euo pipefail

PROJECT_REF="tyckebaxdgqscxbpilqm"

# Prefer installed CLI, fall back to npx
if command -v supabase &>/dev/null; then
  CLI="supabase"
else
  CLI="npx --yes supabase@latest"
fi

echo "Using: $CLI"
echo ""

# Link project (safe to re-run)
$CLI link --project-ref "$PROJECT_REF"

echo ""
echo "Enter secret values (input is hidden — press Enter to skip any to keep its current value):"

read -rsp "ANTHROPIC_API_KEY:    " ANTHROPIC_API_KEY;    echo
read -rsp "WEBHOOK_SECRET:       " WEBHOOK_SECRET;       echo
read -rsp "AUTOMATION_SECRET:    " AUTOMATION_SECRET;    echo
read -rsp "META_APP_SECRET:      " META_APP_SECRET;      echo
read -rsp "GOOGLE_CLIENT_ID:     " GOOGLE_CLIENT_ID;     echo
read -rsp "GOOGLE_CLIENT_SECRET: " GOOGLE_CLIENT_SECRET; echo

# Build the args list, skipping any empty inputs (lets you update just one)
ARGS=()
[[ -n "$ANTHROPIC_API_KEY"    ]] && ARGS+=( "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" )
[[ -n "$WEBHOOK_SECRET"       ]] && ARGS+=( "WEBHOOK_SECRET=$WEBHOOK_SECRET" )
[[ -n "$AUTOMATION_SECRET"    ]] && ARGS+=( "AUTOMATION_SECRET=$AUTOMATION_SECRET" )
[[ -n "$META_APP_SECRET"      ]] && ARGS+=( "META_APP_SECRET=$META_APP_SECRET" )
[[ -n "$GOOGLE_CLIENT_ID"     ]] && ARGS+=( "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID" )
[[ -n "$GOOGLE_CLIENT_SECRET" ]] && ARGS+=( "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET" )

if [[ ${#ARGS[@]} -eq 0 ]]; then
  echo "No values entered — nothing to update."
  exit 0
fi

echo ""
echo "Setting ${#ARGS[@]} secret(s)..."
$CLI secrets set "${ARGS[@]}" --project-ref "$PROJECT_REF"

echo ""
echo "Done. Verify with:"
echo "  $CLI secrets list --project-ref $PROJECT_REF"
