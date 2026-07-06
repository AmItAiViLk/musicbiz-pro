# Payment Reminder — Detection + Teacher-Confirmed Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A week after billing, flag apparently-unpaid students for the teacher to confirm, then send one gentle WhatsApp payment reminder on the teacher's confirmation — never automatically.

**Architecture:** The daily `send-reminders` run resolves each unpaid `payment_status` row (Morning read for auto-mode students, never overriding a manual mark) and, if still unpaid ≥7 days after billing, sets `reminder_state='pending_confirm'`. The Invoices view surfaces these for the teacher, who either marks paid or confirms sending; confirming calls `send-reminders` with an action that sends the approved `payment_reminder` template.

**Tech Stack:** Deno Edge Functions (TypeScript), Supabase, Meta WhatsApp Cloud API, React 19.

## Global Constraints

- Hebrew UI/messages.
- **A manual mark (`paid_source='manual'`) is an override the automatic check must NEVER undo.**
- Proactive sends require an approved Meta template — new template `payment_reminder` (Utility, he).
- Reminder is sent **only** on the teacher's explicit confirm — never automatically.
- No Deno test runner locally; pure helpers via `deno test`, integration verified manually.
- Payment status table `payment_status` columns: `user_id, student_id, student_name, year_month, amount, billed_at, status ('unpaid'|'paid'), paid_source ('manual'|'morning'|null), reminder_state ('none'|'pending_confirm'|'reminded'|'escalated')`.

---

## File Structure

- **Create** `supabase/functions/_shared/morning.ts` — read a client's paid state from Morning (+ pure parser).
- **Create** `supabase/functions/_shared/morning.test.ts` — test the parser.
- **Modify** `supabase/functions/_shared/messaging.ts` — `buildPaymentReminderParams`.
- **Modify** `supabase/functions/send-reminders/index.ts` — (a) daily payment check → `pending_confirm`; (b) a `payment_reminder` action that sends the template on confirm.
- **Modify** `src/App.jsx` — a "ממתין לאישורך" section in the Invoices view: confirm-send / mark-paid.
- **Meta dashboard** — create the `payment_reminder` template.

---

### Task 1: Morning read helper (`_shared/morning.ts`)

**Files:**

- Create: `supabase/functions/_shared/morning.ts`
- Test: `supabase/functions/_shared/morning.test.ts`

**Interfaces:**

- Produces:
  - `parseMorningPaid(data: unknown): boolean | null` — `true` paid, `false` unpaid, `null` unknown.
  - `getMorningPaid(key: string, secret: string, clientName: string): Promise<boolean | null>`.

- [ ] **Step 1: Write the module**

```ts
// supabase/functions/_shared/morning.ts
// Reads a client's latest income/invoice status from Morning (חשבונית ירוקה).

/** true = paid/closed, false = open/unpaid, null = no invoice / unknown. */
// deno-lint-ignore no-explicit-any
export function parseMorningPaid(data: any): boolean | null {
  const items = data?.items || data?.data || (Array.isArray(data) ? data : []);
  const latest = items?.[0];
  if (!latest) return null;
  const st = String(latest.status || latest.paymentStatus || "").toLowerCase();
  if (st === "paid" || st === "closed") return true;
  if (st === "open") return false;
  return null;
}

export async function getMorningPaid(
  key: string,
  secret: string,
  clientName: string,
): Promise<boolean | null> {
  try {
    const auth = btoa(`${key}:${secret}`);
    const url = `https://api.morning.co.il/v1/incomes?clientName=${encodeURIComponent(clientName)}&pageSize=5&sort=createdAt:desc`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseMorningPaid(await res.json());
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// supabase/functions/_shared/morning.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseMorningPaid } from "./morning.ts";

Deno.test("parseMorningPaid reads status", () => {
  assertEquals(parseMorningPaid({ items: [{ status: "paid" }] }), true);
  assertEquals(parseMorningPaid({ items: [{ status: "closed" }] }), true);
  assertEquals(parseMorningPaid({ items: [{ status: "open" }] }), false);
  assertEquals(parseMorningPaid({ items: [] }), null);
  assertEquals(parseMorningPaid([{ paymentStatus: "PAID" }]), true);
});
```

- [ ] **Step 3: Run test** — `deno test supabase/functions/_shared/morning.test.ts` → PASS (skip if no Deno).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/morning.ts supabase/functions/_shared/morning.test.ts
git commit -m "feat(wa): Morning paid-status read helper"
```

---

### Task 2: Payment reminder params (`messaging.ts`)

**Files:**

- Modify: `supabase/functions/_shared/messaging.ts`
- Test: `supabase/functions/_shared/messaging.test.ts`

**Interfaces:**

- Produces: `buildPaymentReminderParams(s: Student, amount: number): string[]` → `[greeting, String(amount)]`.

- [ ] **Step 1: Write the failing test** (append to `messaging.test.ts`)

