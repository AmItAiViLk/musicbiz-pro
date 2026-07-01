/**
 * classify.ts — student-message intent classifier for Tempo.
 * Uses Haiku to turn a free-text WhatsApp message into a single intent label.
 * One responsibility: text -> Intent.
 */

export type Intent = "cancel" | "paid" | "reschedule" | "other";

const MODEL = "claude-haiku-4-5-20251001";
const VALID: Intent[] = ["cancel", "paid", "reschedule", "other"];

/** Hebrew classification prompt. Instructs the model to answer with a single label. */
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

// ─── Cancellation reason (for the 24h charging policy) ──────────────────────────
// Applies only when a lesson is cancelled less than 24h before it starts.
//   exempt      - illness / force majeure → not charged
//   chargeable  - another lesson/class/party/trip / convenience → charged
//   unknown     - no reason stated → flag for the teacher to decide

export type CancelReason = "exempt" | "chargeable" | "unknown";

const REASONS: CancelReason[] = ["exempt", "chargeable", "unknown"];

export function buildCancelReasonPrompt(text: string): string {
  return [
    "תלמיד ביטל שיעור. סווג את סיבת הביטול לאחת מהקטגוריות:",
    "exempt - מחלה, מקרה חירום, כוח עליון (פטור מתשלום)",
    "chargeable - סיבה רגילה כמו שיעור אחר, חוג, מסיבה, נסיעה, נוחות (מחויב)",
    "unknown - לא צוינה סיבה כלל",
    "ענה במילה אחת בלבד באנגלית מתוך הרשימה, בלי הסבר.",
    "",
    `הודעה: "${text}"`,
  ].join("\n");
}

export function parseCancelReason(raw: string): CancelReason {
  const t = (raw || "").trim().toLowerCase();
  return REASONS.find((r) => t.includes(r)) ?? "unknown";
}

/** Judge whether a late (<24h) cancellation reason is exempt / chargeable / unknown. */
export async function judgeCancelReason(
  apiKey: string,
  text: string,
): Promise<CancelReason> {
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
      messages: [{ role: "user", content: buildCancelReasonPrompt(text) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cancel-reason API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const raw = data?.content?.[0]?.text ?? "";
  return parseCancelReason(raw);
}
