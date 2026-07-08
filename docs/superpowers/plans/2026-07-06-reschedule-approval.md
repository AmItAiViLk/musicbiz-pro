# Reschedule — Teacher Approval (Scheduling Layer 2b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the teacher approve or reject a pending reschedule in the app; approving updates the student's weekly slot and sends them a WhatsApp confirmation.

**Architecture:** The Activity tab lists `reschedule_requests` rows in `pending_approval`. Approve calls `send-reminders` with an action that updates the student's `lesson_day`/`lesson_time` to the chosen slot, marks the request `approved`, and sends the approved `reschedule_confirmed` template. Reject marks the request `rejected` in-app (no auto-message — the teacher handles it directly).

**Tech Stack:** Deno Edge Functions (TypeScript), Supabase, Meta WhatsApp Cloud API, React 19.

## Global Constraints

- Hebrew messages. `student_id` is text; `lesson_day` stored as a string index '0'–'6', `lesson_time` as 'HH:MM'.
- The confirmation is business-initiated (may be outside the 24h window) → requires the approved Meta template `reschedule_confirmed`.
- No Deno test runner locally; pure helpers via `deno test`, integration via app + WhatsApp + SQL.
- `reschedule_requests.selected_option` is `{ day: number, time: 'HH:MM' }`; statuses `pending_approval` → `approved` | `rejected`.
- send-reminders is authed by `AUTOMATION_SECRET`; the app calls it with `VITE_AUTOMATION_SECRET`.

---

## File Structure

- **Modify** `supabase/functions/_shared/messaging.ts` — `buildRescheduleConfirmParams`.
- **Modify** `supabase/functions/_shared/messaging.test.ts` — test it.
- **Modify** `supabase/functions/send-reminders/index.ts` — `reschedule_approved` action (update slot + send confirm).
- **Modify** `src/App.jsx` — pending reschedule approvals in the Activity tab (approve / reject).
- **Meta dashboard** — create the `reschedule_confirmed` template.

---

### Task 1: Confirmation template params (`messaging.ts`)

**Files:**

- Modify: `supabase/functions/_shared/messaging.ts`
- Test: `supabase/functions/_shared/messaging.test.ts`

**Interfaces:**

- Produces: `buildRescheduleConfirmParams(s: Student, slotText: string): string[]` → `[greeting, slotText]`.

- [ ] **Step 1: Failing test** (append to `messaging.test.ts`)

```ts
import { buildRescheduleConfirmParams } from "./messaging.ts";

Deno.test("reschedule confirm params = [greeting, slot]", () => {
  assertEquals(buildRescheduleConfirmParams(base, "יום שני 09:00"), [
    "דנה",
    "יום שני 09:00",
  ]);
});
```

- [ ] **Step 2: Run to verify it fails** — `deno test supabase/functions/_shared/messaging.test.ts`.

- [ ] **Step 3: Implement** (append to `messaging.ts`)

```ts
/** Params for the `reschedule_confirmed` template: {{1}}=greeting, {{2}}=slot label. */
export function buildRescheduleConfirmParams(
  s: Student,
  slotText: string,
): string[] {
  const { greeting } = getMsgParts(s, null);
  return [greeting, slotText];
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/messaging.ts supabase/functions/_shared/messaging.test.ts
git commit -m "feat(wa): reschedule confirmation template params"
```

---

### Task 2: Create the `reschedule_confirmed` Meta template

**Files:** none (Meta dashboard).

- [ ] **Step 1: Create** (USER, WhatsApp Manager → Create template)

Name `reschedule_confirmed`, Category **Utility**, Language **Hebrew**, Header empty, Body:

```
היי {{1}}, השיעור שלך תואם מחדש ל{{2}}. נתראה! 🎵
```

Samples: `{{1}}`=דנה, `{{2}}`=יום שני 09:00. Submit for review; note the exact approved name.

---

### Task 3: `reschedule_approved` action in `send-reminders`

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: `slotLabel` (schedule.ts), `buildRescheduleConfirmParams` (Task 1), `sendTemplate`, `resolveReminderTargets`, existing Meta config.
- Produces: POST `send-reminders` with `{ action: "reschedule_approved", userId, requestId }` → updates the student slot, marks approved, sends the template; returns `{ ok, sent }`.

- [ ] **Step 1: Imports + template constant**

Add to `send-reminders/index.ts`:

```ts
import { slotLabel } from "../_shared/schedule.ts"; // add to the existing schedule import
```

(Combine with the existing `{ hebrewMonthLabel, yearMonthKey }` import from schedule.ts.) Add `buildRescheduleConfirmParams` to the `messaging.ts` import list. Near the other template constants:

```ts
const RESCHEDULE_CONFIRMED_TEMPLATE = "reschedule_confirmed";
```

- [ ] **Step 2: Read the action fields**

Where the body is parsed, also read:

```ts
const requestId = body?.requestId ?? "";
```

