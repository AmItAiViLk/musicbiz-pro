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
