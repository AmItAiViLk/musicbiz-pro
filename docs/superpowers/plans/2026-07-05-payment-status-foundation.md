# Payment Status Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each student's monthly payment status so the teacher can see who hasn't paid and mark payments manually — the foundation the reminder/escalation layers build on.

**Architecture:** A `payment_status` table (one row per student per month) is written by `send-reminders` when the monthly billing message goes out. A `payment_tracking_mode` setting (`manual` | `morning`) records how the teacher tracks payment. The Invoices view shows an unpaid flag per student and, in manual mode, a paid/unpaid toggle.

**Tech Stack:** Supabase (Postgres), Deno Edge Functions (TypeScript), React 19.

## Global Constraints

- All user-facing text in **Hebrew**.
- `student_id` / `student_identifier` is always **text**.
- This plan only records/reads status — it does NOT send reminders (that is plan 2) and does NOT create Morning invoices.
- No Deno test runner locally; pure helpers use `deno test`; DB + UI verified manually.
- Payment-tracking modes: `manual` (teacher marks in app) and `morning` (read invoice status). This plan wires the **setting + manual path + unpaid flag**; the Morning auto-read is used by plan 2's daily check.

---

## File Structure

- **Create** `supabase/migrations/payment_status.sql` — the `payment_status` table + `user_settings.payment_tracking_mode` column.
- **Modify** `supabase/functions/_shared/schedule.ts` — add `yearMonthKey(date)` (pure).
- **Modify** `supabase/functions/_shared/schedule.test.ts` — test it.
- **Modify** `supabase/functions/send-reminders/index.ts` — upsert a `payment_status` row when billing is sent.
- **Modify** `src/App.jsx` — payment-mode toggle in Settings; unpaid flag + manual paid/unpaid toggle in the Invoices view.

---

### Task 1: Migration — payment_status table + mode column

**Files:**

- Create: `supabase/migrations/payment_status.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-student monthly payment tracking.
create table if not exists payment_status (
  id             uuid default gen_random_uuid() primary key,
  user_id        uuid not null,
  student_id     text not null,
  student_name   text,
  year_month     text not null,                 -- 'YYYY-MM'
  amount         numeric default 0,
  billed_at      timestamptz default now(),
  status         text not null default 'unpaid', -- 'unpaid' | 'paid'
  paid_source    text,                            -- 'manual' | 'morning' | null
  reminder_state text not null default 'none',    -- 'none'|'pending_confirm'|'reminded'|'escalated'
  updated_at     timestamptz default now()
);

create unique index if not exists payment_status_unique
  on payment_status (user_id, student_id, year_month);

create index if not exists payment_status_user_month
  on payment_status (user_id, year_month, status);

alter table payment_status enable row level security;
drop policy if exists "owner_all" on payment_status;
create policy "owner_all" on payment_status
  for all using (auth.uid() = user_id);

-- How the teacher tracks payment.
alter table user_settings
  add column if not exists payment_tracking_mode text default 'manual';
```

- [ ] **Step 2: Apply it** (USER runs in the Supabase SQL editor — clear the editor first)

Paste the whole migration, click Run. Expected: "Success. No rows returned".

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/payment_status.sql
git commit -m "feat(db): payment_status table + payment_tracking_mode setting"
```

---

### Task 2: `yearMonthKey` helper

**Files:**

- Modify: `supabase/functions/_shared/schedule.ts`
- Test: `supabase/functions/_shared/schedule.test.ts`

**Interfaces:**

- Produces: `yearMonthKey(d: Date): string` → `'YYYY-MM'`.

- [ ] **Step 1: Write the failing test** (append to `schedule.test.ts`)

```ts
import { yearMonthKey } from "./schedule.ts";

