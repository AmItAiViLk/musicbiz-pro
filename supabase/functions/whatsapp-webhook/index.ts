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
import { classifyIntent, type Intent } from "../_shared/classify.ts";
import {
  computeFreeSlots,
  DEFAULT_SLOT_MINUTES,
  findSwapCandidates,
  type FreeSlot,
  hoursUntilNextLesson,
  slotDayName,
  slotLabel,
  slotsFittingAvailability,
} from "../_shared/schedule.ts";
import { extractAvailability } from "../_shared/availability.ts";
import { sendTemplate } from "../_shared/meta.ts";

const GRAPH_VERSION = "v21.0";

// Proactive swap-request template (partner is usually outside the 24h window).
const SWAP_REQUEST_TEMPLATE = "swap_request";
const TEMPLATE_LANG = "he";

// Per-intent Hebrew replies sent back to the student.
const REPLIES: Record<Intent, string> = {
  cancel: "קיבלנו, ביטלנו את השיעור. נעדכן בהתאם 🙏",
  paid: "תודה! רשמנו את קבלת התשלום 🙏",
  reschedule: "קיבלנו שתרצה לתאם מחדש — נשלח לך אפשרויות בהקדם.",
  other: "שלום! 🎵 קיבלנו את הודעתך. אפשר לכתוב: ביטול, שילמתי, או תיאום מחדש.",
};

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

// ─── Student lookup + cancellation policy ───────────────────────────────────────────

interface StudentRow {
  id: string;
  name: string;
  phone: string;
  contact_phone: string;
  lesson_day: string;
  lesson_time: string;
}

/** "Now" in Israel local time. */
function nowInIsrael(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
}

/** Find the teacher's student whose phone or parent-phone matches the sender. */
async function findStudentByPhone(
  senderPhone: string,
): Promise<StudentRow | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!supabaseUrl || !serviceKey || !userId) return null;
  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    const { data } = await supabase
      .from("students")
      .select("id, name, phone, contact_phone, lesson_day, lesson_time")
      .eq("user_id", userId);
    if (!data) return null;
    return (
      (data as StudentRow[]).find(
        (s) =>
          normalizePhone(s.phone || "") === senderPhone ||
          normalizePhone(s.contact_phone || "") === senderPhone,
      ) ?? null
    );
  } catch (err) {
    console.error("findStudentByPhone error:", (err as Error).message);
    return null;
  }
}

/**
 * Handle a "can't make it" message: apply the 24h policy.
 *  - >= 24h away  → not charged, offer alternative times (reschedule).
 *  - < 24h away   → judge the reason: illness/force-majeure = exempt;
 *                   other plans = charged; no reason = flag for the teacher.
 * Returns the Hebrew reply, a log action, and who it concerns.
 */
async function handleCancel(
  senderPhone: string,
): Promise<{ reply: string; action: string; who: string }> {
  const student = await findStudentByPhone(senderPhone);
  if (!student) {
    return {
      reply: "קיבלנו את הודעתך, נחזור אליך בהקדם 🙏",
      action: "cancel_unmatched",
      who: senderPhone,
    };
  }
  const who = student.name || senderPhone;
  const hours = hoursUntilNextLesson(
    String(student.lesson_day ?? ""),
    String(student.lesson_time ?? ""),
    nowInIsrael(),
  );

  // >= 24h: no policy reminder, just offer an alternative time.
  if (hours >= 24) {
    return {
      reply: "קיבלנו שלא תוכל להגיע. נשלח לך מועדים חלופיים בהקדם 🙏",
      action: "cancel_reschedule",
      who,
    };
  }

  // < 24h: gentle policy reminder + offer alternative. Billing is the teacher's
  // call (this late cancellation is flagged in-app via the cancel_late action).
  return {
    reply:
      "תודה על העדכון 🙏 תזכורת קטנה: ביטול שיעור נעשה לפחות 24 שעות מראש.\nנשמח למצוא לך מועד חלופי — נשלח לך אפשרויות בהקדם.",
    action: "cancel_late",
    who,
  };
}

// ─── Reschedule: offer free slots + handle the student's pick ───────────────────────

