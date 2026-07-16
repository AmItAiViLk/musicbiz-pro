/**
 * whatsapp.ts — phone-number helper for the WhatsApp Cloud API sends.
 * (The old Whapi.cloud client was removed; all sending now goes through meta.ts.)
 */

/**
 * Normalises an Israeli phone number to the international format the WhatsApp
 * Cloud API expects (e.g. "972501234567" — no '+', no spaces, no dashes).
 *
 * Rules (matching App.jsx's toWhatsAppNumber):
 *   - Already starts with 972 → keep as-is
 *   - Starts with 0           → replace leading 0 with the 972 prefix
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
