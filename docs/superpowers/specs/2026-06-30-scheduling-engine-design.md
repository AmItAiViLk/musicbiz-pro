# Tempo — Automated Scheduling & Student Replies (Design)

**Date:** 2026-06-30
**Status:** Approved (design); flexible to revise during build.

## Purpose

The core value of Tempo: eliminate the manual time-sink of lesson coordination. When a student needs to move a lesson, finding a workable time often means asking _another_ student to move — a chain of "who can swap with whom." This feature automates that coordination and the WhatsApp correspondence, while the teacher stays in control via the app. Billing and invoices are handled elsewhere (billing already built; invoices = Green Invoice, separate plan).

## Key decisions (from brainstorming)

- **Intent detection:** student sends free-text WhatsApp; **Haiku** classifies into `cancel` / `paid` / `reschedule` / `availability_reply` / `swap_reply` / `other`.
- **Teacher loop is in-app** (not WhatsApp): approvals + activity live in Tempo. Avoids WhatsApp business-messaging limits to the teacher.
- **No Google Calendar needed.** The schedule is computed from the database: teacher availability windows minus students' occupied slots = free slots. The teacher updates their personal calendar manually.
- **Cancellations do not auto-adjust billing.** Billing stays teacher-controlled with a **manual override** per student/month.
- **Reschedule availability capture:** bot offers free slots AND asks the student for their general availability (to enable swap-hunting).
- **Swap autonomy is per-student:** a `auto_swap_ok` flag. If on, the bot may message that student to move without asking the teacher first; if off, the teacher approves before the bot contacts them.
- **Swap depth: one hop only (v1).** Dana wants Yossi's slot → Yossi must move to a genuinely free slot. No multi-hop cascade yet.
- **Decline/timeout:** if an asked student declines or is silent for 24h, try the next viable candidate; if none, notify the teacher and the original student to handle manually.

## Architecture

- **Inbound:** `whatsapp-webhook` (existing) gains an intent router. Replaces the current canned auto-reply.
  - `_shared/classify.ts` — Haiku call: message text + light context → intent + extracted fields (e.g. availability phrases).
  - `_shared/schedule.ts` — pure scheduling logic: compute free slots, find swap candidates (one hop), all from DB data. Unit-testable.
  - Reuses `_shared/meta.ts` (send text within the 24h window) and `_shared/messaging.ts`.
- **State:** `reschedule_requests` table (exists) extended to track swap state (who is being asked, candidate list, deadlines).
- **In-app (React):** an availability editor, a per-student auto-swap toggle, a "Requests/Activity" area (approve reschedules/swaps; view cancels/paids), and a manual billing override.

## Data model

- **`teacher_availability`** (table exists): the teacher's teaching-hours framework. `{ user_id, day_of_week, start_time, end_time }`. Edited in-app.
- **`students`**: add `auto_swap_ok boolean default false`.
- **`reschedule_requests`** (extend): add `kind` (`reschedule` | `swap`), `student_availability jsonb` (captured constraints), `swap_target_student_id text`, `swap_candidate_ids jsonb`, `deadline_at timestamptz`. Statuses: `pending_selection` | `awaiting_swap_partner` | `pending_approval` | `approved` | `rejected` | `failed`.
- **`tempo_automation_logs`** (exists, real columns `student_identifier`/`action_type`/`raw_data`): the activity feed source for cancels/paids and audit.
- **Billing override:** a per-(student, month) override of the computed amount/count. Likely a small `billing_overrides` table `{ user_id, student_id, year_month, lesson_count, amount, note }`, or override fields read by the billing calculation. Final shape decided in that plan.

## Flows

### Cancel

1. Student: "אני לא יכול מחר". → `cancel`.
2. Record `action_type=cancel` in logs. Reply: "קיבלנו, ביטלנו את השיעור. נעדכן בהתאם."
3. Appears in the in-app activity. Billing unchanged (teacher may override).

### Paid

1. Student: "העברתי תשלום". → `paid`.
2. Record `action_type=paid`. Reply: "תודה, רשמנו את התשלום."
3. Appears in activity. (Formal receipt handled by the Green Invoice plan.)

### Reschedule — Layer 1 (free slot)

1. Student: "אפשר להזיז את השיעור?" → `reschedule`.
2. Bot computes free slots (availability − occupied) and replies with up to 4, numbered, AND asks "מתי בא לך בדרך כלל?" Stores `reschedule_requests` (`pending_selection`, captured availability when given).
3. Student replies a number (`swap_reply`/`availability_reply`) → if it maps to a free slot → status `pending_approval`; teacher sees it in-app.
4. Teacher approves → student's `lesson_day`/`lesson_time` updated → status `approved` → student confirmed. Reject → student notified, `rejected`.

### Reschedule — Layer 2 (one-hop swap)

1. If no free slot fits the student's stated availability, the bot finds occupied slots that DO fit → the occupying students are swap candidates.
2. For the first candidate: if their `auto_swap_ok` is on → bot messages them ("אפשר להזיז את השיעור שלך ל-…? זה יעזור לחבר לקבוצה"); else create a `pending_approval` for the teacher to authorize contacting them.
3. Candidate accepts (and a free slot works for them) → propose the full plan to the teacher (`pending_approval`). Teacher approves → both students' slots update, both confirmed.
4. Candidate declines / silent 24h → next candidate. None left → notify teacher + original student (`failed`).

## Error handling

- Every send wraps in try/catch and logs `*_error` to `tempo_automation_logs` (as send-reminders does).
- Haiku failure or low confidence → fall back to `other`: reply with a gentle menu in Hebrew and/or flag for the teacher.
- All inbound replies stay within the 24h window (student initiated), so plain text is allowed — no templates needed inbound.

## Out of scope (v1)

- Multi-hop swap cascades (2+ hops).
- Google Calendar sync.
- Automatic billing adjustment from cancellations.
- Group lessons (assumes one student per slot).

## Decomposition (one spec, three build plans)

1. **Intent routing + Cancel + Paid** — webhook classifier, `_shared/classify.ts`, activity logging, in-app activity view. Ships first.
2. **Reschedule Layer 1** — `_shared/schedule.ts` free-slot logic, availability editor in-app, offer/pick/approve/update, `reschedule_requests` extension.
3. **Swap Engine Layer 2** — one-hop candidate finding, per-student `auto_swap_ok`, contact/approve/decline/timeout, final-plan approval.

Each plan ends with a working, testable slice.