/** Offer the teacher's open weekly slots when a student asks to reschedule. */
async function handleReschedule(
  senderPhone: string,
): Promise<{ reply: string; action: string; who: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  const student = await findStudentByPhone(senderPhone);
  if (!supabaseUrl || !serviceKey || !userId || !student) {
    return {
      reply: "קיבלנו שתרצה לתאם מחדש. המורה יחזור אליך בהקדם 🙏",
      action: "reschedule_unmatched",
      who: student?.name || senderPhone,
    };
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: avail } = await supabase
    .from("teacher_availability")
    .select("day_of_week, start_time, end_time")
    .eq("user_id", userId);
  const { data: allStudents } = await supabase
    .from("students")
    .select("lesson_day, lesson_time")
    .eq("user_id", userId);
  const { data: settings } = await supabase
    .from("user_settings")
    .select("lesson_duration_minutes")
    .eq("user_id", userId)
    .maybeSingle();

  const slotMinutes = settings?.lesson_duration_minutes ?? DEFAULT_SLOT_MINUTES;
  const occupied = (allStudents ?? [])
    .filter((s) => s.lesson_day !== null && s.lesson_time)
    .map((s) => ({
      day: parseInt(String(s.lesson_day), 10),
      time: String(s.lesson_time).slice(0, 5),
    }));
  const free = computeFreeSlots(avail ?? [], occupied, slotMinutes).slice(0, 4);

  // Replace any previous open request for this student, then store the new one.
  await supabase
    .from("reschedule_requests")
    .delete()
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection");
  await supabase.from("reschedule_requests").insert({
    user_id: userId,
    student_id: student.id ?? "",
    student_phone: senderPhone,
    options: free,
    kind: "reschedule",
    status: "pending_selection",
  });

  // No free slot anywhere → a mutual swap may still work; ask for availability.
  if (free.length === 0) {
    return {
      reply:
        "כרגע אין חלונות פנויים 🙏 כתוב לי מתי נוח לך, אפשר כמה אפשרויות, ואבדוק אפשרות החלפה מול תלמיד אחר.",
      action: "reschedule_ask_availability",
      who: student.name,
    };
  }

  const lines = free.map(
    (s: FreeSlot, i: number) => `${i + 1}. ${slotLabel(s)}`,
  );
  return {
    reply:
      "אפשר לתאם מחדש 🙏 הנה כמה מועדים פנויים:\n" +
      lines.join("\n") +
      "\n\nהשב במספר שמתאים, ואם אף אחד לא מתאים — כתוב לי מתי כן נוח לך ואבדוק אפשרות החלפה.",
    action: "reschedule_offered",
    who: student.name,
  };
}

/**
 * If the sender has an open reschedule request, treat their message as a slot
 * pick. Returns null when there is no open request (so normal routing runs).
 */
async function handleReschedulePick(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: reqRow } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection")
    .maybeSingle();
  if (!reqRow) return null;

  const options = (reqRow.options ?? []) as FreeSlot[];
  const trimmed = text.trim();
  // Not a numeric pick → let availability handling take over (return null).
  if (!/^\d+$/.test(trimmed)) return null;
  const digit = parseInt(trimmed, 10);
  if (digit < 1 || digit > options.length) {
    const lines = options.map((s, i) => `${i + 1}. ${slotLabel(s)}`);
    return {
      reply: "לא הבנתי את הבחירה. השב במספר מהרשימה:\n" + lines.join("\n"),
      action: "reschedule_pick_invalid",
      who: senderPhone,
    };
  }

  const chosen = options[digit - 1];
  await supabase
    .from("reschedule_requests")
    .update({
      selected_option: chosen,
      status: "pending_approval",
      updated_at: new Date().toISOString(),
    })
    .eq("id", reqRow.id);

  return {
    reply: `בחרת ${slotLabel(chosen)}. העברנו למורה לאישור, נעדכן אותך 🙏`,
    action: "reschedule_picked",
    who: senderPhone,
  };
}

/**
 * The student is mid-reschedule and sent free text instead of a slot number.
 * Parse it as availability, then hunt for a one-hop swap. Returns null if the
 * sender has no active pending_selection request (so the caller keeps routing).
 */
