# Swap Engine (Scheduling Layer 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When no free slot fits a rescheduling student, the bot captures the student's free-text availability, finds another student who could swap, coordinates the swap over WhatsApp, and lets the teacher approve the final plan in-app.

**Architecture:** Extends the existing reschedule flow. Inbound messages hit `whatsapp-webhook`; a new pre-classify handler routes availability replies and swap-partner replies. Pure scheduling/AI logic lives in `_shared/schedule.ts` and a new `_shared/availability.ts` (both unit-tested). Timeouts and final swap application run in the cron `send-reminders` function. The teacher's approval UI lives in the React app's Activity tab.

**Tech Stack:** Deno/TypeScript Edge Functions, Supabase Postgres, Meta WhatsApp Cloud API (v21.0), Haiku (`claude-haiku-4-5-20251001`), React 19 + Tailwind.

## Global Constraints

- All student-facing text is **Hebrew**, RTL. No English inside Hebrew sentences.
- Availability parsing uses **Haiku** (`claude-haiku-4-5-20251001`).
- `student_id` is always **text**.
- One-hop swaps only (v1). No multi-hop cascades.
- Swap autonomy is per-student via `auto_swap_ok` (default **false**): if false, the teacher approves before the bot contacts the partner.
- Decline or 24h silence → try next candidate → if none, notify teacher + original student.
- **Proactive contact requires a template.** The swap partner is usually outside the 24h customer-service window, so the _first_ message to a partner MUST use an approved template (`sendTemplate`). Replies to a student who just messaged us stay within the window and use plain text (`sendText`). A new Meta **Utility** template `swap_request` (Hebrew) must be approved before Task 6 ships — body: `היי {{1}}, נשמח לדעת אם אפשר להזיז את השיעור שלך מ{{2}}. זה יעזור לתלמיד אחר להשתבץ. אם מתאים, כתבו לנו מתי נוח לכם ונציע מועד חדש.` with params `[greeting, currentSlotLabel]`.
- Edge Functions use the service-role key (bypass RLS). All new tables/columns already sit under existing RLS; no policy changes needed.
- Tests are Deno tests (`Deno.test`). Deno is not installed on the dev machine — write tests as part of each task; run them in CI/Supabase or after installing Deno.

## File Structure

- `supabase/migrations/swap_engine.sql` — **Create.** `students.auto_swap_ok`; swap columns on `reschedule_requests`.
- `supabase/functions/_shared/availability.ts` — **Create.** Haiku free-text → structured availability windows. Pure prompt builder + parser + API call.
- `supabase/functions/_shared/availability.test.ts` — **Create.** Unit tests for the parser.
- `supabase/functions/_shared/schedule.ts` — **Modify.** Add `AvailabilityWindow`, `SwapCandidate`, `slotFitsAvailability`, `findSwapCandidates`, `slotsFittingAvailability`.
- `supabase/functions/_shared/schedule.test.ts` — **Modify.** Tests for the new swap logic.
- `supabase/functions/whatsapp-webhook/index.ts` — **Modify.** Ask availability in `handleReschedule`; add `handleAvailabilityReply` and `handleSwapPartnerReply`, wired before classification.
- `supabase/functions/send-reminders/index.ts` — **Modify.** Actions `swap_contact_approved` and `swap_approved`; a cron sweep for expired `awaiting_swap_partner` requests.
- `src/App.jsx` — **Modify.** `auto_swap_ok` toggle in StudentForm + mapping; swap cards in ActivityView.

## Status vocabulary (`reschedule_requests.status`)

Free-text column — no enum migration. Values used:
`pending_selection` → `pending_approval` (reschedule) → `approved` / `rejected`, plus swap states:
`pending_contact_approval` (teacher must OK contacting partner) → `awaiting_swap_partner` (partner messaged, 24h clock) → `pending_approval` with `kind='swap'` (full plan awaits teacher) → `approved` / `failed`.

---

### Task 1: Data model migration

**Files:**

- Create: `supabase/migrations/swap_engine.sql`

**Interfaces:**

- Produces: `students.auto_swap_ok boolean`; `reschedule_requests` gains `kind text`, `student_availability jsonb`, `swap_target_student_id text`, `swap_target_slot jsonb`, `swap_candidate_ids jsonb`, `deadline_at timestamptz`.

- [ ] **Step 1: Write the migration**

```sql
-- Swap engine (Scheduling Layer 2) schema additions.
-- Run in: Supabase Dashboard → SQL Editor (clear the editor first).

-- Per-student consent for the bot to contact them for a swap without the
-- teacher approving the contact first.
alter table students
  add column if not exists auto_swap_ok boolean not null default false;

-- Swap lifecycle fields on the existing reschedule_requests table.
alter table reschedule_requests
  add column if not exists kind text not null default 'reschedule',      -- 'reschedule' | 'swap'
  add column if not exists student_availability jsonb,                    -- AvailabilityWindow[]
  add column if not exists swap_target_student_id text,                   -- the partner being asked
  add column if not exists swap_target_slot jsonb,                        -- FreeSlot the partner will move to
  add column if not exists swap_candidate_ids jsonb not null default '[]',-- remaining SwapCandidate[]
  add column if not exists deadline_at timestamptz;                       -- 24h decline/timeout clock

-- Fast lookup of a partner's active swap request by their phone.
create index if not exists idx_reschedule_swap_partner
  on reschedule_requests (user_id, swap_target_student_id, status);
```

