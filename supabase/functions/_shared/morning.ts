// morning.ts — reads a client's latest income/invoice status from Morning
// (חשבונית ירוקה). Used by the daily payment check to auto-detect paid clients.

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

/** Query Morning for a client's paid state. Non-fatal: returns null on any error. */
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
