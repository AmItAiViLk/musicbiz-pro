# WhatsApp Proactive Reminders & Billing (Meta Templates) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send lesson reminders and monthly billing as **Meta-approved WhatsApp templates** from the Tempo Meta number, replacing the old Whapi.cloud free-text path.

**Architecture:** A new `_shared/meta.ts` sends template messages via the Meta Cloud API (`graph.facebook.com`). `send-reminders` is repointed from Whapi to `meta.ts`, builds the template _parameters_ (not free text), and logs to `tempo_automation_logs` using the real column names. One central Meta number/token (from secrets) is used for all sends during the single-teacher phase.

**Tech Stack:** Deno Edge Functions (TypeScript), Supabase (Postgres + secrets), Meta WhatsApp Cloud API v21.0, pg_cron.

## Global Constraints

- All user-facing text in **Hebrew**; RTL.
- 24h Rule: reminder sent the day before a lesson at the 08:00 IL cron; **Sunday lessons reminded on Friday**.
- `student_id` / `student_identifier` is always **text**.
- Primary log table: **`tempo_automation_logs`** — real columns: `student_identifier` (text), `action_type` (text), `raw_data` (text), `created_at` (tz). **No `user_id` / `event_type` / `message` columns.**
- Proactive (business-initiated) messages MUST use **pre-approved templates**; free text is rejected outside the 24h window.
- Meta secrets already set: `WHAPI_TOKEN` (permanent Meta access token), `WHATSAPP_PHONE_NUMBER_ID=1186701471184495`. WABA ID `1696649648141612`.

---

## Phase 2 Decomposition (this plan is #1 of 4)

Each is a separate spec→plan→implement cycle; build in this order:

1. **Proactive reminders & billing via Meta templates** ← THIS PLAN. The core daily value; unblocks all business-initiated messaging.
2. **Inbound state machine** (cancel / paid / reschedule) — extends `whatsapp-webhook` beyond the canned reply; no Meta approval needed (replies are inside the 24h window). Uses Haiku for intent + `_shared/gcal.ts` for reschedule slots.
3. **Lesson receipts** — a per-lesson receipt template + a trigger (after each lesson day). Depends on the template infra from this plan.
4. **Remove the Whapi path** — delete `_shared/whatsapp.ts` and `whapi_token` usage once 1–3 are proven on Meta.

---

## Templates to create in the Meta dashboard (DO FIRST — approval takes time)

Create under **WhatsApp Manager → Manage templates → Create template**. Category **Utility**, Language **Hebrew (he)**. Submit BEFORE coding so they approve in parallel.

**Template `lesson_reminder` (Utility, he), body:**

```
היי {{1}}, מזכיר שהשיעור {{2}} מחר (יום {{3}}) בשעה {{4}}. (ביטול פחות מ-24 ש׳ מראש כרוך בתשלום).
```

Params: `{{1}}`=greeting, `{{2}}`=lessonRef (e.g. "של דנה" or "שלנו"), `{{3}}`=dayName, `{{4}}`=time.
Sample values for review submission: `{{1}}`=דנה, `{{2}}`=שלנו, `{{3}}`=שני, `{{4}}`=16:00.

**Template `monthly_billing` (Utility, he), body:**

```
היי {{1}}, החודש צפויים {{2}} שיעורים {{3}} (לאחר חגים), הסכום לתשלום הוא {{4}} ש"ח. ניתן להעביר בביט/פייבוקס/העברה בנקאית.
```

Params: `{{1}}`=greeting, `{{2}}`=count, `{{3}}`=lessonRef, `{{4}}`=total.
Sample: `{{1}}`=דנה, `{{2}}`=4, `{{3}}`=שלנו, `{{4}}`=320.

> Record the EXACT approved template names + language code; Task 3 references them.

---

## File Structure

- **Create** `supabase/functions/_shared/meta.ts` — Meta Cloud API sender: `sendTemplate()` + `sendText()`. Single responsibility: outbound Meta messaging.
- **Create** `supabase/functions/_shared/meta.test.ts` — Deno unit tests for the param-builder helpers.
- **Modify** `supabase/functions/_shared/messaging.ts` — add `buildReminderParams()` / `buildBillingParams()` that return the ordered template params (reusing existing `getMsgParts`/resolvers). Keep the existing free-text builders for now (used by inbound replies later).
- **Modify** `supabase/functions/send-reminders/index.ts` — use `meta.ts` + central token/phone-id; fix log columns; gate on `automation_enabled` only.

**Test harness:** Pure helpers → `deno test`. Integration → manual: trigger `send-reminders` with `{ "test": true, "userId": "<DEFAULT_USER_ID>" }` and confirm the template arrives on the tester phone + an `auto`/`reminder_sent` row appears in `tempo_automation_logs`.

---

### Task 1: Meta sender module (`_shared/meta.ts`)

**Files:**

- Create: `supabase/functions/_shared/meta.ts`
- Test: `supabase/functions/_shared/meta.test.ts`

**Interfaces:**

