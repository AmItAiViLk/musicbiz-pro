# Reschedule — Offer & Pick (Scheduling Layer 2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a student asks to reschedule, the bot offers the teacher's genuinely-open weekly slots (computed from the DB), the student replies with a number, and the choice is recorded for the teacher's approval.

**Architecture:** Free slots = the teacher's `teacher_availability` windows (enumerated hourly) minus every student's occupied `(lesson_day, lesson_time)`. The `whatsapp-webhook` offers them as a numbered list and stores a `reschedule_requests` row (`pending_selection`); a follow-up digit from that student advances it to `pending_approval`. All computation is DB-based (no Google Calendar). Teacher approval + the confirmation message are Layer 2b (next plan).

**Tech Stack:** Deno Edge Functions (TypeScript), Supabase, Meta WhatsApp Cloud API.

## Global Constraints

- Hebrew messages. `student_id`/`student_identifier` is text.
- No Google Calendar — slots come from `teacher_availability` − occupied student slots.
- The offer is a reply within the 24h window (student just messaged) → plain text via `sendText`, no template.
- One active `pending_selection` request per student (enforced by the existing unique index).
- No Deno test runner locally; pure helpers via `deno test`, integration via WhatsApp + SQL.
- `teacher_availability` columns: `user_id, day_of_week (0=Sun..6=Sat), start_time (time), end_time (time)`.
- `reschedule_requests` columns: `user_id, student_id, student_phone, options (jsonb), selected_option (jsonb), status ('pending_selection'|'pending_approval'|'approved'|'rejected'), ...`.
- Webhook scopes to the teacher via the `DEFAULT_USER_ID` secret.

---

## File Structure

- **Modify** `supabase/functions/_shared/schedule.ts` — `computeFreeSlots()` + `slotLabel()` (pure).
- **Modify** `supabase/functions/_shared/schedule.test.ts` — tests.
- **Modify** `supabase/functions/whatsapp-webhook/index.ts` — offer slots on reschedule intent; handle a digit pick against an open request.
- **DB** — ensure `teacher_availability.sql` and `reschedule_requests.sql` migrations are applied.

---

### Task 1: Apply the migrations

**Files:** none (Supabase SQL editor).

- [ ] **Step 1: Run both migrations** (USER, SQL editor — clear the editor first)

Run the contents of `supabase/migrations/teacher_availability.sql`, then (clear + run) `supabase/migrations/reschedule_requests.sql`. Both are `IF NOT EXISTS`, so safe if already applied. Expected: "Success. No rows returned".

- [ ] **Step 2: Confirm**

```sql
select count(*) from teacher_availability;
select count(*) from reschedule_requests;
```

Expected: both run without error (counts may be 0).

---

### Task 2: Free-slot computation (`schedule.ts`)

**Files:**

- Modify: `supabase/functions/_shared/schedule.ts`
- Test: `supabase/functions/_shared/schedule.test.ts`

**Interfaces:**

- Produces:
  - `interface FreeSlot { day: number; time: string }` (`day` 0–6, `time` `'HH:MM'`)
  - `computeFreeSlots(availability: { day_of_week: number; start_time: string; end_time: string }[], occupied: { day: number; time: string }[]): FreeSlot[]`
  - `slotLabel(slot: FreeSlot): string` → e.g. `"יום שני 09:00"`

- [ ] **Step 1: Write the failing test** (append to `schedule.test.ts`)

```ts
import { computeFreeSlots, slotLabel } from "./schedule.ts";

Deno.test("computeFreeSlots enumerates hourly slots minus occupied", () => {
  const avail = [
    { day_of_week: 1, start_time: "09:00:00", end_time: "12:00:00" },
  ];
  const occupied = [{ day: 1, time: "10:00" }];
  const free = computeFreeSlots(avail, occupied);
  assertEquals(free, [
    { day: 1, time: "09:00" },
    { day: 1, time: "11:00" },
  ]);
});

Deno.test("slotLabel formats day + time in Hebrew", () => {
  assertEquals(slotLabel({ day: 1, time: "09:00" }), "יום שני 09:00");
});
```

- [ ] **Step 2: Run to verify it fails** — `deno test supabase/functions/_shared/schedule.test.ts`.

- [ ] **Step 3: Implement** (append to `schedule.ts`)

