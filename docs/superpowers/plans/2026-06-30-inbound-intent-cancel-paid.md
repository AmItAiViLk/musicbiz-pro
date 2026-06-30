# Inbound Intent Routing + Cancel + Paid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the webhook's canned auto-reply with AI intent detection that recognizes when a student cancels or says they paid, records it, replies appropriately in Hebrew, and surfaces it in the app.

**Architecture:** `whatsapp-webhook` calls a new `_shared/classify.ts` (Haiku) to classify each inbound message into `cancel`/`paid`/`reschedule`/`other`, logs the intent to `tempo_automation_logs`, and sends a per-intent Hebrew reply. A small in-app activity list reads those log rows so the teacher sees what happened.

**Tech Stack:** Deno Edge Functions (TypeScript), Anthropic Messages API (Haiku), Supabase, React 19.

## Global Constraints

- All user-facing text in **Hebrew**.
- Use **Haiku** for classification — model id `claude-haiku-4-5-20251001`.
- Log table `tempo_automation_logs`, real columns: `student_identifier`, `action_type`, `raw_data`, `created_at` (no `user_id`/`event_type`/`message`).
- Inbound replies are within the 24h window → plain text via the webhook's existing `sendMetaReply` (no template).
- Reschedule is handled by later plans — here it only gets a placeholder acknowledgement.
- Secrets already set: `ANTHROPIC_API_KEY`, `WHAPI_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
- No Deno test runner is installed locally; pure helpers are covered by `deno test` (run in CI / by an agent with Deno); integration is verified manually over WhatsApp.

---

## File Structure

- **Create** `supabase/functions/_shared/classify.ts` — intent classifier: pure prompt builder + pure parser + the Haiku call. One responsibility: turn message text into an `Intent`.
- **Create** `supabase/functions/_shared/classify.test.ts` — Deno tests for the pure helpers.
- **Modify** `supabase/functions/whatsapp-webhook/index.ts` — replace the canned-reply block with classify → log intent → per-intent Hebrew reply.
- **Modify** `src/App.jsx` — add a small "פעילות" (activity) list reading recent `cancel`/`paid`/`reschedule` rows.

---

### Task 1: Intent classifier (`_shared/classify.ts`)

**Files:**

- Create: `supabase/functions/_shared/classify.ts`
- Test: `supabase/functions/_shared/classify.test.ts`

**Interfaces:**

- Produces:
  - `type Intent = "cancel" | "paid" | "reschedule" | "other"`
  - `buildClassifyPrompt(text: string): string`
  - `parseIntent(raw: string): Intent`
  - `classifyIntent(apiKey: string, text: string): Promise<Intent>`

- [ ] **Step 1: Write the module**

```ts
// supabase/functions/_shared/classify.ts
export type Intent = "cancel" | "paid" | "reschedule" | "other";

const MODEL = "claude-haiku-4-5-20251001";
const VALID: Intent[] = ["cancel", "paid", "reschedule", "other"];

/** Hebrew classification prompt. Returns a single label. */
export function buildClassifyPrompt(text: string): string {
  return [
    "סווג את הודעת התלמיד לאחת מהקטגוריות הבאות:",
    "cancel - התלמיד מבטל או לא יכול להגיע לשיעור",
    "paid - התלמיד מודיע ששילם או העביר תשלום",
    "reschedule - התלמיד רוצה להזיז או לתאם מחדש את השיעור",
    "other - כל דבר אחר",
    "ענה במילה אחת בלבד באנגלית מתוך הרשימה, בלי הסבר.",
    "",
    `הודעה: "${text}"`,
  ].join("\n");
}

/** Map the model's free-text answer to a valid Intent (first label found wins). */
export function parseIntent(raw: string): Intent {
  const t = (raw || "").trim().toLowerCase();
  return VALID.find((v) => t.includes(v)) ?? "other";
}