- [ ] **Step 3: Handle the action** (near the `payment_reminder` action block)

```ts
if (action === "reschedule_approved" && requestedUserId && requestId) {
  const { data: reqRow } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("id", requestId)
    .eq("user_id", requestedUserId)
    .maybeSingle();
  if (!reqRow || !reqRow.selected_option) {
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const slot = reqRow.selected_option as { day: number; time: string };
  const { data: stuRow } = await supabase
    .from("students")
    .select("*")
    .eq("id", reqRow.student_id)
    .maybeSingle();

  // Move the student's weekly lesson to the chosen slot.
  await supabase
    .from("students")
    .update({
      lesson_day: String(slot.day),
      lesson_time: slot.time,
    })
    .eq("id", reqRow.student_id);
  await supabase
    .from("reschedule_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", requestId);

  let sent = 0;
  if (stuRow) {
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
        console.error(
          "reschedule confirm send failed:",
          (err as Error).message,
        );
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, sent }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 4: Deploy** (USER) — `deploy-tempo.ps1`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat(wa): approve reschedule -> update slot + confirm student"
```

---

### Task 4: Pending reschedule approvals in the Activity tab

**Files:**

- Modify: `src/App.jsx`

**Interfaces:**

- Consumes: `supabase`; the logged-in user id; `reschedule_requests` rows in `pending_approval`.

The Activity view (`ActivityView`) currently shows cancel/paid/reschedule events. Add an actionable "בקשות תיאום" section at the top.

- [ ] **Step 1: Pass the user id + slot labeller**

In `renderView()`, update the activity case: `<ActivityView supabase={supabase} userId={user.id} />` and change the signature to `function ActivityView({ supabase, userId })`. Add a slot labeller near `ACTIVITY_LABELS`:

```jsx
const RES_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const slotText = (o) => (o ? `יום ${RES_DAYS[o.day] ?? "?"} ${o.time}` : "");
```

- [ ] **Step 2: Load pending approvals in `ActivityView`**

```jsx
const [resReqs, setResReqs] = useState([]);
async function loadResReqs() {
  const { data } = await supabase
    .from("reschedule_requests")
    .select("id, student_id, student_phone, selected_option")
    .eq("status", "pending_approval")
    .order("updated_at", { ascending: false });
  setResReqs(data || []);
}
useEffect(() => {
  loadResReqs();
}, []);
```

- [ ] **Step 3: Approve / reject handlers**

```jsx
async function approveRes(row) {
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
        action: "reschedule_approved",
        userId,
        requestId: row.id,
      }),
    },
  );
}
async function rejectRes(row) {
  setResReqs((p) => p.filter((x) => x.id !== row.id));
  await supabase
    .from("reschedule_requests")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", row.id);
}
```

- [ ] **Step 4: Render the section** (top of the `ActivityView` return)

```jsx
{
  resReqs.length > 0 && (
    <div
      className="bg-indigo-500/10 border border-indigo-500/30 rounded-2xl p-4 space-y-3 mb-4"
      dir="rtl"
    >
      <p className="text-sm font-bold text-indigo-300">בקשות תיאום מחדש</p>
      {resReqs.map((row) => (
        <div
          key={row.id}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm"
        >
          <span className="text-slate-200">
            בקשה למועד {slotText(row.selected_option)}
          </span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => rejectRes(row)}
              className="text-xs font-semibold text-red-400 border border-red-500/40 px-3 py-1.5 rounded-lg"
            >
              דחה
            </button>
            <button
              onClick={() => approveRes(row)}
              className="text-xs font-semibold text-white bg-indigo-600 px-3 py-1.5 rounded-lg"
            >
              אשר
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Verify build + manual test**

`npm run build` → success. Then, with a `pending_approval` row from Layer 2a: open the Activity tab → the "בקשות תיאום מחדש" card lists it. **אשר** → the student's lesson day/time update (check the students list / SQL), the request becomes `approved`, and the tester phone receives the `reschedule_confirmed` message. **דחה** → the request becomes `rejected` and the card clears.

```sql
select status from reschedule_requests order by updated_at desc limit 1;
select name, lesson_day, lesson_time from students where id = '<the student id>';
```

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): approve/reject reschedule requests in activity tab"
```

---

## Self-Review

- **Spec coverage (Layer 2b):** in-app approval list ✅ (T4); approve updates slot + confirms ✅ (T3, T4); reject ✅ (T4); confirmation template ✅ (T2). Swaps = Layer 3.
- **Placeholders:** none — full code each step.
- **Type consistency:** `selected_option {day,time}` used in T3 slot update + T4 label; `reschedule_confirmed` name identical T2/T3; `buildRescheduleConfirmParams` 2 params match the 2-var template; `lesson_day` written as `String(slot.day)` to match how it is read elsewhere.
- **Note (accepted for v1):** reject does not auto-message the student — the teacher handles rejections directly. A `reschedule_rejected` template can be added later if wanted.
