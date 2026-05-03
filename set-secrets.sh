#!/usr/bin/env bash
# set-secrets.sh — sets all required Supabase Edge Function secrets for Tempo
# Run with:  bash set-secrets.sh
# Or in Claude Code terminal:  ! bash set-secrets.sh

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
echo "Enter secret values (input is hidden):"

read -rsp "ANTHROPIC_API_KEY: " ANTHROPIC_API_KEY; echo
read -rsp "WEBHOOK_SECRET:     " WEBHOOK_SECRET;     echo
read -rsp "AUTOMATION_SECRET:  " AUTOMATION_SECRET;  echo

echo ""
echo "Setting secrets..."

$CLI secrets set \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  AUTOMATION_SECRET="$AUTOMATION_SECRET" \
  --project-ref "$PROJECT_REF"

echo ""
echo "Done. Verify with:"
echo "  $CLI secrets list --project-ref $PROJECT_REF"
