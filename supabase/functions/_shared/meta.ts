/**
 * meta.ts — Meta WhatsApp Cloud API sender for Tempo Edge Functions.
 *
 * Single responsibility: outbound messaging via graph.facebook.com.
 *   - sendText():     plain text, only valid inside the 24h customer-service window.
 *   - sendTemplate(): a pre-approved template message (required for proactive sends).
 *
 * Credentials are passed in by the caller (from WHAPI_TOKEN / WHATSAPP_PHONE_NUMBER_ID).
 */

import { normalizePhone } from "./whatsapp.ts";
export { normalizePhone };

const GRAPH_VERSION = "v21.0";

/** POST a message payload to the Cloud API. Throws on non-2xx with the Meta error body. */
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

/** Plain-text message payload (24h window only). */
export function buildTextPayload(to: string, body: string) {
  return {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "text",
    text: { body },
  };
}

/** Template message payload. bodyParams fill {{1}}, {{2}}, … in order. */
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

/** Send a plain-text reply (only valid within the 24h customer-service window). */
export function sendText(
  token: string,
  phoneNumberId: string,
  to: string,
  body: string,
): Promise<string> {
  return post(token, phoneNumberId, buildTextPayload(to, body));
}

/** Send a pre-approved template message (required for proactive/business-initiated sends). */
export function sendTemplate(
  token: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  lang: string,
  bodyParams: string[],
): Promise<string> {
  return post(
    token,
    phoneNumberId,
    buildTemplatePayload(to, templateName, lang, bodyParams),
  );
}