/** Classify a message via Haiku. Throws on API error. */
export async function classifyIntent(
  apiKey: string,
  text: string,
): Promise<Intent> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: buildClassifyPrompt(text) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`classify API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const raw = data?.content?.[0]?.text ?? "";
  return parseIntent(raw);
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// supabase/functions/_shared/classify.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildClassifyPrompt, parseIntent } from "./classify.ts";

Deno.test("parseIntent maps clean labels", () => {
  assertEquals(parseIntent("cancel"), "cancel");
  assertEquals(parseIntent("paid"), "paid");
  assertEquals(parseIntent("reschedule"), "reschedule");
});

Deno.test("parseIntent extracts label from a sentence", () => {
  assertEquals(parseIntent("The intent is: paid."), "paid");
});

Deno.test("parseIntent falls back to other", () => {
  assertEquals(parseIntent("בלהבלה"), "other");
  assertEquals(parseIntent(""), "other");
});

Deno.test("buildClassifyPrompt includes the message and labels", () => {
  const p = buildClassifyPrompt("אני חולה");
  assertEquals(p.includes("אני חולה"), true);
  assertEquals(p.includes("cancel"), true);
  assertEquals(p.includes("reschedule"), true);
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `deno test supabase/functions/_shared/classify.test.ts`
Expected: PASS (4 tests). (If Deno isn't installed, skip — these run in CI; integration test in Task 2 covers behavior.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/classify.ts supabase/functions/_shared/classify.test.ts
git commit -m "feat(wa): add Haiku intent classifier (_shared/classify.ts)"
```

---

### Task 2: Route intents in the webhook

**Files:**

- Modify: `supabase/functions/whatsapp-webhook/index.ts`

**Interfaces:**

- Consumes: `classifyIntent`, `Intent` (Task 1); existing `sendMetaReply(token, phoneNumberId, to, body)` and `logToDb(studentIdentifier, eventType, message)` already in the file.

Currently the POST handler (after extracting `senderPhone` and `text`, logging `incoming`) sends a single canned `AUTO_REPLY`. We replace that send block with classify-and-route.

- [ ] **Step 1: Add the import**

At the top of `whatsapp-webhook/index.ts`, next to the other imports, add:

```ts
import { classifyIntent, type Intent } from "../_shared/classify.ts";
```

- [ ] **Step 2: Add the Hebrew replies map**

Near the top of the file, below the existing `AUTO_REPLY` constant:

```ts
const REPLIES: Record<Intent, string> = {
  cancel: "קיבלנו, ביטלנו את השיעור. נעדכן בהתאם 🙏",
  paid: "תודה! רשמנו את קבלת התשלום 🙏",
  reschedule: "קיבלנו שתרצה לתאם מחדש — נשלח לך אפשרויות בהקדם.",
  other: "שלום! 🎵 קיבלנו את הודעתך. אפשר לכתוב: ביטול, שילמתי, או תיאום מחדש.",
};
```

- [ ] **Step 3: Replace the canned-reply block**

Find the block that builds `AUTO_REPLY`, calls `sendMetaReply(...)` with it, and logs `auto_reply`. Replace it with:

```ts
// Classify the message intent (best-effort: fall back to "other").
const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
let intent: Intent = "other";
try {
  if (apiKey) intent = await classifyIntent(apiKey, text);
} catch (err) {
  console.error("classify failed:", (err as Error).message);
}

// Record the classified intent (cancel / paid / reschedule / other).
await logToDb(senderPhone, intent, text);

// Reply to the student in Hebrew based on intent.
try {
  const result = await sendMetaReply(
    token,
    phoneNumberId,
    senderPhone,
    REPLIES[intent],
  );
  console.log(
    `Reply (${intent}) sent to ${senderPhone}. API response: ${result}`,
  );
  await logToDb(senderPhone, `${intent}_reply`, REPLIES[intent]);
} catch (err) {
  const msg = (err as Error).message;
  console.error("Failed to send reply:", msg);
  await logToDb(senderPhone, "auto_reply_error", msg);
}
```

(Leave the earlier `logToDb(senderPhone, "incoming", text)` call and the token/phoneNumberId guard as they are. The old `AUTO_REPLY` constant can stay unused or be removed.)