- [ ] **Step 2: Apply it**

Run the SQL in the Supabase SQL editor. Verify no error and that `students` now lists `auto_swap_ok`:

```sql
select column_name from information_schema.columns
where table_name = 'students' and column_name = 'auto_swap_ok';
```

Expected: one row.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/swap_engine.sql
git commit -m "feat(swap): data model for the swap engine"
```

---

### Task 2: Availability parser (`availability.ts`)

**Files:**

- Create: `supabase/functions/_shared/availability.ts`
- Test: `supabase/functions/_shared/availability.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `interface AvailabilityWindow { day: number; start: string; end: string }`; `buildAvailabilityPrompt(text: string): string`; `parseAvailability(raw: string): AvailabilityWindow[]`; `extractAvailability(apiKey: string, text: string): Promise<AvailabilityWindow[]>`.

- [ ] **Step 1: Write the failing test**

````ts
// supabase/functions/_shared/availability.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseAvailability } from "./availability.ts";

Deno.test("parseAvailability reads a clean JSON array", () => {
  const raw =
    '[{"day":1,"start":"16:00","end":"20:00"},{"day":3,"start":"08:00","end":"12:00"}]';
  assertEquals(parseAvailability(raw), [
    { day: 1, start: "16:00", end: "20:00" },
    { day: 3, start: "08:00", end: "12:00" },
  ]);
});

Deno.test("parseAvailability tolerates surrounding prose/code fences", () => {
  const raw = 'בטח:\n```json\n[{"day":0,"start":"09:00","end":"11:00"}]\n```';
  assertEquals(parseAvailability(raw), [
    { day: 0, start: "09:00", end: "11:00" },
  ]);
});

Deno.test("parseAvailability drops malformed entries", () => {
  const raw =
    '[{"day":9,"start":"16:00","end":"20:00"},{"day":2,"start":"bad","end":"12:00"},{"day":2,"start":"10:00","end":"12:00"}]';
  assertEquals(parseAvailability(raw), [
    { day: 2, start: "10:00", end: "12:00" },
  ]);
});