- Produces:
  - `normalizePhone(phone: string): string` (re-export the existing one from `whatsapp.ts` to avoid duplication — `import { normalizePhone } from "./whatsapp.ts"`).
  - `sendText(token: string, phoneNumberId: string, to: string, body: string): Promise<string>` — plain text (24h window).
  - `sendTemplate(token: string, phoneNumberId: string, to: string, templateName: string, lang: string, bodyParams: string[]): Promise<string>` — builds `components: [{ type: "body", parameters: bodyParams.map(t => ({ type: "text", text: t })) }]`. Throws on non-2xx with the Meta error body.

- [ ] **Step 1: Write the sender module**

```ts
// supabase/functions/_shared/meta.ts
import { normalizePhone } from "./whatsapp.ts";
export { normalizePhone };

const GRAPH_VERSION = "v21.0";

async function post(
  token: string,
  phoneNumberId: string,
  payload: unknown,
): Promise<string> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const detail = await res.text().catch(() => "(no body)");
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${detail}`);
  return detail;
}

export function sendText(
  token: string,
  phoneNumberId: string,
  to: string,
  body: string,
): Promise<string> {
  return post(token, phoneNumberId, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "text",
    text: { body },
  });
}

export function sendTemplate(
  token: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  lang: string,
  bodyParams: string[],
): Promise<string> {
  return post(token, phoneNumberId, {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((t) => ({
            type: "text",
            text: String(t),
          })),
        },
      ],
    },
  });
}
```

- [ ] **Step 2: Write the failing test for payload shape**

`meta.ts` has no pure logic to unit-test directly (it does I/O). Instead extract the payload builder so it IS testable. Add to `meta.ts`:

```ts
export function buildTemplatePayload(
  to: string,
  templateName: string,
  lang: string,
  bodyParams: string[],
) {
  return {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((t) => ({
            type: "text",
            text: String(t),
          })),
        },
      ],
    },
  };
}
```

Then have `sendTemplate` call `post(token, phoneNumberId, buildTemplatePayload(...))`.

```ts
// supabase/functions/_shared/meta.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTemplatePayload } from "./meta.ts";