- [ ] **Step 4: Deploy** (USER's terminal — Claude's shell can't auth to Supabase)

Run: `powershell -ExecutionPolicy Bypass -File deploy-tempo.ps1`
Expected: `ALL DEPLOYED.`

- [ ] **Step 5: Manual integration test**

From the user's phone, send to the test number, one at a time:

- "אני לא יכול להגיע מחר" → expect reply "קיבלנו, ביטלנו את השיעור…"
- "העברתי לך תשלום" → expect "תודה! רשמנו…"
- "אפשר להזיז את השיעור?" → expect "קיבלנו שתרצה לתאם מחדש…"

Then verify rows in `tempo_automation_logs` (SQL editor):

```sql
select created_at, action_type, raw_data
from tempo_automation_logs
order by created_at desc limit 10;
```

Expected: `incoming` + `cancel`/`paid`/`reschedule` + matching `*_reply` rows.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.ts
git commit -m "feat(wa): route inbound messages by intent (cancel/paid/reschedule)"
```

---

### Task 3: In-app activity list

**Files:**

- Modify: `src/App.jsx`

**Interfaces:**

- Consumes: the existing `supabase` client in `App.jsx`; rows from `tempo_automation_logs`.

A small read-only list so the teacher sees recent cancellations and payments. Single-teacher app, so it reads all recent rows (the table has no per-user column).

- [ ] **Step 1: Add a loader + component**

Add near the other components in `src/App.jsx`:

```jsx
const ACTIVITY_LABELS = {
  cancel: "ביטול שיעור",
  paid: "תשלום התקבל",
  reschedule: "בקשת תיאום מחדש",
};

function ActivityFeed({ supabase }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("tempo_automation_logs")
        .select("student_identifier, action_type, raw_data, created_at")
        .in("action_type", ["cancel", "paid", "reschedule"])
        .order("created_at", { ascending: false })
        .limit(50);
      if (active) setRows(data || []);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  if (rows.length === 0)
    return <p className="text-slate-400 text-sm">אין פעילות להצגה עדיין.</p>;

  return (
    <ul className="space-y-2" dir="rtl">
      {rows.map((r, i) => (
        <li
          key={i}
          className="flex items-center justify-between bg-slate-800/50 border border-slate-700 rounded-xl px-3 py-2 text-sm"
        >
          <span className="text-slate-200">
            {ACTIVITY_LABELS[r.action_type] || r.action_type} —{" "}
            {r.student_identifier}
          </span>
          <span className="text-slate-500 text-xs">
            {new Date(r.created_at).toLocaleString("he-IL")}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Mount it in the UI**

Render `<ActivityFeed supabase={supabase} />` inside the main authenticated view (e.g. near the students list or in a "פעילות" section). Add a heading:

```jsx
<section className="mt-8">
  <h2 className="text-lg font-bold text-slate-100 mb-3">פעילות אחרונה</h2>
  <ActivityFeed supabase={supabase} />
</section>
```

(Place where it fits the existing layout; pass the `supabase` instance already used in `App.jsx`.)

- [ ] **Step 3: Manual UI check**

Run the app (`start-tempo` shortcut). After sending the test messages from Task 2, the "פעילות אחרונה" section should list the cancel / paid / reschedule events with the student identifier and time, newest first.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): activity feed for cancel/paid/reschedule events"
```

---

## Self-Review

- **Spec coverage (Layer 1):** intent detection via Haiku ✅ (Task 1); cancel + paid record/reply ✅ (Task 2); reschedule placeholder ✅ (Task 2); in-app activity ✅ (Task 3). Reschedule slot logic + swaps are Plans 2–3, intentionally excluded.
- **Placeholders:** none — all steps contain full code. (Task 2 Step 1 includes a deliberately-removed placeholder line with the real import beneath it; implementer uses the real line.)
- **Type consistency:** `Intent` used identically in `classify.ts` and the webhook; `REPLIES` keyed by every `Intent` member; log columns match the real schema.
- **Note:** classification adds one Haiku call per inbound message — cheap, and CLAUDE.md mandates Haiku for classification.