Deno.test("parseAvailability returns [] on junk", () => {
  assertEquals(parseAvailability("אין לי מושג"), []);
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/availability.test.ts`
Expected: FAIL — `availability.ts` / `parseAvailability` not found.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/availability.ts
/**
 * availability.ts — turn a student's free-text availability ("פנוי בימי שני
 * אחרי 4") into structured weekly windows via Haiku. Pure prompt + parser are
 * separated from the API call so they can be unit-tested without a network.
 */

export interface AvailabilityWindow {
  day: number; // 0=Sunday … 6=Saturday
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

const MODEL = "claude-haiku-4-5-20251001";
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Hebrew prompt: extract weekly availability windows as strict JSON. */
export function buildAvailabilityPrompt(text: string): string {
  return [
    "התלמיד כתב מתי הוא פנוי לשיעור. חלץ את החלונות השבועיים.",
    "ענה אך ורק במערך JSON, בלי טקסט נוסף, בפורמט:",
    '[{"day":<0-6>,"start":"HH:MM","end":"HH:MM"}]',
    "day: 0=ראשון, 1=שני, 2=שלישי, 3=רביעי, 4=חמישי, 5=שישי, 6=שבת.",
    "שעות בפורמט 24 שעות. אם אין מידע ברור, החזר [].",
    "",
    `הודעה: "${text}"`,
  ].join("\n");
}

/** Extract the first JSON array in the text and validate each window. */
export function parseAvailability(raw: string): AvailabilityWindow[] {
  const match = (raw || "").match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((w): w is AvailabilityWindow => {
    const o = w as Record<string, unknown>;
    return (
      typeof o?.day === "number" &&
      o.day >= 0 &&
      o.day <= 6 &&
      typeof o?.start === "string" &&
      TIME_RE.test(o.start) &&
      typeof o?.end === "string" &&
      TIME_RE.test(o.end)
    );
  });
}

/** Call Haiku to parse availability. Returns [] on any API/parse failure. */
export async function extractAvailability(
  apiKey: string,
  text: string,
): Promise<AvailabilityWindow[]> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: buildAvailabilityPrompt(text) }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return parseAvailability(data?.content?.[0]?.text ?? "");
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/availability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/availability.ts supabase/functions/_shared/availability.test.ts
git commit -m "feat(swap): Haiku availability parser"
```

---

### Task 3: Swap candidate logic (`schedule.ts`)

**Files:**

- Modify: `supabase/functions/_shared/schedule.ts`
- Test: `supabase/functions/_shared/schedule.test.ts`

**Interfaces:**

- Consumes: `FreeSlot`, `DEFAULT_SLOT_MINUTES`, `computeFreeSlots` (existing); `AvailabilityWindow` (Task 2, re-declared locally to avoid a cross-file import cycle — keep the shape identical).
- Produces: `interface SwapCandidate { studentId: string; slot: FreeSlot }`; `slotFitsAvailability(slot: FreeSlot, windows: AvailabilityWindow[], slotMinutes?: number): boolean`; `slotsFittingAvailability(free: FreeSlot[], windows, slotMinutes?): FreeSlot[]`; `findSwapCandidates(availability, occupied, reschedulingStudentId, studentAvailability, slotMinutes?, autoSwapIds?): SwapCandidate[]` where `occupied: { day: number; time: string; studentId: string }[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to supabase/functions/_shared/schedule.test.ts
import { findSwapCandidates, slotFitsAvailability } from "./schedule.ts";

Deno.test("slotFitsAvailability: slot inside a window fits", () => {
  const windows = [{ day: 1, start: "16:00", end: "20:00" }];
  assertEquals(slotFitsAvailability({ day: 1, time: "16:00" }, windows), true);
  assertEquals(slotFitsAvailability({ day: 1, time: "19:15" }, windows), true); // 19:15-20:00
});

Deno.test(
  "slotFitsAvailability: slot spilling past the window does not fit",
  () => {
    const windows = [{ day: 1, start: "16:00", end: "20:00" }];
    assertEquals(
      slotFitsAvailability({ day: 1, time: "19:30" }, windows),
      false,
    ); // ends 20:15
    assertEquals(
      slotFitsAvailability({ day: 2, time: "16:00" }, windows),
      false,
    ); // wrong day
  },
);

Deno.test(
  "findSwapCandidates: returns students whose slot fits, auto-swap first",
  () => {
    const avail = [{ day_of_week: 1, start_time: "16:00", end_time: "20:00" }];
    const occupied = [
      { day: 1, time: "16:00", studentId: "dana" }, // the rescheduling student
      { day: 1, time: "17:00", studentId: "yossi" }, // fits dana's availability
      { day: 1, time: "19:30", studentId: "noa" }, // spills past window → excluded
      { day: 2, time: "16:00", studentId: "gil" }, // wrong day → excluded
    ];
    const danaAvailability = [{ day: 1, start: "16:45", end: "18:30" }];
    const candidates = findSwapCandidates(
      avail,
      occupied,
      "dana",
      danaAvailability,
      45,
      new Set(["yossi"]),
    );
    assertEquals(candidates, [
      { studentId: "yossi", slot: { day: 1, time: "17:00" } },
    ]);
  },
);

Deno.test(
  "findSwapCandidates: none when no free slot exists for a partner to move to",
  () => {
    // Availability window holds exactly two 45-min slots, both occupied → nowhere to move.
    const avail = [{ day_of_week: 1, start_time: "16:00", end_time: "17:30" }];
    const occupied = [
      { day: 1, time: "16:00", studentId: "dana" },
      { day: 1, time: "16:45", studentId: "yossi" },
    ];
    const danaAvailability = [{ day: 1, start: "16:00", end: "17:30" }];
    assertEquals(
      findSwapCandidates(avail, occupied, "dana", danaAvailability, 45),
      [],
    );
  },
);
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test supabase/functions/_shared/schedule.test.ts`
Expected: FAIL — `findSwapCandidates` / `slotFitsAvailability` not exported.

- [ ] **Step 3: Implement in `schedule.ts`** (append after `slotLabel`)

```ts
// ─── Swap-candidate logic (reschedule Layer 2) ──────────────────────────────────

export interface AvailabilityWindow {
  day: number; // 0=Sun … 6=Sat
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface SwapCandidate {
  studentId: string;
  slot: FreeSlot;
}

function hhmmToMin(t: string): number {
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** True if the whole [time, time+slotMinutes) fits within one availability window. */
export function slotFitsAvailability(
  slot: FreeSlot,
  windows: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): boolean {
  const start = hhmmToMin(slot.time);
  const end = start + slotMinutes;
  return windows.some(
    (w) =>
      w.day === slot.day &&
      start >= hhmmToMin(w.start) &&
      end <= hhmmToMin(w.end),
  );
}

/** Subset of free slots that fall within the given availability windows. */
export function slotsFittingAvailability(
  free: FreeSlot[],
  windows: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): FreeSlot[] {
  return free.filter((s) => slotFitsAvailability(s, windows, slotMinutes));
}

/**
 * One-hop swap candidates: students whose current slot fits the rescheduling
 * student's availability AND for whom at least one free slot exists to move to.
 * Candidates with `auto_swap_ok` (in autoSwapIds) are returned first.
 */
export function findSwapCandidates(
  availability: { day_of_week: number; start_time: string; end_time: string }[],
  occupied: { day: number; time: string; studentId: string }[],
  reschedulingStudentId: string,
  studentAvailability: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
  autoSwapIds: Set<string> = new Set(),
): SwapCandidate[] {
  const free = computeFreeSlots(
    availability,
    occupied.map((o) => ({ day: o.day, time: o.time })),
    slotMinutes,
  );
  if (free.length === 0) return []; // nowhere for a partner to move

  const candidates = occupied
    .filter(
      (o) =>
        o.studentId !== reschedulingStudentId &&
        slotFitsAvailability(
          { day: o.day, time: o.time },
          studentAvailability,
          slotMinutes,
        ),
    )
    .map((o) => ({
      studentId: o.studentId,
      slot: { day: o.day, time: o.time },
    }));

  return candidates.sort(
    (a, b) =>
      Number(autoSwapIds.has(b.studentId)) -
      Number(autoSwapIds.has(a.studentId)),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/schedule.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/schedule.ts supabase/functions/_shared/schedule.test.ts
git commit -m "feat(swap): one-hop swap candidate finding"
```

---

### Task 4: Ask availability when offering slots

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts` (`handleReschedule`, ~line 232–260)

**Interfaces:**

- Consumes: existing `handleReschedule`, `slotLabel`, `computeFreeSlots`, `reschedule_requests` insert.
- Produces: the offer message now also invites free-text availability; the inserted request carries `kind:'reschedule'`.

- [ ] **Step 1: Read the current offer block** in `handleReschedule` (the part that builds the numbered list, replies, and inserts the `reschedule_requests` row). Confirm the insert sets `status:'pending_selection'`, `options`, `student_id`, `student_phone`.

- [ ] **Step 2: Update the reply text and insert** so the message appends the availability invite and the row records `kind`:

```ts
const lines = free.map((s, i) => `${i + 1}. ${slotLabel(s)}`);
const reply =
  "אפשר לתאם מחדש 🙏 הנה כמה מועדים פנויים:\n" +
  lines.join("\n") +
  "\n\nהשב במספר שמתאים, ואם אף אחד לא מתאים — כתוב לי מתי כן נוח לך ואבדוק אפשרות החלפה.";

await supabase.from("reschedule_requests").insert({
  user_id: userId,
  student_id: student.id,
  student_phone: senderPhone,
  options: free,
  kind: "reschedule",
  status: "pending_selection",
});

return { reply, action: "reschedule_offered", who: student.name };
```

- [ ] **Step 3: Manual verification note**

Deno can't run the full webhook locally. Verification is end-to-end in Task 9. For now confirm the file typechecks: `deno check supabase/functions/whatsapp-webhook/index.ts` (expected: no errors).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(swap): invite free-text availability in reschedule offer"
```

---

### Task 5: Handle the availability reply → start the swap hunt

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts` (new `handleAvailabilityReply`, wired before `classifyIntent`)

**Interfaces:**

- Consumes: `extractAvailability` (Task 2), `findSwapCandidates` + `slotsFittingAvailability` (Task 3), `sendText`/`sendTemplate` semantics, `reschedule_requests`.
- Produces: `handleAvailabilityReply(senderPhone, text): Promise<{ reply: string; action: string; who: string } | null>`; sets request `student_availability`, then either re-offers a now-fitting free slot, or transitions to `pending_contact_approval` (manual) / `awaiting_swap_partner` (auto).

- [ ] **Step 1: Add imports** at the top of the webhook file:

```ts
import {
  extractAvailability,
  type AvailabilityWindow,
} from "../_shared/availability.ts";
import {
  computeFreeSlots,
  DEFAULT_SLOT_MINUTES,
  findSwapCandidates,
  type FreeSlot,
  hoursUntilNextLesson,
  slotLabel,
  slotsFittingAvailability,
  type SwapCandidate,
} from "../_shared/schedule.ts";
import { sendText, sendTemplate } from "../_shared/meta.ts";
```

- [ ] **Step 2: Add a constant** for the swap-request template near `REPLIES`:

```ts
const SWAP_REQUEST_TEMPLATE = "swap_request";
const TEMPLATE_LANG = "he";
```

- [ ] **Step 3: Implement `handleAvailabilityReply`** (place after `handleReschedulePick`):

```ts
/**
 * The student is mid-reschedule and sent free text instead of a slot number.
 * Parse it as availability, then hunt for a one-hop swap. Returns null if the
 * sender has no active pending_selection request (so the caller keeps routing).
 */
async function handleAvailabilityReply(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection")
    .maybeSingle();
  if (!req) return null;

  const windows = await extractAvailability(apiKey, text);
  if (windows.length === 0) {
    return {
      reply:
        'לא הצלחתי להבין מתי נוח לך. תוכל לכתוב למשל: "פנוי בימי שני אחרי 16:00"?',
      action: "availability_unparsed",
      who: senderPhone,
    };
  }

  await supabase
    .from("reschedule_requests")
    .update({
      student_availability: windows,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.id);

  // Load schedule inputs.
  const [{ data: avail }, { data: allStudents }, { data: settings }] =
    await Promise.all([
      supabase
        .from("teacher_availability")
        .select("day_of_week, start_time, end_time")
        .eq("user_id", userId),
      supabase
        .from("students")
        .select(
          "id, lesson_day, lesson_time, auto_swap_ok, name, phone, contact_phone",
        )
        .eq("user_id", userId),
      supabase
        .from("user_settings")
        .select("lesson_duration_minutes")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
  const slotMinutes = settings?.lesson_duration_minutes ?? DEFAULT_SLOT_MINUTES;
  const occupied = (allStudents ?? [])
    .filter((s) => s.lesson_day !== null && s.lesson_time)
    .map((s) => ({
      day: parseInt(String(s.lesson_day), 10),
      time: String(s.lesson_time).slice(0, 5),
      studentId: String(s.id),
    }));

  // First: is there now a free slot that fits their stated availability?
  const free = computeFreeSlots(
    avail ?? [],
    occupied.map((o) => ({ day: o.day, time: o.time })),
    slotMinutes,
  );
  const fitting = slotsFittingAvailability(free, windows, slotMinutes).slice(
    0,
    4,
  );
  if (fitting.length > 0) {
    await supabase
      .from("reschedule_requests")
      .update({ options: fitting, updated_at: new Date().toISOString() })
      .eq("id", req.id);
    const lines = fitting.map((s, i) => `${i + 1}. ${slotLabel(s)}`);
    return {
      reply:
        "מצאתי מועדים פנויים שמתאימים לך:\n" +
        lines.join("\n") +
        "\nהשב במספר שמתאים.",
      action: "availability_free_offer",
      who: senderPhone,
    };
  }

  // Else: hunt for a swap partner.
  const autoIds = new Set(
    (allStudents ?? []).filter((s) => s.auto_swap_ok).map((s) => String(s.id)),
  );
  const candidates = findSwapCandidates(
    avail ?? [],
    occupied,
    req.student_id,
    windows,
    slotMinutes,
    autoIds,
  );
  if (candidates.length === 0) {
    await supabase
      .from("reschedule_requests")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", req.id);
    return {
      reply:
        "בדקתי ולא נמצאה כרגע אפשרות החלפה מתאימה. המורה יחזור אליך לתיאום ידני 🙏",
      action: "swap_no_candidates",
      who: senderPhone,
    };
  }

  const first = candidates[0];
  const partner = (allStudents ?? []).find(
    (s) => String(s.id) === first.studentId,
  );
  const partnerAuto = autoIds.has(first.studentId);
  await supabase
    .from("reschedule_requests")
    .update({
      kind: "swap",
      selected_option: first.slot, // the slot the rescheduling student will take
      swap_target_student_id: first.studentId,
      swap_candidate_ids: candidates,
      status: partnerAuto
        ? "awaiting_swap_partner"
        : "pending_contact_approval",
      deadline_at: partnerAuto
        ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.id);

  if (partnerAuto && partner) {
    // Partner consented in advance → contact now with a template.
    const token = Deno.env.get("WHAPI_TOKEN") ?? "";
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
    const partnerPhone = partner.phone || partner.contact_phone;
    try {
      await sendTemplate(
        token,
        phoneNumberId,
        partnerPhone,
        SWAP_REQUEST_TEMPLATE,
        TEMPLATE_LANG,
        [partner.name || "היי", slotLabel(first.slot)],
      );
      await logToDb(
        partner.name || partnerPhone,
        "swap_partner_contacted",
        slotLabel(first.slot),
      );
    } catch (err) {
      await logToDb(
        partner.name || partnerPhone,
        "swap_contact_error",
        (err as Error).message,
      );
    }
    return {
      reply: "תודה! בודק אפשרות החלפה מול תלמיד אחר ואעדכן אותך בהקדם 🙏",
      action: "swap_hunt_auto",
      who: senderPhone,
    };
  }

  return {
    reply: "תודה! בודק אפשרות החלפה ואעדכן אותך בהקדם 🙏",
    action: "swap_hunt_pending_teacher",
    who: senderPhone,
  };
}
```

- [ ] **Step 4: Wire it into the router** — in the request handler, right after the `handleReschedulePick` block (webhook `~line 467`), add:

```ts
// Mid-reschedule free text → availability + swap hunt (before classification).
const availReply = await handleAvailabilityReply(senderPhone, text);
if (availReply) {
  await logToDb(availReply.who, availReply.action, text);
  try {
    await sendMetaReply(token, phoneNumberId, senderPhone, availReply.reply);
    await logToDb(
      availReply.who,
      `${availReply.action}_reply`,
      availReply.reply,
    );
  } catch (err) {
    await logToDb(availReply.who, "auto_reply_error", (err as Error).message);
  }
  return new Response("OK", { status: 200 });
}
```

- [ ] **Step 5: Typecheck**

Run: `deno check supabase/functions/whatsapp-webhook/index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(swap): parse availability and start the swap hunt"
```

---

### Task 6: Handle the swap partner's reply → propose the plan

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts` (new `handleSwapPartnerReply`, wired before classification)

**Interfaces:**

- Consumes: `extractAvailability`, `computeFreeSlots`, `slotsFittingAvailability`, `reschedule_requests` (status `awaiting_swap_partner`), `findStudentByPhone`.
- Produces: `handleSwapPartnerReply(senderPhone, text): Promise<{ reply; action; who } | null>`; on acceptance sets `swap_target_slot` + `status:'pending_approval'` (kind `swap`).

- [ ] **Step 1: Implement `handleSwapPartnerReply`** (after `handleAvailabilityReply`):

```ts
/**
 * A student we asked to swap has replied. If we can find a free slot that fits
 * their availability, record it and hand the full plan to the teacher. Returns
 * null if this sender is not an active swap partner.
 */
async function handleSwapPartnerReply(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const partner = await findStudentByPhone(senderPhone);
  if (!partner) return null;
  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("swap_target_student_id", partner.id)
    .eq("status", "awaiting_swap_partner")
    .maybeSingle();
  if (!req) return null;

  const windows = await extractAvailability(apiKey, text);
  if (windows.length === 0) {
    return {
      reply: 'תודה על התשובה 🙏 תוכל לכתוב מתי נוח לך? למשל: "שלישי בבוקר".',
      action: "swap_partner_unparsed",
      who: partner.name,
    };
  }

  const [{ data: avail }, { data: allStudents }, { data: settings }] =
    await Promise.all([
      supabase
        .from("teacher_availability")
        .select("day_of_week, start_time, end_time")
        .eq("user_id", userId),
      supabase
        .from("students")
        .select("id, lesson_day, lesson_time")
        .eq("user_id", userId),
      supabase
        .from("user_settings")
        .select("lesson_duration_minutes")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
  const slotMinutes = settings?.lesson_duration_minutes ?? DEFAULT_SLOT_MINUTES;
  const occupied = (allStudents ?? [])
    .filter((s) => s.lesson_day !== null && s.lesson_time)
    .map((s) => ({
      day: parseInt(String(s.lesson_day), 10),
      time: String(s.lesson_time).slice(0, 5),
    }));
  const free = computeFreeSlots(avail ?? [], occupied, slotMinutes);
  const target = slotsFittingAvailability(free, windows, slotMinutes)[0];
  if (!target) {
    return {
      reply:
        "תודה! כרגע לא מצאתי מועד פנוי שמתאים לך. המורה יבדוק ויחזור אליך 🙏",
      action: "swap_partner_no_slot",
      who: partner.name,
    };
  }

  await supabase
    .from("reschedule_requests")
    .update({
      swap_target_slot: target,
      status: "pending_approval",
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.id);

  return {
    reply: "מעולה, תודה! מעביר את ההצעה למורה לאישור סופי ואעדכן אותך 🙏",
    action: "swap_partner_accepted",
    who: partner.name,
  };
}
```

- [ ] **Step 2: Wire it in** — immediately before the `handleAvailabilityReply` block in the router:

```ts
// Is this sender a swap partner we're waiting on? (before classification)
const partnerReply = await handleSwapPartnerReply(senderPhone, text);
if (partnerReply) {
  await logToDb(partnerReply.who, partnerReply.action, text);
  try {
    await sendMetaReply(token, phoneNumberId, senderPhone, partnerReply.reply);
    await logToDb(
      partnerReply.who,
      `${partnerReply.action}_reply`,
      partnerReply.reply,
    );
  } catch (err) {
    await logToDb(partnerReply.who, "auto_reply_error", (err as Error).message);
  }
  return new Response("OK", { status: 200 });
}
```

- [ ] **Step 3: Typecheck**

Run: `deno check supabase/functions/whatsapp-webhook/index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(swap): handle swap partner reply and propose plan to teacher"
```

---

### Task 7: Server actions — approve contact, finalize swap, timeout sweep

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: existing action-router pattern (`action === "reschedule_approved"` block), `sendTemplate`, `RESCHEDULE_CONFIRMED_TEMPLATE`, `TEMPLATE_LANG`, `slotLabel`, `rowToStudent`, `resolveReminderTargets`, `buildRescheduleConfirmParams`.
- Produces: actions `swap_contact_approved` (send the template, arm the 24h clock) and `swap_approved` (apply the two-way slot swap, confirm both students); a cron sweep advancing expired `awaiting_swap_partner` requests.

- [ ] **Step 1: Add `swap_contact_approved`** after the `reschedule_approved` block. It sends the swap-request template to the current partner and arms the clock:

```ts
// ── Action: teacher approved contacting a swap partner ─────────────────────
if (action === "swap_contact_approved" && requestedUserId && requestId) {
  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("id", requestId)
    .eq("user_id", requestedUserId)
    .maybeSingle();
  if (!req || !req.swap_target_student_id) {
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const { data: partner } = await supabase
    .from("students")
    .select("*")
    .eq("id", req.swap_target_student_id)
    .maybeSingle();
  let sent = 0;
  if (partner) {
    const partnerPhone = partner.phone || partner.contact_phone;
    try {
      await sendTemplate(
        metaToken,
        phoneNumberId,
        partnerPhone,
        "swap_request",
        TEMPLATE_LANG,
        [partner.name || "היי", slotLabel(req.selected_option)],
      );
      sent = 1;
    } catch (err) {
      console.error("swap contact failed:", (err as Error).message);
    }
  }
  await supabase
    .from("reschedule_requests")
    .update({
      status: "awaiting_swap_partner",
      deadline_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);
  return new Response(JSON.stringify({ ok: true, sent }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Add `swap_approved`** (the final two-way move):

```ts
// ── Action: teacher approved the full swap plan ────────────────────────────
if (action === "swap_approved" && requestedUserId && requestId) {
  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("id", requestId)
    .eq("user_id", requestedUserId)
    .maybeSingle();
  if (
    !req ||
    !req.selected_option ||
    !req.swap_target_slot ||
    !req.swap_target_student_id
  ) {
    return new Response(
      JSON.stringify({ ok: false, error: "incomplete plan" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
  const sMove = req.selected_option as { day: number; time: string }; // rescheduling student → partner's old slot
  const pMove = req.swap_target_slot as { day: number; time: string }; // partner → chosen free slot

  await supabase
    .from("students")
    .update({ lesson_day: String(sMove.day), lesson_time: sMove.time })
    .eq("id", req.student_id);
  await supabase
    .from("students")
    .update({ lesson_day: String(pMove.day), lesson_time: pMove.time })
    .eq("id", req.swap_target_student_id);
  await supabase
    .from("reschedule_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", requestId);

  let sent = 0;
  for (const [id, slot] of [
    [req.student_id, sMove],
    [req.swap_target_student_id, pMove],
  ] as const) {
    const { data: stuRow } = await supabase
      .from("students")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!stuRow) continue;
    const student = rowToStudent(stuRow);
    const params = buildRescheduleConfirmParams(student, slotLabel(slot));
    for (const target of resolveReminderTargets(student)) {
      try {
        await sendTemplate(
          metaToken,
          phoneNumberId,
          target.phone,
          RESCHEDULE_CONFIRMED_TEMPLATE,
          TEMPLATE_LANG,
          params,
        );
        sent++;
      } catch (err) {
        console.error("swap confirm send failed:", (err as Error).message);
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, sent }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 3: Add the timeout sweep** inside the cron pass (near where the daily reminders run, before returning). It advances any expired `awaiting_swap_partner` to the next candidate, or fails:

```ts
// ── Sweep: expired swap-partner waits → next candidate or fail ─────────────
{
  const nowIso = new Date().toISOString();
  const { data: expired } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("status", "awaiting_swap_partner")
    .lt("deadline_at", nowIso);
  for (const req of expired ?? []) {
    const remaining = (
      (req.swap_candidate_ids ?? []) as {
        studentId: string;
        slot: { day: number; time: string };
      }[]
    ).filter((c) => c.studentId !== req.swap_target_student_id);
    if (remaining.length === 0) {
      await supabase
        .from("reschedule_requests")
        .update({ status: "failed", updated_at: nowIso })
        .eq("id", req.id);
      continue;
    }
    const next = remaining[0];
    const { data: partner } = await supabase
      .from("students")
      .select("*")
      .eq("id", next.studentId)
      .maybeSingle();
    const partnerAuto = partner?.auto_swap_ok === true;
    await supabase
      .from("reschedule_requests")
      .update({
        swap_target_student_id: next.studentId,
        selected_option: next.slot,
        swap_candidate_ids: remaining,
        swap_target_slot: null,
        status: partnerAuto
          ? "awaiting_swap_partner"
          : "pending_contact_approval",
        deadline_at: partnerAuto
          ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
          : null,
        updated_at: nowIso,
      })
      .eq("id", req.id);
    if (partnerAuto && partner) {
      try {
        await sendTemplate(
          metaToken,
          phoneNumberId,
          partner.phone || partner.contact_phone,
          "swap_request",
          TEMPLATE_LANG,
          [partner.name || "היי", slotLabel(next.slot)],
        );
      } catch (err) {
        console.error("next-candidate contact failed:", (err as Error).message);
      }
    }
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `deno check supabase/functions/send-reminders/index.ts`
Expected: no errors. (If `metaToken`/`phoneNumberId`/`TEMPLATE_LANG`/`RESCHEDULE_CONFIRMED_TEMPLATE` are scoped inside the handler, hoist the sweep to where they're in scope — verify names against the existing file.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat(swap): server actions for contact-approval, finalize, and timeout sweep"
```

---

### Task 8: `auto_swap_ok` toggle in the app

**Files:**

- Modify: `src/App.jsx` — `rowToStudent` (~255), `studentToDb` (~271), StudentForm initial state (~640) + edit-initial (~4741), StudentForm markup (after the "מעקב תשלום" block ~866).

**Interfaces:**

- Consumes: existing `set(field, value)` form helper and toggle markup pattern.
- Produces: `student.autoSwapOk` round-tripped to `students.auto_swap_ok`; a checkbox in the form.

- [ ] **Step 1: Map the column** — in `rowToStudent` add `autoSwapOk: row.auto_swap_ok ?? false,` and in `studentToDb` add `auto_swap_ok: student.autoSwapOk ?? false,`.

- [ ] **Step 2: Seed the form state** — in every student-form initial object that lists `reminderToStudent`/`billingToParent` (the new-student default ~640 and the edit-initial ~4741), add `autoSwapOk: <source>.autoSwapOk ?? false,`. Also include it in the `onSave` payload object (~676) as `autoSwapOk: form.autoSwapOk,`.

- [ ] **Step 3: Add the toggle markup** after the "מעקב תשלום" block:

```jsx
<div>
  <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
    החלפות
  </p>
  <label className="flex items-center gap-2 cursor-pointer bg-slate-800 rounded-xl p-3">
    <input
      type="checkbox"
      checked={form.autoSwapOk ?? false}
      onChange={(e) => set("autoSwapOk", e.target.checked)}
      className="w-4 h-4 accent-indigo-500 shrink-0"
    />
    <span className="text-slate-300 text-sm">
      אפשר לבוט לפנות לתלמיד להחלפת מועד בלי לשאול אותי קודם
    </span>
  </label>
</div>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(swap): per-student auto-swap toggle"
```

---

### Task 9: Swap approvals in the Activity tab

**Files:**

- Modify: `src/App.jsx` — ActivityView data load (~3763), actions (~3817), and the "בקשות תיאום מחדש" card block (~3846).

**Interfaces:**

- Consumes: existing `approveRes`/`rejectRes` fetch pattern, `slotText`, `resReqs` state.
- Produces: the pending list now includes `kind`, `status`, `swap_target_slot`, `swap_target_student_id`; two new actions `approveContact` (→ `swap_contact_approved`) and `approveSwap` (→ `swap_approved`); cards that render per status.

- [ ] **Step 1: Widen the query** at ~3763 to load both swap-relevant statuses and fields:

```jsx
const { data: reqs } = await supabase
  .from("reschedule_requests")
  .select(
    "id, student_id, kind, status, selected_option, swap_target_student_id, swap_target_slot",
  )
  .in("status", ["pending_approval", "pending_contact_approval"])
  .order("updated_at", { ascending: false });
```

- [ ] **Step 2: Add the two actions** next to `approveRes`/`rejectRes` (reuse the `send-reminders` fetch helper shape):

```jsx
async function approveContact(row) {
  setResReqs((p) => p.filter((x) => x.id !== row.id));
  await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-reminders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_AUTOMATION_SECRET}`,
      },
      body: JSON.stringify({
        action: "swap_contact_approved",
        userId,
        requestId: row.id,
      }),
    },
  );
}

async function approveSwap(row) {
  setResReqs((p) => p.filter((x) => x.id !== row.id));
  await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-reminders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_AUTOMATION_SECRET}`,
      },
      body: JSON.stringify({
        action: "swap_approved",
        userId,
        requestId: row.id,
      }),
    },
  );
}
```

- [ ] **Step 3: Render per status** — replace the single-line label + buttons inside the `resReqs.map(...)` with branching. A plain reschedule keeps `approveRes`; a `pending_contact_approval` uses `approveContact`; a `swap` `pending_approval` uses `approveSwap`:

```jsx
              <span className="text-slate-200">
                {row.status === "pending_contact_approval"
                  ? `לפנות לתלמיד להחלפת המועד ${slotText(row.selected_option)}?`
                  : row.kind === "swap"
                    ? `אישור החלפה: תלמיד עובר ל${slotText(row.swap_target_slot)}, ומתפנה ${slotText(row.selected_option)}`
                    : `בקשה למועד ${slotText(row.selected_option)}`}
              </span>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => rejectRes(row)} className="text-xs font-semibold text-red-400 border border-red-500/40 px-3 py-1.5 rounded-lg">דחה</button>
                <button
                  onClick={() =>
                    row.status === "pending_contact_approval"
                      ? approveContact(row)
                      : row.kind === "swap"
                        ? approveSwap(row)
                        : approveRes(row)
                  }
                  className="text-xs font-semibold text-white bg-indigo-600 px-3 py-1.5 rounded-lg"
                >
                  אשר
                </button>
              </div>
```

- [ ] **Step 4: Update the bell counter** (the `pendingCount` effect ~3968) to count both statuses:

```jsx
          .from("reschedule_requests")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending_approval", "pending_contact_approval"]),
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: End-to-end verification**

With a tester WhatsApp number: (1) send a reschedule request → receive slots + availability invite; (2) reply with availability that no free slot fits → confirm a swap partner is contacted (auto) or a contact-approval card appears (manual); (3) partner replies availability → a swap-approval card appears; (4) approve → both students' lesson slots update and both receive confirmation. Confirm each step lands in `tempo_automation_logs`.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(swap): teacher approval cards for swaps in the activity tab"
```

---

## Self-Review

- **Spec coverage:** availability capture (Tasks 4–5), Haiku parse (Task 2), one-hop candidate finding (Task 3), per-student `auto_swap_ok` (Tasks 1, 8), auto vs teacher-approved contact (Tasks 5, 7, 9), partner accept → teacher approval (Tasks 6, 9), decline/24h timeout → next candidate → fail (Task 7), both-students update + confirm (Task 7). Covered.
- **Out of scope (unchanged):** multi-hop cascades, Google Calendar, automatic billing adjustment, group lessons.
- **Type consistency:** `AvailabilityWindow` shape is identical in `availability.ts` and `schedule.ts`; `SwapCandidate` `{ studentId, slot }` is stored verbatim in `swap_candidate_ids` and re-read by the sweep (Task 7) and hunt (Task 5); `selected_option` = the slot the rescheduling student takes (the partner's old slot); `swap_target_slot` = the partner's new slot.
- **Prerequisite:** the `swap_request` Meta template must be approved before Task 6/7 send to partners.

```

```