```ts
import { buildPaymentReminderParams } from "./messaging.ts";

Deno.test("payment reminder params = [greeting, amount]", () => {
  assertEquals(buildPaymentReminderParams(base, 320), ["דנה", "320"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `deno test supabase/functions/_shared/messaging.test.ts`.

- [ ] **Step 3: Implement** (append to `messaging.ts`)

```ts
/** Params for the `payment_reminder` template: {{1}}=greeting, {{2}}=amount. */
export function buildPaymentReminderParams(
  s: Student,
  amount: number,
): string[] {
  const { greeting } = getMsgParts(s, null);
  return [greeting, String(amount)];
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/messaging.ts supabase/functions/_shared/messaging.test.ts
git commit -m "feat(wa): payment reminder template params"
```

---

### Task 3: Daily payment check in `send-reminders`

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: `getMorningPaid` (Task 1); the existing per-user loop (has `userId`, `userRow`, `studentRows`).

Runs on every invocation (idempotent). For the current user's unpaid rows: auto-read Morning for morning-mode students (never overriding manual), then flag ≥7-day-old unpaid rows as `pending_confirm`.

- [ ] **Step 1: Import the helper**

Add to `send-reminders/index.ts` imports:

```ts
import { getMorningPaid } from "../_shared/morning.ts";
```

- [ ] **Step 2: Add the check after the student loop**

Inside the `for (const userRow of userRows ?? [])` loop, AFTER the `for (const row of studentRows ?? [])` loop closes (but still inside the user loop), add:

```ts
// ── Payment status check + 7-day dunning flag ──────────────────────────
const { data: unpaidRows } = await supabase
  .from("payment_status")
  .select("*")
  .eq("user_id", userId)
  .eq("status", "unpaid");

for (const pay of unpaidRows ?? []) {
  // deno-lint-ignore no-explicit-any
  const stu = (studentRows ?? []).find((s: any) => s.id === pay.student_id);
  const mode = stu?.payment_tracking_mode ?? "manual";

  // Auto-read Morning for auto-mode students; never override a manual mark.
  if (
    mode === "morning" &&
    pay.paid_source !== "manual" &&
    userRow.morning_key &&
    userRow.morning_secret
  ) {
    const paid = await getMorningPaid(
      userRow.morning_key,
      userRow.morning_secret,
      pay.student_name,
    );
    if (paid === true) {
      await supabase
        .from("payment_status")
        .update({
          status: "paid",
          paid_source: "morning",
          updated_at: new Date().toISOString(),
        })
        .eq("id", pay.id);
      continue;
    }
  }

  // Flag for the teacher to confirm once 7+ days have passed since billing.
  const days =
    (Date.now() - new Date(pay.billed_at).getTime()) / (1000 * 60 * 60 * 24);
  if (days >= 7 && pay.reminder_state === "none") {
    await supabase
      .from("payment_status")
      .update({
        reminder_state: "pending_confirm",
        updated_at: new Date().toISOString(),
      })
      .eq("id", pay.id);
  }
}
```

- [ ] **Step 3: Deploy** (USER) — `powershell -ExecutionPolicy Bypass -File deploy-tempo.ps1`.

- [ ] **Step 4: Manual test**

Backdate a row and trigger the check:

```sql
update payment_status set billed_at = now() - interval '8 days', reminder_state = 'none'
where student_name = 'יותם';
```

Click "שלח הודעת בדיקה" (invokes send-reminders). Then:

```sql
select student_name, reminder_state from payment_status where student_name = 'יותם';
```

Expected: `reminder_state = 'pending_confirm'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat(wa): daily payment check flags 7-day-unpaid as pending_confirm"
```

---

### Task 4: Create the `payment_reminder` Meta template

**Files:** none (Meta dashboard).

- [ ] **Step 1: Create the template** (USER, WhatsApp Manager → Create template)

Name `payment_reminder`, Category **Utility**, Language **Hebrew**, Header empty, Body:

```
היי {{1}}, תזכורת ידידותית: נותר תשלום על סך {{2}} ש"ח עבור החודש. אפשר להעביר בביט/פייבוקס/העברה בנקאית. תודה 🙏
```

Variable samples: `{{1}}`=דנה, `{{2}}`=320. Submit for review; wait until **Approved**. Note the exact approved name.

---

### Task 5: Send the reminder on confirm (`payment_reminder` action)

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: `sendTemplate`, `buildPaymentReminderParams`, `resolveBillingTargets`, existing Meta config constants.
- Produces: POST `send-reminders` with body `{ action: "payment_reminder", userId, studentId }` → sends the template, sets `reminder_state='reminded'`, returns `{ ok, sent }`.

- [ ] **Step 1: Import the param builder**

Add `buildPaymentReminderParams` to the existing `messaging.ts` import list in `send-reminders/index.ts`.

- [ ] **Step 2: Add the template constant**

Near the other template constants:

```ts
const PAYMENT_REMINDER_TEMPLATE = "payment_reminder"; // exact approved name
```

- [ ] **Step 3: Handle the action early in the handler**

After the body is parsed (where `isTest`/`requestedUserId` are read), also read:

```ts
const action = (bodyJson?.action as string) ?? "";
const requestedStudentId = (bodyJson?.studentId as string) ?? "";
```

(Adjust to however the body is parsed; store the parsed object as `bodyJson`.)

Then, right after the Supabase admin client + Meta creds are set up, add:

```ts
if (action === "payment_reminder" && requestedUserId && requestedStudentId) {
  const ymNow = yearMonthKey(nowIsrael());
  const { data: payRow } = await supabase
    .from("payment_status")
    .select("*")
    .eq("user_id", requestedUserId)
    .eq("student_id", requestedStudentId)
    .eq("year_month", ymNow)
    .maybeSingle();
  const { data: stuRow } = await supabase
    .from("students")
    .select("*")
    .eq("id", requestedStudentId)
    .maybeSingle();
  if (!payRow || !stuRow) {
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const student = rowToStudent(stuRow);
  const params = buildPaymentReminderParams(
    student,
    Number(payRow.amount) || 0,
  );
  const targets = resolveBillingTargets(student);
  let sent = 0;
  for (const target of targets) {
    try {
      await sendTemplate(
        metaToken,
        phoneNumberId,
        target.phone,
        PAYMENT_REMINDER_TEMPLATE,
        TEMPLATE_LANG,
        params,
      );
      sent++;
    } catch (err) {
      console.error("payment_reminder send failed:", (err as Error).message);
    }
  }
  await supabase
    .from("payment_status")
    .update({
      reminder_state: "reminded",
      updated_at: new Date().toISOString(),
    })
    .eq("id", payRow.id);
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
git commit -m "feat(wa): send payment_reminder template on teacher confirm"
```

---

### Task 6: In-app "ממתין לאישורך" confirmations (Invoices view)

**Files:**

- Modify: `src/App.jsx`

**Interfaces:**

- Consumes: `supabase`, `userId`, the `VITE_AUTOMATION_SECRET` env; `payment_status` rows with `reminder_state='pending_confirm'`.

- [ ] **Step 1: Load pending confirmations in `InvoicesView`**

Add near the other `InvoicesView` state:

```jsx
const [pending, setPending] = useState([]); // rows awaiting teacher confirm

async function loadPending() {
  const { data } = await supabase
    .from("payment_status")
    .select("id, student_id, student_name, amount")
    .eq("year_month", ym)
    .eq("reminder_state", "pending_confirm");
  setPending(data || []);
}
useEffect(() => {
  loadPending();
}, [ym]);
```

- [ ] **Step 2: Add confirm / mark-paid handlers**

```jsx
async function confirmSendReminder(row) {
  setPending((p) => p.filter((x) => x.id !== row.id));
  await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-reminders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_AUTOMATION_SECRET}`,
      },
      body: JSON.stringify({
        action: "payment_reminder",
        userId,
        studentId: row.student_id,
      }),
    },
  );
}

async function markPendingPaid(row) {
  setPending((p) => p.filter((x) => x.id !== row.id));
  setPayStatus((p) => ({ ...p, [row.student_id]: "paid" }));
  await supabase
    .from("payment_status")
    .update({
      status: "paid",
      paid_source: "manual",
      reminder_state: "none",
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}
```

- [ ] **Step 3: Render the section at the top of the Invoices view**

Just inside the `InvoicesView` return, above the stats grid:

```jsx
{
  pending.length > 0 && (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 space-y-3">
      <p className="text-sm font-bold text-amber-300">ממתין לאישורך</p>
      {pending.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span className="text-slate-200">
            נראה ש{row.student_name} עדיין לא שילם (₪{row.amount}). שילם בדרך
            אחרת?
          </span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => markPendingPaid(row)}
              className="text-xs font-semibold text-emerald-400 border border-emerald-500/40 px-3 py-1.5 rounded-lg"
            >
              סמן כשולם
            </button>
            <button
              onClick={() => confirmSendReminder(row)}
              className="text-xs font-semibold text-white bg-indigo-600 px-3 py-1.5 rounded-lg"
            >
              שלח תזכורת
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify build + manual test**

`npm run build` → success. Then, after Task 3's backdated row became `pending_confirm`, open the Invoices tab: the amber "ממתין לאישורך" card lists the student. "סמן כשולם" clears it and flips the badge to paid. "שלח תזכורת" clears it, sends the WhatsApp template (verify on the tester phone), and sets `reminder_state='reminded'` (check in SQL).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): pending payment confirmations (confirm-send / mark-paid)"
```

---

## Self-Review

- **Spec coverage (plan 2):** Morning read never overrides manual ✅ (T1, T3); 7-day `pending_confirm` ✅ (T3); teacher confirm before send ✅ (T6); reminder template + send ✅ (T4, T5); mark-paid path ✅ (T6). Escalation = plan 3.
- **Placeholders:** none. T5 Step 3 notes "adjust to however the body is parsed" — the implementer must confirm the body is parsed into an object (`bodyJson`) once and reused; wire `action`/`studentId` from it.
- **Type consistency:** `reminder_state` values (`none`/`pending_confirm`/`reminded`) match the table; `payment_reminder` template name identical in T4/T5; `buildPaymentReminderParams` returns 2 params matching the 2-var template.
- **Note:** the daily check runs on every `send-reminders` call (cron daily + the manual test button). Idempotent. The 7-day threshold is testable by backdating `billed_at`.
