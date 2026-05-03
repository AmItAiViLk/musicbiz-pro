/**
 * whatsapp.ts — Whapi.cloud client for sending WhatsApp messages.
 * Used by Edge Functions; not imported in the React app.
 */

const WHAPI_URL = "https://gate.whapi.cloud/messages/text";

// ─── normalizePhone ───────────────────────────────────────────────────────────

/**
 * Normalises an Israeli phone number to the international format expected by Whapi
 * (e.g. "972501234567" — no '+', no spaces, no dashes).
 *
 * Rules (matching App.jsx's toWhatsAppNumber):
 *   - Already starts with 972 → keep as-is
 *   - Starts with 0           → replace leading 0 with 972 prefix
 *   - 9-digit number          → prepend 972
 *   - Anything else           → return digits unchanged
 */
export function normalizePhone(phone: string): string {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("972")) return digits; // already international
  if (digits.startsWith("0")) return "972" + digits.slice(1); // Israeli local
  if (digits.length === 9) return "972" + digits; // without leading 0
  return digits;
}

// ─── sendWhatsApp ─────────────────────────────────────────────────────────────

/**
 * Sends a text message via Whapi.cloud.
 *
 * @param token  - Whapi channel token (from user_settings.whapi_token)
 * @param phone  - Recipient phone (will be normalised internally)
 * @param body   - Message text (Hebrew UTF-8)
 * @throws       - On non-2xx HTTP response or network error
 */
export async function sendWhatsApp(
  token: string,
  phone: string,
  body: string,
): Promise<void> {
  const to = normalizePhone(phone);
  if (!to)
    throw new Error(
      `sendWhatsApp: empty phone after normalisation (raw: "${phone}")`,
    );

  const res = await fetch(WHAPI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, body }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "(no body)");
    throw new Error(`Whapi error ${res.status} for ${to}: ${detail}`);
  }
}
