# Tempo — Smart Billing & Payment Reminders (Design)

**Date:** 2026-07-05
**Status:** Approved (design); flexible to revise during build.

## Purpose

Close the loop on billing: the monthly billing message already goes out and the amount is auto-calculated. This feature adds **payment tracking** and a **careful, teacher-confirmed reminder** for students who haven't paid — without ever nagging someone who already paid (possibly by another method).

## What already exists

- `send-reminders` calculates each student's monthly total (`calcMonthlyLessons` × price) and sends the `monthly_billing` Meta template on the 1st of the month.
- The app has a read-only **Morning (חשבונית ירוקה)** integration: `api/morning-status.js` (Vercel) queries `api.morning.co.il/v1/incomes?clientName=…` and the Invoices view shows paid / unpaid per student. Morning credentials live in `user_settings` (`morning_key`, `morning_secret`).
- The webhook already records a `paid` event when a student messages that they paid.

## Key decisions (from brainstorming)

- **Payment-tracking mode is the teacher's choice:** `manual` (mark paid in the app) or `morning` (read invoice status from Morning). A setting in `user_settings`.
- **One reminder**, ~7 days after the billing message, only if still unpaid.
- **Verify carefully before sending — never auto-send blindly.** The system flags apparently-unpaid students and asks the teacher to confirm in-app: _"נראה שהתלמיד עדיין לא שילם. שילם בדרך אחרת? לשלוח תזכורת?"_ Confirm → send one reminder. Mark-paid → send nothing.
- **Persistent unpaid flag** in the app for every unpaid student, always visible.
- **Escalation:** if still unpaid ~10–11 days after billing (and already reminded), surface an in-app note for the teacher to handle personally. No further automatic reminders.
- **Reminder delivery needs a new Meta-approved template** `payment_reminder` (proactive/business-initiated, like `monthly_billing`).
- This feature only **reads** payment status. Creating invoices/receipts in Morning is a separate plan (Green Invoice receipts).

## Architecture

- **Data:** a `payment_status` table, one row per (student, month):
  `{ id, user_id, student_id (text), student_name, year_month ('YYYY-MM'), amount, billed_at, status ('unpaid'|'paid'), paid_source ('manual'|'morning'|null), reminder_state ('none'|'pending_confirm'|'reminded'|'escalated'), updated_at }`.
  Unique on `(user_id, student_id, year_month)`.
- **Setting:** `user_settings.payment_tracking_mode text default 'manual'` (`manual` | `morning`).
- **Billing hook (extend `send-reminders`):** when the monthly billing message is sent, upsert a `payment_status` row (`status='unpaid'`, `billed_at=now`, `amount`).
- **Daily check (extend `send-reminders` cron, runs daily):** for each `payment_status` where `status='unpaid'`:
  - Resolve current paid state per the teacher's mode:
    - `manual` → trust the stored `status` (only the teacher changes it in-app).
    - `morning` → query Morning for that student; if the invoice is closed/paid, set `status='paid'`, `paid_source='morning'`.
  - If now paid → done.
  - Else if `now >= billed_at + 7d` and `reminder_state='none'` → set `reminder_state='pending_confirm'` (surfaces to the teacher; no message sent yet).
  - Else if `now >= billed_at + ~11d` and `reminder_state='reminded'` → set `reminder_state='escalated'`.
- **In-app (React), a "גבייה" area (extend the Invoices view or a new section):**
  - **Pending confirmations:** rows in `pending_confirm` → show the prompt with two actions: **שלח תזכורת** (calls a function that sends the `payment_reminder` template, sets `reminder_state='reminded'`) and **סמן כשולם** (sets `status='paid'`, `paid_source='manual'`).
  - **Unpaid flag:** every `status='unpaid'` student shows a visible "לא שולם" badge.
  - **Escalations:** `reminder_state='escalated'` rows shown as a "לטיפול אישי" note.
  - In `manual` mode, a simple **paid / unpaid toggle** per student for the month.
- **Reminder send:** reuse `_shared/meta.ts` `sendTemplate` with `payment_reminder` (params: greeting + amount). Triggered by the teacher's confirm action (an Edge Function endpoint, authed by `AUTOMATION_SECRET`, or done via the frontend calling a small function).

## Morning check (server-side)

The daily check queries Morning directly from the Edge Function (same call the Vercel proxy makes): `GET api.morning.co.il/v1/incomes?clientName=<student name>&sort=createdAt:desc`, Basic auth from the teacher's `morning_key`/`morning_secret`. Match the current month; `status` closed/paid → paid. Failures are non-fatal (leave as unpaid, log an error).

## Reminder message (template `payment_reminder`, Utility, he)

Body (2 vars — greeting, amount):

```
היי {{1}}, תזכורת ידידותית: נותר תשלום על סך {{2}} ש"ח עבור החודש. אפשר להעביר בביט/פייבוקס/העברה בנקאית. תודה 🙏
```

## Error handling

- All sends wrapped, logged to `tempo_automation_logs` (`payment_reminder_sent` / `payment_reminder_error`).
- Morning API errors → non-fatal; student stays unpaid, teacher still sees the flag.
- Never send a reminder without the teacher's explicit confirm (guards against false reminders).

## Out of scope

- Creating invoices/receipts in Morning (separate Green Invoice plan).
- Automatic payment matching beyond Morning invoice status.
- Partial payments / installments.

## Decomposition (build plans)

1. **Payment status foundation** — `payment_status` table + `payment_tracking_mode` setting; `send-reminders` records an unpaid row when billing is sent; in-app unpaid flag + manual paid/unpaid toggle.
2. **Detection + teacher-confirmed reminder** — daily check sets `pending_confirm` after 7d (manual + Morning modes); in-app confirmation prompt; `payment_reminder` Meta template + send-on-confirm.
3. **Escalation** — ~11d escalation state + in-app "לטיפול אישי" note.

Each plan ends with a working, testable slice.
