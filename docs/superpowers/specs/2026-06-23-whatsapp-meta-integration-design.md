# Tempo — WhatsApp (Meta Cloud API) Integration Design

**Date:** 2026-06-23
**Goal:** Working WhatsApp automation released to testers within ~2 weeks.

## Decision: single provider — Meta WhatsApp Cloud API

The app currently mixes **two** providers, which is why integration kept failing:

- Inbound webhook + replies → Meta Cloud API (`graph.facebook.com`)
- Outbound reminders/billing → Whapi.cloud (`gate.whapi.cloud`, via `_shared/whatsapp.ts`)

**We commit to Meta Cloud API and remove the Whapi path entirely.**

### Why Meta over Whapi (per owner's constraints)

- Owner cannot risk a WhatsApp ban → rules out unofficial Whapi.
- Meta is official and stable.
- Trade-off accepted: proactive messages require pre-approved templates.

### Number strategy

- The Meta Cloud API **takes over** any number it registers (removed from the normal WhatsApp app). So the owner's **personal number is never used.**
- **Testing phase:** use Meta's **free test number** (cloud-based, no SIM, no purchase) + add tester phone numbers as allowed recipients. No business verification needed.
- **Launch phase (later):** dedicated business number, verified once via SMS/voice code; number lives in Meta's cloud, no physical phone kept.

## Scope

### In scope

1. Inbound: receive student messages (cancel / paid / reschedule state machine).
2. Outbound: lesson reminders, billing messages, **receipts** (record/message per lesson held).
3. Google Calendar sync for reschedules (extend existing `_shared/gcal.ts`).
4. Remove Whapi code; unify all sends on Meta Cloud API.

### Out of scope (for now)

- Business verification / dedicated number (deferred to post-tester launch).
- Payments processing.
- Multi-teacher onboarding flows.

## Architecture (end state)

- `whatsapp-webhook` (Edge Function) — inbound only. Verifies Meta `X-Hub-Signature-256`, parses messages, runs intent classification (Haiku), routes to cancel/paid/reschedule handlers.
- `_shared/whatsapp-meta.ts` (replaces `_shared/whatsapp.ts`) — single Meta Cloud API sender used by ALL functions (webhook replies, reminders, billing, receipts). Handles plain text (within 24h window) and template messages (proactive).
- `send-reminders` (Edge Function) — pg_cron daily; builds reminder/billing/receipt messages and sends via the Meta sender using approved templates.
- `gcal-oauth` + `_shared/gcal.ts` — unchanged; powers reschedule slot-finding and event creation.

## Required Meta message templates (proactive sends)

- Lesson reminder (utility)
- Monthly billing summary (utility)
- Lesson receipt (utility)

(Templates submitted in Meta dashboard; utility templates typically approve fast.)

## Required Edge Function secrets

- `META_APP_SECRET` — webhook signature verification
- Meta permanent access token (currently misnamed `WHAPI_TOKEN` in webhook — rename to `META_ACCESS_TOKEN`)
- `WHATSAPP_PHONE_NUMBER_ID` — sending number's ID
- `WEBHOOK_SECRET` — webhook verify token
- `ANTHROPIC_API_KEY`, `AUTOMATION_SECRET`, `GOOGLE_CLIENT_ID/SECRET` — existing

## Rollout phases

1. **Pipe working:** finish deploy (fix CLI auth), set test number, add testers, prove one inbound + one outbound message end-to-end.
2. **Features:** repoint reminders/billing to Meta, add receipts, wire reschedule→Calendar.
3. **Testers:** add tester numbers, short usage guide, collect feedback.

## Division of labor

- **Owner:** dashboard clicks in Meta + Supabase (CLI login, secrets, deploy) — Claude provides exact one-at-a-time steps.
- **Claude:** all code, configs, log inspection, precise instructions.

## Open risks / notes

- Supabase CLI auth has been flaky ("Unauthorized"); use a fresh Personal Access Token via `SUPABASE_ACCESS_TOKEN` env var as the reliable path. Old token `sbp_5aa0...` is expired.
- Proactive sends outside the 24h customer-service window MUST use approved templates or Meta rejects them.