Deno.test("yearMonthKey formats YYYY-MM", () => {
  assertEquals(yearMonthKey(new Date(2026, 0, 5)), "2026-01");
  assertEquals(yearMonthKey(new Date(2026, 11, 31)), "2026-12");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test supabase/functions/_shared/schedule.test.ts`
Expected: FAIL (`yearMonthKey` not exported). (Skip if no Deno; covered manually.)

- [ ] **Step 3: Implement** (append to `schedule.ts`)

```ts
/** 'YYYY-MM' for the given date (local components). */
export function yearMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `deno test supabase/functions/_shared/schedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/schedule.ts supabase/functions/_shared/schedule.test.ts
git commit -m "feat(wa): add yearMonthKey helper"
```

---

### Task 3: Record payment_status when billing is sent

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: `yearMonthKey` (Task 2); existing `calcMonthlyLessons`, the `supabase` admin client, `nowInIsrael`-style time.

The billing branch currently loops over targets and sends the `monthly_billing` template. We add: once per student (not per target), upsert a `payment_status` row so tracking exists even before any reminder.

- [ ] **Step 1: Import the helper**

Add a new import in `send-reminders/index.ts` (there is no existing schedule import there):

```ts
import { yearMonthKey } from "../_shared/schedule.ts";
```

- [ ] **Step 2: Add an Israel-time helper near the top of the handler**

If not already present, add:

```ts
function nowIsrael(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
}
```

- [ ] **Step 3: Upsert payment_status inside the billing branch**

In the `if ((billingToday || isTest) && student.price > 0) {` block, right after `const monthlyCount = calcMonthlyLessons(student.lessonDay);`, add:

```ts
const total = monthlyCount * (student.price ?? 0);
await supabase.from("payment_status").upsert(
  {
    user_id: userId,
    student_id: student.id,
    student_name: student.name,
    year_month: yearMonthKey(nowIsrael()),
    amount: total,
    status: "unpaid",
    reminder_state: "none",
    billed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  { onConflict: "user_id,student_id,year_month" },
);
```

(Keep the existing per-target send loop below unchanged.)

- [ ] **Step 4: Deploy** (USER's terminal)

Run: `powershell -ExecutionPolicy Bypass -File deploy-tempo.ps1`
Expected: `ALL DEPLOYED.`

- [ ] **Step 5: Manual test**

Trigger the billing test (Settings → "שלח הודעת בדיקה", or the send-reminders curl with `{test:true,userId}`). Then in SQL:

```sql
select student_name, year_month, amount, status, reminder_state
from payment_status order by updated_at desc limit 10;
```

Expected: one `unpaid` row per priced student for the current month.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat(wa): record payment_status when billing is sent"
```

---

### Task 4: Payment-tracking mode setting in the app

**Files:**

- Modify: `src/App.jsx`

**Interfaces:**

- Consumes: existing settings form + `saveSettings` upsert to `user_settings`.
- Produces: `settings.paymentTrackingMode` (`'manual'` | `'morning'`).

- [ ] **Step 1: Load the field**

Where settings are mapped from the DB row (the block that sets `automationEnabled: settingsData.automation_enabled ?? false`), add:

```js
paymentTrackingMode: settingsData.payment_tracking_mode ?? "manual",
```

And in the default settings object (where `whapiToken: ""` etc. are initialized), add:

```js
paymentTrackingMode: "manual",
```

- [ ] **Step 2: Save the field**

In `saveSettings`, inside the `user_settings` upsert object, add:

```js
payment_tracking_mode: newSettings.paymentTrackingMode,
```

- [ ] **Step 3: Add the toggle to SettingsView**

Inside `SettingsView`, add a small control (place near the automation section):

```jsx
<div className="mt-6">
  <label className="block text-sm font-semibold text-slate-200 mb-2">
    מעקב תשלומים
  </label>
  <div className="flex gap-2" dir="rtl">
    {[
      { v: "manual", label: "סימון ידני" },
      { v: "morning", label: "אוטומטי (מורנינג)" },
    ].map((o) => (
      <button
        key={o.v}
        type="button"
        onClick={() => setForm((f) => ({ ...f, paymentTrackingMode: o.v }))}
        className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
          (form.paymentTrackingMode || "manual") === o.v
            ? "bg-indigo-600 border-indigo-500 text-white"
            : "bg-slate-800 border-slate-700 text-slate-300"
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
</div>
```

(The existing "Save" button persists it via `saveSettings`.)

- [ ] **Step 4: Manual check**

Run the app, open Settings, switch the mode, Save, reload — the choice persists. Confirm in SQL:

```sql
select payment_tracking_mode from user_settings;
```

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): payment tracking mode setting (manual/morning)"
```

---

### Task 5: Unpaid flag + manual paid/unpaid toggle in Invoices view

**Files:**

- Modify: `src/App.jsx`

**Interfaces:**

- Consumes: `supabase`, `students`, `settings.paymentTrackingMode`; the `payment_status` table.

Add current-month payment status to the Invoices view: a badge for every student, and (in manual mode) a button to flip paid/unpaid.

- [ ] **Step 1: Load current-month statuses in `InvoicesView`**

Add near the top of `InvoicesView`:

```jsx
const [payStatus, setPayStatus] = useState({}); // { [student_id]: 'paid'|'unpaid' }
const ym = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();

useEffect(() => {
  let active = true;
  (async () => {
    const { data } = await supabase
      .from("payment_status")
      .select("student_id, status")
      .eq("year_month", ym);
    if (active && data) {
      const m = {};
      data.forEach((r) => (m[r.student_id] = r.status));
      setPayStatus(m);
    }
  })();
  return () => {
    active = false;
  };
}, [ym]);

async function togglePaid(s) {
  const next = payStatus[s.id] === "paid" ? "unpaid" : "paid";
  setPayStatus((p) => ({ ...p, [s.id]: next }));
  await supabase.from("payment_status").upsert(
    {
      user_id: s.userId || undefined,
      student_id: s.id,
      student_name: s.name,
      year_month: ym,
      status: next,
      paid_source: next === "paid" ? "manual" : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,student_id,year_month" },
  );
}
```

Note: `s.userId` may be absent on the student object; if so, read the logged-in user id the same way the rest of `App.jsx` does (the `user.id` passed into `App`). Thread `userId` into `InvoicesView` as a prop from the `renderView()` call: `<InvoicesView students={students} settings={settings} userId={user.id} />`, and use `userId` in the upsert.

- [ ] **Step 2: Show a badge + toggle per student row**

In the student row rendering inside `InvoicesView`, add:

```jsx
{
  settings.paymentTrackingMode !== "morning" ? (
    <button
      type="button"
      onClick={() => togglePaid(s)}
      className={`text-xs font-semibold px-2 py-1 rounded-lg ${
        payStatus[s.id] === "paid" ? "text-emerald-400" : "text-amber-400"
      }`}
    >
      {payStatus[s.id] === "paid" ? "✓ שולם" : "! לא שולם"}
    </button>
  ) : null;
}
```

(In `morning` mode the existing `MorningBadge` already shows status, so the manual toggle is hidden.)

- [ ] **Step 3: Pass `userId` prop**

In `renderView()` update the invoices case:

```jsx
case "invoices":
  return (
    <InvoicesView students={students} settings={settings} userId={user.id} />
  );
```

And update the `InvoicesView` signature: `function InvoicesView({ students, settings = {}, userId }) {`.

- [ ] **Step 4: Verify build + manual check**

Run: `npm run build` → expect success.
Then run the app: in manual mode each student shows "✓ שולם" / "! לא שולם"; clicking toggles it and it persists after reload.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): unpaid flag + manual paid toggle in invoices view"
```

---

## Self-Review

- **Spec coverage (plan 1):** `payment_status` table ✅ (T1); `payment_tracking_mode` setting ✅ (T1, T4); billing records unpaid ✅ (T3); unpaid flag ✅ (T5); manual paid/unpaid ✅ (T5). Detection/reminder/escalation = plans 2–3, intentionally excluded.
- **Placeholders:** none — full code each step. (T3 Step 1 shows a throwaway line then the real import beneath it; implementer uses the real line.)
- **Type consistency:** `payment_status` columns identical across migration, `send-reminders` upsert, and the two frontend upserts; `onConflict: "user_id,student_id,year_month"` matches the unique index; `year_month` format `'YYYY-MM'` produced by both `yearMonthKey` (server) and the inline `ym` (client).
- **Note:** the manual toggle upsert must include `user_id` (from the `userId` prop) so the RLS `owner_all` policy accepts it.