Deno.test("buildTemplatePayload normalizes phone and orders params", () => {
  const p = buildTemplatePayload("0541234567", "lesson_reminder", "he", [
    "דנה",
    "שלנו",
    "שני",
    "16:00",
  ]);
  assertEquals(p.to, "972541234567");
  assertEquals(p.template.name, "lesson_reminder");
  assertEquals(p.template.language.code, "he");
  assertEquals(
    p.template.components[0].parameters.map((x: any) => x.text),
    ["דנה", "שלנו", "שני", "16:00"],
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/meta.test.ts`
Expected: FAIL (`buildTemplatePayload` not yet exported) — then add it per Step 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/meta.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/meta.ts supabase/functions/_shared/meta.test.ts
git commit -m "feat(wa): add Meta Cloud API template/text sender (_shared/meta.ts)"
```

---

### Task 2: Template param builders (`messaging.ts`)

**Files:**

- Modify: `supabase/functions/_shared/messaging.ts`
- Test: `supabase/functions/_shared/messaging.test.ts` (create)

**Interfaces:**

- Consumes: existing `getMsgParts(s, role)`, `Student`, `WaTarget`.
- Produces:
  - `buildReminderParams(s: Student, role: "student"|"parent"|null): string[]` → `[greeting, lessonRef, dayName, time]`.
  - `buildBillingParams(s: Student, role: "student"|"parent"|null, monthlyCount: number): string[]` → `[greeting, String(count), lessonRef, String(count*price)]`.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/messaging.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReminderParams,
  buildBillingParams,
  Student,
} from "./messaging.ts";

const base: Student = {
  id: "1",
  name: "דנה",
  phone: "0541234567",
  contactName: "",
  contactPhone: "",
  lessonDay: "1",
  lessonTime: "16:00",
  price: 80,
  reminderToStudent: true,
  reminderToParent: false,
  billingToStudent: false,
  billingToParent: true,
};

Deno.test("reminder params: no contactName uses שלנו", () => {
  assertEquals(buildReminderParams(base, "student"), [
    "דנה",
    "שלנו",
    "שני",
    "16:00",
  ]);
});

Deno.test("reminder params: parent uses 'של <name>'", () => {
  const s = { ...base, contactName: "אמא", contactPhone: "0549999999" };
  assertEquals(buildReminderParams(s, "parent"), [
    "אמא",
    "של דנה",
    "שני",
    "16:00",
  ]);
});

Deno.test("billing params order = [greeting, count, lessonRef, total]", () => {
  assertEquals(buildBillingParams(base, "student", 4), [
    "דנה",
    "4",
    "שלנו",
    "320",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/messaging.test.ts`
Expected: FAIL (`buildReminderParams` not defined).

- [ ] **Step 3: Implement the builders**

Append to `messaging.ts`:

```ts
export function buildReminderParams(
  s: Student,
  role: "student" | "parent" | null,
): string[] {
  const { greeting, lessonRef, dayName } = getMsgParts(s, role);
  return [greeting, lessonRef, dayName, s.lessonTime || "—"];
}

export function buildBillingParams(
  s: Student,
  role: "student" | "parent" | null,
  monthlyCount: number,
): string[] {
  const { greeting, lessonRef } = getMsgParts(s, role);
  const total = monthlyCount * (s.price ?? 0);
  return [greeting, String(monthlyCount), lessonRef, String(total)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/messaging.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/messaging.ts supabase/functions/_shared/messaging.test.ts
git commit -m "feat(wa): add reminder/billing template param builders"
```

---

### Task 3: Repoint `send-reminders` to Meta templates

**Files:**

- Modify: `supabase/functions/send-reminders/index.ts`

**Interfaces:**

- Consumes: `sendTemplate` (Task 1), `buildReminderParams`/`buildBillingParams` (Task 2), existing `resolveReminderTargets`/`resolveBillingTargets`, `isReminderDueTodayIsrael`/`isBillingDay`/`calcMonthlyLessons`.

- [ ] **Step 1: Swap imports**

Replace the Whapi import:

```ts
// remove: import { sendWhatsApp } from "../_shared/whatsapp.ts";
import { sendTemplate } from "../_shared/meta.ts";
import {
  resolveReminderTargets,
  resolveBillingTargets,
  buildReminderParams,
  buildBillingParams,
  Student,
} from "../_shared/messaging.ts";
```

- [ ] **Step 2: Read central Meta credentials + template names**

Near the top of the handler (after the admin client), add:

```ts
const metaToken = Deno.env.get("WHAPI_TOKEN")!; // permanent Meta token
const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const REMINDER_TEMPLATE = "lesson_reminder"; // exact approved name
const BILLING_TEMPLATE = "monthly_billing";
const TEMPLATE_LANG = "he";
```

- [ ] **Step 3: Change the eligibility query gate**

We no longer use per-user `whapi_token`. Replace:

```ts
let settingsQuery = supabase
  .from("user_settings")
  .select("*")
  .eq("automation_enabled", true);
```

(remove the `.not("whapi_token", "is", null)` filter). Remove `const whapiToken = userRow.whapi_token;`.

- [ ] **Step 4: Replace the reminder send block**

```ts
if (isReminderDueTodayIsrael(student) || isTest) {
  const targets = resolveReminderTargets(student);
  for (const target of targets) {
    try {
      const params = buildReminderParams(student, target.role);
      await sendTemplate(
        metaToken,
        phoneNumberId,
        target.phone,
        REMINDER_TEMPLATE,
        TEMPLATE_LANG,
        params,
      );
      await supabase.from("tempo_automation_logs").insert({
        student_identifier: student.name,
        action_type: "reminder_sent",
        raw_data: params.join(" | "),
      });
      sent++;
    } catch (err) {
      const msg = `reminder failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
      console.error(msg);
      errors.push(msg);
    }
  }
}
```

- [ ] **Step 5: Replace the billing send block**

```ts
if ((billingToday || isTest) && student.price > 0) {
  const monthlyCount = calcMonthlyLessons(student.lessonDay);
  const targets = resolveBillingTargets(student);
  for (const target of targets) {
    try {
      const params = buildBillingParams(student, target.role, monthlyCount);
      await sendTemplate(
        metaToken,
        phoneNumberId,
        target.phone,
        BILLING_TEMPLATE,
        TEMPLATE_LANG,
        params,
      );
      await supabase.from("tempo_automation_logs").insert({
        student_identifier: student.name,
        action_type: "billing_sent",
        raw_data: params.join(" | "),
      });
      sent++;
    } catch (err) {
      const msg = `billing failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
      console.error(msg);
      errors.push(msg);
    }
  }
}
```

- [ ] **Step 6: Deploy**

Run: `powershell -ExecutionPolicy Bypass -File deploy-tempo.ps1` (in the USER's terminal — Claude's shell can't auth to Supabase).
Expected: `ALL DEPLOYED.`

- [ ] **Step 7: Manual integration test (templates must be APPROVED first)**

From the USER's terminal (needs `AUTOMATION_SECRET` value):

```bash
curl -X POST "https://tyckebaxdgqscxbpilqm.supabase.co/functions/v1/send-reminders" \
  -H "Authorization: Bearer <AUTOMATION_SECRET>" -H "Content-Type: application/json" \
  -d '{"test": true, "userId": "<DEFAULT_USER_ID>"}'
```

Expected: tester phone receives the reminder + billing templates; response `{ "sent": N, "errors": [] }`; new `reminder_sent` / `billing_sent` rows in `tempo_automation_logs`.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/send-reminders/index.ts
git commit -m "feat(wa): send reminders/billing via Meta templates; fix log columns"
```

---

## Self-Review notes

- Spec coverage: reminders ✅, billing ✅, template requirement ✅, log-column fix ✅, off-Whapi for proactive ✅. (Inbound, receipts, full Whapi deletion = Plans 2–4.)
- The `verifyMetaSignature`/inbound path is untouched (Plan 2).
- Open decision for execution time: confirm the EXACT approved template names + language code and update Task 3 Step 2 constants to match.