```ts
export interface FreeSlot {
  day: number; // 0=Sun … 6=Sat
  time: string; // 'HH:MM'
}

const SLOT_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Hourly candidate start times ('HH:MM') within [start, end). */
function hourlySlots(startTime: string, endTime: string): string[] {
  const [sh, sm] = startTime.split(":").map((x) => parseInt(x, 10));
  const [eh, em] = endTime.split(":").map((x) => parseInt(x, 10));
  const endMin = eh * 60 + em;
  const out: string[] = [];
  let cur = sh * 60 + sm;
  while (cur + 60 <= endMin) {
    out.push(
      `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`,
    );
    cur += 60;
  }
  return out;
}

/** Free slots = availability windows (hourly) minus occupied (day,time). */
export function computeFreeSlots(
  availability: { day_of_week: number; start_time: string; end_time: string }[],
  occupied: { day: number; time: string }[],
): FreeSlot[] {
  const taken = new Set(occupied.map((o) => `${o.day}|${o.time}`));
  const free: FreeSlot[] = [];
  for (const w of availability) {
    for (const time of hourlySlots(w.start_time, w.end_time)) {
      if (!taken.has(`${w.day_of_week}|${time}`)) {
        free.push({ day: w.day_of_week, time });
      }
    }
  }
  return free;
}

/** Hebrew label, e.g. "יום שני 09:00". */
export function slotLabel(slot: FreeSlot): string {
  return `יום ${SLOT_DAYS[slot.day] ?? "?"} ${slot.time}`;
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/schedule.ts supabase/functions/_shared/schedule.test.ts
git commit -m "feat(wa): free-slot computation for reschedule"
```

---

### Task 3: Offer slots when a student asks to reschedule

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts`

**Interfaces:**

- Consumes: `computeFreeSlots`, `slotLabel` (Task 2); existing `sendMetaReply`, `findStudentByPhone`, `logToDb`, `createClient`, `normalizePhone`, `nowInIsrael`.

Replace the current placeholder reschedule reply with: compute the teacher's free slots and offer up to 4 as a numbered list, storing a `pending_selection` request.

- [ ] **Step 1: Add imports**

```ts
import {
  computeFreeSlots,
  slotLabel,
  type FreeSlot,
} from "../_shared/schedule.ts";
```

- [ ] **Step 2: Add an offer helper** (near `handleCancel` in the webhook)

```ts
async function handleReschedule(
  senderPhone: string,
): Promise<{ reply: string; action: string; who: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  const student = await findStudentByPhone(senderPhone);
  if (!supabaseUrl || !serviceKey || !userId || !student) {
    return {
      reply: "קיבלנו שתרצה לתאם מחדש. המורה יחזור אליך בהקדם 🙏",
      action: "reschedule_unmatched",
      who: student?.name || senderPhone,
    };
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: avail } = await supabase
    .from("teacher_availability")
    .select("day_of_week, start_time, end_time")
    .eq("user_id", userId);
  const { data: allStudents } = await supabase
    .from("students")
    .select("lesson_day, lesson_time")
    .eq("user_id", userId);

  const occupied = (allStudents ?? [])
    .filter((s) => s.lesson_day !== null && s.lesson_time)
    .map((s) => ({
      day: parseInt(String(s.lesson_day), 10),
      time: String(s.lesson_time).slice(0, 5),
    }));
  const free = computeFreeSlots(avail ?? [], occupied).slice(0, 4);

  if (free.length === 0) {
    return {
      reply: "כרגע אין שעות פנויות מתאימות. המורה יחזור אליך לתיאום 🙏",
      action: "reschedule_no_slots",
      who: student.name,
    };
  }

  // Store the pending request (replace any previous open one for this student).
  await supabase
    .from("reschedule_requests")
    .delete()
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection");
  await supabase.from("reschedule_requests").insert({
    user_id: userId,
    student_id: student.id ?? "",
    student_phone: senderPhone,
    options: free,
    status: "pending_selection",
  });

  const lines = free.map(
    (s: FreeSlot, i: number) => `${i + 1}. ${slotLabel(s)}`,
  );
  return {
    reply:
      "אלה השעות הפנויות. השב במספר האפשרות שמתאימה לך:\n" + lines.join("\n"),
    action: "reschedule_offered",
    who: student.name,
  };
}
```

- [ ] **Step 3: Route the reschedule intent through it**

In the intent branch, replace the reschedule path so it calls `handleReschedule`. Where the code currently does `reply = REPLIES[intent]`, special-case reschedule alongside cancel:

```ts
if (intent === "cancel") {
  const r = await handleCancel(senderPhone);
  reply = r.reply;
  action = r.action;
  who = r.who;
} else if (intent === "reschedule") {
  const r = await handleReschedule(senderPhone);
  reply = r.reply;
  action = r.action;
  who = r.who;
} else {
  reply = REPLIES[intent];
  action = intent;
}
```

- [ ] **Step 4: Deploy** (USER) — `deploy-tempo.ps1`.

- [ ] **Step 5: Manual test**

Ensure the teacher has availability set (Settings → שעות זמינות) and at least one free hour. From the tester phone send "אפשר להזיז את השיעור?". Expect a numbered list of open slots. Verify a row:

```sql
select student_phone, status, options from reschedule_requests order by created_at desc limit 3;
```

Expected: a `pending_selection` row with the offered `options`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(wa): offer free slots on reschedule request"
```