async function handleAvailabilityReply(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("student_phone", senderPhone)
    .eq("status", "pending_selection")
    .maybeSingle();
  if (!req) return null;

  const windows = await extractAvailability(apiKey, text);
  if (windows.length === 0) {
    return {
      reply:
        'לא הצלחתי להבין מתי נוח לך. תוכל לכתוב למשל: "פנוי בימי שני אחרי 16:00"?',
      action: "availability_unparsed",
      who: senderPhone,
    };
  }

  await supabase
    .from("reschedule_requests")
    .update({
      student_availability: windows,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.id);

  // Load schedule inputs.
  const [{ data: avail }, { data: allStudents }, { data: settings }] =
    await Promise.all([
      supabase
        .from("teacher_availability")
        .select("day_of_week, start_time, end_time")
        .eq("user_id", userId),
      supabase
        .from("students")
        .select(
          "id, lesson_day, lesson_time, auto_swap_ok, name, phone, contact_phone",
        )
        .eq("user_id", userId),
      supabase
        .from("user_settings")
        .select("lesson_duration_minutes")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
  const slotMinutes = settings?.lesson_duration_minutes ?? DEFAULT_SLOT_MINUTES;
  const occupied = (allStudents ?? [])
    .filter((s) => s.lesson_day !== null && s.lesson_time)
    .map((s) => ({
      day: parseInt(String(s.lesson_day), 10),
      time: String(s.lesson_time).slice(0, 5),
      studentId: String(s.id),
    }));

  // First: is there now a free slot that fits their stated availability?
  const free = computeFreeSlots(
    avail ?? [],
    occupied.map((o) => ({ day: o.day, time: o.time })),
    slotMinutes,
  );
  const fitting = slotsFittingAvailability(free, windows, slotMinutes).slice(
    0,
    4,
  );
  if (fitting.length > 0) {
    await supabase
      .from("reschedule_requests")
      .update({ options: fitting, updated_at: new Date().toISOString() })
      .eq("id", req.id);
    const lines = fitting.map((s, i) => `${i + 1}. ${slotLabel(s)}`);
    return {
      reply:
        "מצאתי מועדים פנויים שמתאימים לך:\n" +
        lines.join("\n") +
        "\nהשב במספר שמתאים.",
      action: "availability_free_offer",
      who: senderPhone,
    };
  }

  // Else: no free slot fits → try a direct (mutual) swap. The rescheduling
  // student takes the candidate's slot; the candidate moves into the
  // rescheduling student's current slot, so no free slot is needed.
  const aStudent = (allStudents ?? []).find(
    (s) => String(s.id) === String(req.student_id),
  );
  const aSlot: FreeSlot | null =
    aStudent && aStudent.lesson_day !== null && aStudent.lesson_time
      ? {
          day: parseInt(String(aStudent.lesson_day), 10),
          time: String(aStudent.lesson_time).slice(0, 5),
        }
      : null;
  const autoIds = new Set(
    (allStudents ?? []).filter((s) => s.auto_swap_ok).map((s) => String(s.id)),
  );
  // Candidates are ordered by the rescheduling student's stated preference.
  const candidates = findSwapCandidates(
    occupied,
    req.student_id,
    windows,
    slotMinutes,
  );
  if (candidates.length === 0 || !aSlot) {
    await supabase
      .from("reschedule_requests")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", req.id);
    return {
      reply:
        "בדקתי ולא נמצאה כרגע אפשרות החלפה מתאימה. המורה יחזור אליך לתיאום ידני 🙏",
      action: "swap_no_candidates",
      who: senderPhone,
    };
  }

  const first = candidates[0];
  const partner = (allStudents ?? []).find(
    (s) => String(s.id) === first.studentId,
  );
  const partnerAuto = autoIds.has(first.studentId);
  await supabase
    .from("reschedule_requests")
    .update({
      kind: "swap",
      selected_option: first.slot, // the slot the rescheduling student will take
      swap_target_slot: aSlot, // the slot the partner will take (A's current slot)
      swap_target_student_id: first.studentId,
      swap_candidate_ids: candidates,
      status: partnerAuto
        ? "awaiting_swap_partner"
        : "pending_contact_approval",
      deadline_at: partnerAuto
        ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.id);

  if (partnerAuto && partner) {
    // Partner consented in advance → offer them A's slot now via template.
    const token = Deno.env.get("WHAPI_TOKEN") ?? "";
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
    const partnerPhone = partner.phone || partner.contact_phone;
    try {
      await sendTemplate(
        token,
        phoneNumberId,
        partnerPhone,
        SWAP_REQUEST_TEMPLATE,
        TEMPLATE_LANG,
        [partner.name || "היי", slotDayName(aSlot), aSlot.time],
      );
      await logToDb(
        partner.name || partnerPhone,
        "swap_partner_contacted",
        slotLabel(aSlot),
      );
    } catch (err) {
      await logToDb(
        partner.name || partnerPhone,
        "swap_contact_error",
        (err as Error).message,
      );
    }
    return {
      reply: "תודה! בודק אפשרות החלפה מול תלמיד אחר ואעדכן אותך בהקדם 🙏",
      action: "swap_hunt_auto",
      who: senderPhone,
    };
  }

  return {
    reply: "תודה! בודק אפשרות החלפה ואעדכן אותך בהקדם 🙏",
    action: "swap_hunt_pending_teacher",
    who: senderPhone,
  };
}

/** Interpret a Hebrew yes/no reply. Checks negatives first. */
function interpretYesNo(text: string): "yes" | "no" | "unclear" {
  const t = (text || "").trim().toLowerCase();
  const tokens = t.split(/[^֐-׿a-z0-9]+/).filter(Boolean);
  const hasToken = (w: string) => tokens.includes(w);
  if (
    t.includes("אי אפשר") ||
    t.includes("לא מתאים") ||
    t.includes("לא יכול") ||
    t.includes("לא נוח") ||
    t.includes("לצער") ||
    hasToken("לא")
  ) {
    return "no";
  }
  const yesTokens = [
    "כן",
    "בטח",
    "בסדר",
    "מתאים",
    "אפשר",
    "סבבה",
    "אוקיי",
    "אוקי",
    "יאללה",
    "אשמח",
    "מעולה",
    "טוב",
    "ok",
    "yes",
  ];
  if (yesTokens.some(hasToken) || t.includes("👍")) return "yes";
  return "unclear";
}

/**
 * Move an active swap request on to the next candidate (on decline or timeout).
 * The partner's proposed slot stays A's current slot (`swap_target_slot`).
 * Returns true if a next candidate was contacted/queued, false if none remain.
 */
async function advanceSwapToNextCandidate(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  // deno-lint-ignore no-explicit-any
  req: any,
): Promise<boolean> {
  const remaining = (
    (req.swap_candidate_ids ?? []) as {
      studentId: string;
      slot: { day: number; time: string };
    }[]
  ).filter((c) => c.studentId !== req.swap_target_student_id);
  const nowIso = new Date().toISOString();
  if (remaining.length === 0) {
    await supabase
      .from("reschedule_requests")
      .update({ status: "failed", updated_at: nowIso })
      .eq("id", req.id);
    return false;
  }
  const next = remaining[0];
  const { data: nextStudent } = await supabase
    .from("students")
    .select("id, name, phone, contact_phone, auto_swap_ok")
    .eq("id", next.studentId)
    .maybeSingle();
  const partnerAuto = nextStudent?.auto_swap_ok === true;
  await supabase
    .from("reschedule_requests")
    .update({
      swap_target_student_id: next.studentId,
      selected_option: next.slot,
      swap_candidate_ids: remaining,
      status: partnerAuto
        ? "awaiting_swap_partner"
        : "pending_contact_approval",
      deadline_at: partnerAuto
        ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        : null,
      updated_at: nowIso,
    })
    .eq("id", req.id);
  if (partnerAuto && nextStudent && req.swap_target_slot) {
    const token = Deno.env.get("WHAPI_TOKEN") ?? "";
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
    const aSlot = req.swap_target_slot as { day: number; time: string };
    try {
      await sendTemplate(
        token,
        phoneNumberId,
        nextStudent.phone || nextStudent.contact_phone,
        SWAP_REQUEST_TEMPLATE,
        TEMPLATE_LANG,
        [nextStudent.name || "היי", slotDayName(aSlot), aSlot.time],
      );
    } catch (err) {
      await logToDb(
        nextStudent.name || next.studentId,
        "swap_contact_error",
        (err as Error).message,
      );
    }
  }
  return true;
}

/**
 * A student we asked to swap has replied yes/no. Yes → hand the plan to the
 * teacher for final approval. No → move on to the next candidate. Returns null
 * if this sender is not an active swap partner.
 */
async function handleSwapPartnerReply(
  senderPhone: string,
  text: string,
): Promise<{ reply: string; action: string; who: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!supabaseUrl || !serviceKey || !userId) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const partner = await findStudentByPhone(senderPhone);
  if (!partner) return null;
  const { data: req } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("swap_target_student_id", partner.id)
    .eq("status", "awaiting_swap_partner")
    .maybeSingle();
  if (!req) return null;

  const answer = interpretYesNo(text);
  if (answer === "unclear") {
    return {
      reply: "תוכל לאשר לי בכן או לא? 🙏",
      action: "swap_partner_unclear",
      who: partner.name,
    };
  }

  if (answer === "yes") {
    await supabase
      .from("reschedule_requests")
      .update({
        status: "pending_approval",
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.id);
    return {
      reply: "מעולה, תודה! מעביר את ההצעה למורה לאישור סופי ואעדכן אותך 🙏",
      action: "swap_partner_accepted",
      who: partner.name,
    };
  }

  // answer === "no" → move to the next candidate.
  const advanced = await advanceSwapToNextCandidate(supabase, req);
  return {
    reply: advanced
      ? "אין בעיה, תודה על העדכון 🙏"
      : "אין בעיה, תודה. המורה יחזור לתיאום ידני 🙏",
    action: advanced
      ? "swap_partner_declined_next"
      : "swap_partner_declined_failed",
    who: partner.name,
  };
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

  // If the student is mid-reschedule, read this message as their slot pick
  // (before classifying, so a digit isn't treated as a new intent).
  const pick = await handleReschedulePick(senderPhone, text);
  if (pick) {
    await logToDb(pick.who, pick.action, text);
    try {
      await sendMetaReply(token, phoneNumberId, senderPhone, pick.reply);
      await logToDb(pick.who, `${pick.action}_reply`, pick.reply);
    } catch (err) {
      await logToDb(pick.who, "auto_reply_error", (err as Error).message);
    }
    return new Response("OK", { status: 200 });
  }

  // Is this sender a swap partner we're waiting on? (before classification)
  const partnerReply = await handleSwapPartnerReply(senderPhone, text);
  if (partnerReply) {
    await logToDb(partnerReply.who, partnerReply.action, text);
    try {
      await sendMetaReply(
        token,
        phoneNumberId,
        senderPhone,
        partnerReply.reply,
      );
      await logToDb(
        partnerReply.who,
        `${partnerReply.action}_reply`,
        partnerReply.reply,
      );
    } catch (err) {
      await logToDb(
        partnerReply.who,
        "auto_reply_error",
        (err as Error).message,
      );
    }
    return new Response("OK", { status: 200 });
  }

  // Mid-reschedule free text → availability + swap hunt (before classification).
  const availReply = await handleAvailabilityReply(senderPhone, text);
  if (availReply) {
    await logToDb(availReply.who, availReply.action, text);
    try {
      await sendMetaReply(token, phoneNumberId, senderPhone, availReply.reply);
      await logToDb(
        availReply.who,
        `${availReply.action}_reply`,
        availReply.reply,
      );
    } catch (err) {
      await logToDb(availReply.who, "auto_reply_error", (err as Error).message);
    }
    return new Response("OK", { status: 200 });
  }

  // Classify the message intent (best-effort: fall back to "other").
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  let intent: Intent = "other";
  if (!apiKey) {
    await logToDb(senderPhone, "classify_error", "missing ANTHROPIC_API_KEY");
  } else {
    try {
      intent = await classifyIntent(apiKey, text);
    } catch (err) {
      const m = (err as Error).message;
      console.error("classify failed:", m);
      await logToDb(senderPhone, "classify_error", m);
    }
  }

  // Decide the reply + log action. "cancel" runs the 24h policy logic;
  // the others use a fixed Hebrew reply.
  let reply: string;
  let action: string;
  let who: string = senderPhone;

  if (intent === "cancel") {
    const r = await handleCancel(senderPhone);
    reply = r.reply;
    action = r.action;
    who = r.who;
  } else if (intent === "reschedule") {
    const r = await handleReschedule(senderPhone);
    reply = r.reply;
    action = r.action;
    who = r.who;
  } else {
    reply = REPLIES[intent];
    action = intent;
  }

  // Record the resolved action (e.g. cancel_late / cancel_reschedule / paid / other).
  await logToDb(who, action, text);

  // Reply to the student in Hebrew.
  try {
    const result = await sendMetaReply(
      token,
      phoneNumberId,
      senderPhone,
      reply,
    );
    console.log(
      `Reply (${action}) sent to ${senderPhone}. API response: ${result}`,
    );
    await logToDb(who, `${action}_reply`, reply);
  } catch (err) {
    const msg = (err as Error).message;
    console.error("Failed to send reply:", msg);
    await logToDb(who, "auto_reply_error", msg);
  }

  // Always 200 to Meta — a non-2xx triggers webhook retries and duplicate replies.
  return new Response("OK", { status: 200 });
});
