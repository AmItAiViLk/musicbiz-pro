/**
 * whatsapp-webhook/index.ts — Deno Edge Function
 *
 * Minimal auto-responder on the Meta WhatsApp Cloud API:
 *   1. GET  → answer Meta's webhook verification challenge (hub.challenge).
 *   2. POST → parse the incoming payload, extract sender phone + text,
 *             send one simple automated Hebrew reply, and log every step.
 *
 * Required Edge Function secrets:
 *   WHAPI_TOKEN               — Meta permanent access token (Bearer auth)
 *   WHATSAPP_PHONE_NUMBER_ID  — Meta phone-number ID that sends the reply
 *   WEBHOOK_SECRET            — the verify token entered in Meta's webhook setup
 *   META_APP_SECRET           — Meta App Secret; verifies the X-Hub-Signature-256
 *                               HMAC on every POST so only Meta can trigger replies
 *
 * Optional (enables logging to tempo_automation_logs):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEFAULT_USER_ID
 *
 * Webhook URL (set in Meta dashboard): POST/GET /whatsapp-webhook
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizePhone } from "../_shared/whatsapp.ts";

const GRAPH_VERSION = "v21.0";

// The single canned reply we send back. Hebrew per project rules.
const AUTO_REPLY = "שלום! 🎵 קיבלנו את ההודעה שלך ונחזור אליך בהקדם.";

// ─── Meta WhatsApp Cloud API sender ──────────────────────────────────────────────

/**
 * Sends a plain-text message via the Meta WhatsApp Cloud API.
 *
 * @param token          - Meta permanent access token (WHAPI_TOKEN)
 * @param phoneNumberId  - Sending number's phone-number ID (WHATSAPP_PHONE_NUMBER_ID)
 * @param to             - Recipient phone in international format (e.g. 972501234567)
 * @param body           - Message text (Hebrew UTF-8)
 * @returns the raw response body for logging
 * @throws on non-2xx HTTP response
 */
async function sendMetaReply(
  token: string,
  phoneNumberId: string,
  to: string,
  body: string,
): Promise<string> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  const detail = await res.text().catch(() => "(no body)");
  if (!res.ok) {
    throw new Error(`Meta Cloud API error ${res.status} for ${to}: ${detail}`);
  }
  return detail;
}

// ─── Optional DB logging ──────────────────────────────────────────────────────────

/** Best-effort insert into tempo_automation_logs; never throws. */
async function logToDb(
  studentIdentifier: string,
  eventType: string,
  message: string,
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return; // logging not configured

  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    // Columns match the actual tempo_automation_logs schema:
    //   student_identifier (text), action_type (text), raw_data (text).
    await supabase.from("tempo_automation_logs").insert({
      student_identifier: studentIdentifier,
      action_type: eventType,
      raw_data: message,
    });
  } catch (err) {
    console.error("logToDb error:", (err as Error).message);
  }
}

// ─── Webhook signature verification ────────────────────────────────────────────────

/**
 * Verifies Meta's X-Hub-Signature-256 header: an HMAC-SHA256 of the raw request
 * body keyed by the App Secret. Without this, anyone who knows the public webhook
 * URL could POST a forged payload and make our number send WhatsApp messages to
 * arbitrary recipients. Comparison is constant-time to avoid timing leaks.
 *
 * @param appSecret  - Meta App Secret (META_APP_SECRET)
 * @param signature  - value of the X-Hub-Signature-256 header (e.g. "sha256=ab12…")
 * @param rawBody    - the exact raw request body bytes the signature was computed over
 * @returns true only when the signature is present and valid
 */
async function verifyMetaSignature(
  appSecret: string,
  signature: string,
  rawBody: string,
): Promise<boolean> {
  if (!appSecret || !signature.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(macBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time compare (length-independent) — avoid early-exit timing leaks.
  const a = new TextEncoder().encode(signature);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

// ─── Main handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── 1. Meta webhook verification (GET) ───────────────────────────────────────────
  if (req.method === "GET") {
    const hubMode = url.searchParams.get("hub.mode");
    const hubChallenge = url.searchParams.get("hub.challenge");
    const hubVerifyToken = url.searchParams.get("hub.verify_token");

    if (
      hubMode === "subscribe" &&
      hubVerifyToken === Deno.env.get("WEBHOOK_SECRET")
    ) {
      console.log("Webhook verification succeeded.");
      return new Response(hubChallenge ?? "", { status: 200 });
    }
    console.warn("Webhook verification failed (bad mode or verify token).");
    return new Response("Forbidden", { status: 403 });
  }

  // Anything other than POST from here on is not supported.
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ── 2. Verify the request really came from Meta (X-Hub-Signature-256) ─────────────
  // Read the body ONCE as raw text — the HMAC is computed over these exact bytes,
  // so we cannot use req.json() here (it would consume the stream and re-serialize).
  const rawBody = await req.text();
  const appSecret = Deno.env.get("META_APP_SECRET") ?? "";
  const signature = req.headers.get("x-hub-signature-256") ?? "";

  if (!(await verifyMetaSignature(appSecret, signature, rawBody))) {
    console.warn("Rejected POST: missing or invalid webhook signature.");
    return new Response("Forbidden", { status: 403 });
  }

  // ── 3. Parse the (now-authenticated) Meta WhatsApp Cloud API payload ──────────────
  // deno-lint-ignore no-explicit-any
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("Invalid JSON in webhook body.");
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Meta sends status updates (delivered/read) on the same webhook; those lack a
  // messages array. Optional-chain through the structure and bail out gracefully.
  const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message || message?.type !== "text" || !message?.text?.body) {
    console.log(
      "No inbound text message in payload — acknowledging and skipping.",
    );
    return new Response("OK", { status: 200 });
  }

  const senderPhone = normalizePhone(String(message.from ?? ""));
  const text: string = message.text.body;
  // Avoid writing PII (full phone + message body) to runtime logs; mask the number
  // and log only length. The full content is still recorded in tempo_automation_logs.
  const maskedPhone = senderPhone.replace(/.(?=.{4})/g, "*");
  console.log(`Inbound text from ${maskedPhone} (${text.length} chars).`);
  await logToDb(senderPhone, "incoming", text);

  // ── 3. Send the automated reply ───────────────────────────────────────────────────
  const token = Deno.env.get("WHAPI_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

  if (!token || !phoneNumberId) {
    console.error(
      "Missing WHAPI_TOKEN or WHATSAPP_PHONE_NUMBER_ID secret — cannot send reply.",
    );
    // Still return 200 so Meta doesn't retry; the log above shows the inbound message.
    return new Response("OK", { status: 200 });
  }

  try {
    const result = await sendMetaReply(
      token,
      phoneNumberId,
      senderPhone,
      AUTO_REPLY,
    );
    console.log(`Reply sent to ${senderPhone}. API response: ${result}`);
    await logToDb(senderPhone, "auto_reply", AUTO_REPLY);
  } catch (err) {
    const msg = (err as Error).message;
    console.error("Failed to send reply:", msg);
    await logToDb(senderPhone, "auto_reply_error", msg);
  }

  // Always 200 to Meta — a non-2xx triggers webhook retries and duplicate replies.
  return new Response("OK", { status: 200 });
});