---

### Task 4: Handle the student's slot pick

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts`

**Interfaces:**

- Consumes: the `reschedule_requests` row from Task 3; runs BEFORE intent classification so a digit is read as a pick, not a new intent.

- [ ] **Step 1: Add a pick handler** (near `handleReschedule`)

```ts
async function handleReschedulePick(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: reqRow } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection")
    .maybeSingle();
  if (!reqRow) return null; // no open request → not a pick

  const digit = parseInt(text.trim(), 10);
  const options = (reqRow.options ?? []) as { day: number; time: string }[];
  if (isNaN(digit) || digit < 1 || digit > options.length) {
    const lines = options.map((s, i) => `${i + 1}. ${slotLabel(s)}`);
    return {
      reply: "לא הבנתי את הבחירה. השב במספר מהרשימה:\n" + lines.join("\n"),
      action: "reschedule_pick_invalid",
      who: senderPhone,
    };
  }

  const chosen = options[digit - 1];
  await supabase
    .from("reschedule_requests")
    .update({
      selected_option: chosen,
      status: "pending_approval",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reqRow.id);

  return {
    reply: `בחרת ${slotLabel(chosen)}. העברנו למורה לאישור, נעדכן אותך 🙏`,
    action: "reschedule_picked",
    who: senderPhone,
  };
}
```

- [ ] **Step 2: Check for a pick before classifying**

Right after `senderPhone`/`text` are known and the `incoming` log, and before the intent classification block, add:

```ts
const pick = await handleReschedulePick(senderPhone, text);
if (pick) {
  await logToDb(pick.who, pick.action, text);
  try {
    await sendMetaReply(token, phoneNumberId, senderPhone, pick.reply);
    await logToDb(pick.who, `${pick.action}_reply`, pick.reply);
  } catch (err) {
    await logToDb(pick.who, "auto_reply_error", (err as Error).message);
  }
  return new Response("OK", { status: 200 });
}
```

(Ensure `token`/`phoneNumberId` are read before this block; move their `Deno.env.get` up if needed.)

- [ ] **Step 3: Deploy** (USER) — `deploy-tempo.ps1`.

- [ ] **Step 4: Manual test**

Continue the Task 3 conversation: reply "1" from the tester phone. Expect "בחרת יום … העברנו למורה לאישור". Verify:

```sql
select status, selected_option from reschedule_requests order by updated_at desc limit 1;
```

Expected: `status='pending_approval'` with the chosen `selected_option`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(wa): handle student reschedule slot pick"
```

---

## Self-Review

- **Spec coverage (Layer 2a):** free-slot computation (DB, no calendar) ✅ (T2); offer on reschedule ✅ (T3); capture pick → pending_approval ✅ (T4). Teacher approval + confirmation message + swaps = Layer 2b / Layer 3.
- **Placeholders:** none. T4 Step 2 notes to hoist `token`/`phoneNumberId` reads above the pick block — a concrete wiring instruction, not a placeholder.
- **Type consistency:** `FreeSlot {day,time}` used in `computeFreeSlots`, `slotLabel`, the offer, and stored `options`; the pick reads the same shape from `options`. `student_phone` = normalized sender throughout; matches the `reschedule_requests` unique index on `(user_id, student_phone) WHERE status='pending_selection'`.
- **Open item for Layer 2b:** the teacher's later approval confirmation to the student may fall outside the 24h window → will need a `reschedule_confirmed` template.
