/**
 * whatsapp-webhook/index.ts — Deno Edge Function (v2)
 *
 * Handles all incoming WhatsApp messages via Whapi.cloud:
 *
 *  Student messages
 *  ─────────────────
 *  • cancel    → notify Amitai
 *  • paid      → log
 *  • reschedule → query Google Calendar, offer 3-4 slots (08:30–13:30 only)
 *  • [digit]   → student is selecting from offered slots → send to Amitai for approval
 *
 *  Teacher messages (from teacher_phone)
 *  ──────────────────────────────────────
 *  • "אשר" / approve → create calendar event, confirm student
 *  • "דחה" / reject  → notify student, close request
 *
 * Webhook URL: POST /whatsapp-webhook?user_id=<uuid>&secret=<WEBHOOK_SECRET>
 *
 * Required Edge Function secrets:
 *   ANTHROPIC_API_KEY, WEBHOOK_SECRET, GOOGLE_CLIENT_SECRET
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { normalizePhone, sendWhatsApp } from "../_shared/whatsapp.ts";
import {
  createCalendarEvent,
  findAvailableSlots,
  refreshAccessToken,
  type AvailabilityWindow,
  type Slot,
} from "../_shared/gcal.ts";

// ─── Types ─────────────────────────────────────────────────────────────────────

type StudentIntent = "cancel" | "paid" | "reschedule" | "other";
type TeacherIntent = "approve" | "reject" | "other";

// ─── Haiku classifiers ─────────────────────────────────────────────────────────

async function classifyStudentIntent(
  text: string,
  anthropic: Anthropic,
): Promise<StudentIntent> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "Classify this WhatsApp message from a music student or parent. Reply with exactly one word:\n" +
        "cancel — student is cancelling or unable to attend\n" +
        "paid — payment confirmation\n" +
        "reschedule — student wants to move/change/postpone lesson to a new time\n" +
        "other — anything else",
      messages: [{ role: "user", content: text }],
    });
    const raw =
      (res.content[0] as { type: string; text: string })?.text
        ?.trim()
        .toLowerCase() ?? "";
    if (["cancel", "paid", "reschedule", "other"].includes(raw)) {
      return raw as StudentIntent;
    }
  } catch (err) {
    console.error("classifyStudentIntent error:", (err as Error).message);
  }
  return "other";
}

async function classifyTeacherIntent(
  text: string,
  anthropic: Anthropic,
): Promise<TeacherIntent> {
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "Teacher is replying about a student reschedule request. Reply with exactly one word:\n" +
        "approve — teacher approves (אשר/מאשר/כן/yes/ok/approved/אוקיי)\n" +
        "reject  — teacher rejects (דחה/לא/no/reject/דחוי)\n" +
        "other   — anything else",
      messages: [{ role: "user", content: text }],
    });
    const raw =
      (res.content[0] as { type: string; text: string })?.text
        ?.trim()
        .toLowerCase() ?? "";
    if (["approve", "reject", "other"].includes(raw)) {
      return raw as TeacherIntent;
    }
  } catch (err) {
    console.error("classifyTeacherIntent error:", (err as Error).message);
  }
  return "other";
}

// ─── Slot selection parser ─────────────────────────────────────────────────────

/** Returns zero-based index of the selected slot, or null if unclear */
function parseSlotSelection(text: string, optionCount: number): number | null {
  // Match a digit 1-N anywhere in the message
  const match = text.match(/[1-9]/);
  if (match) {
    const n = parseInt(match[0]);
    if (n >= 1 && n <= optionCount) return n - 1;
  }
  // Hebrew ordinals
  const ordinals: Record<string, number> = {
    ראשון: 0,
    ראשונה: 0,
    שני: 1,
    שנייה: 1,
    שלישי: 2,
    שלישית: 2,
    רביעי: 3,
    רביעית: 3,
  };
  for (const [word, idx] of Object.entries(ordinals)) {
    if (text.includes(word) && idx < optionCount) return idx;
  }
  return null;
}

// ─── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // ── Auth & routing ───────────────────────────────────────────────────────────
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const userId = url.searchParams.get("user_id");
  const webhookSecret = Deno.env.get("WEBHOOK_SECRET");

  if (!webhookSecret || secret !== webhookSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!userId) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Parse Whapi payload ──────────────────────────────────────────────────────
  // deno-lint-ignore no-explicit-any
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = body?.messages?.[0];
  if (!message || message.from_me === true || !message?.text?.body) {
    return new Response(JSON.stringify({ skipped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawFrom = String(message.from ?? "");
  const fromPhone = normalizePhone(rawFrom.replace(/@s\.whatsapp\.net$/i, ""));
  const messageText: string = message.text.body;

  // ── Supabase + Anthropic clients ─────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  });
  const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

  // ── Load teacher settings + availability once ────────────────────────────────
  const [{ data: settings }, { data: availRows }] = await Promise.all([
    supabase
      .from("user_settings")
      .select(
        "teacher_phone, whapi_token, google_client_id, google_refresh_token",
      )
      .eq("user_id", userId)
      .single(),
    supabase
      .from("teacher_availability")
      .select("day_of_week, start_time, end_time")
      .eq("user_id", userId),
  ]);

  const teacherPhone = normalizePhone(settings?.teacher_phone ?? "");
  const whapiToken: string = settings?.whapi_token ?? "";
  const googleClientId: string = settings?.google_client_id ?? "";
  const googleRefreshToken: string = settings?.google_refresh_token ?? "";
  const availability: AvailabilityWindow[] = (availRows ?? []).map((r) => ({
    day_of_week: r.day_of_week as number,
    start_time: r.start_time as string,
    end_time: r.end_time as string,
  }));

  const ok200 = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEACHER PATH — message is from Amitai's phone
  // ══════════════════════════════════════════════════════════════════════════════
  if (teacherPhone && fromPhone === teacherPhone) {
    // Look for the most recent request awaiting teacher approval
    const { data: pendingList } = await supabase
      .from("reschedule_requests")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false })
      .limit(1);

    const pending = pendingList?.[0];
    if (!pending) {
      // No pending approval — teacher sent a random message, ignore
      return ok200({ source: "teacher", note: "no_pending_approval" });
    }

    const teacherIntent = await classifyTeacherIntent(messageText, anthropic);

    // ── Fetch student details for notifications ──────────────────────────────
    const { data: studentRow } = await supabase
      .from("students")
      .select("name, instrument, phone, contact_phone")
      .eq("id", pending.student_id)
      .single();

    const studentName: string = studentRow?.name ?? "תלמיד";
    const instrument: string = studentRow?.instrument ?? "";
    const studentPhone = normalizePhone(
      studentRow?.phone ?? studentRow?.contact_phone ?? "",
    );
    const selectedSlot: Slot = pending.selected_option;

    if (teacherIntent === "approve") {
      // ── Create Google Calendar event ───────────────────────────────────────
      let calEventId: string | null = null;
      if (googleRefreshToken && googleClientId && googleClientSecret) {
        try {
          const accessToken = await refreshAccessToken(
            googleClientId,
            googleClientSecret,
            googleRefreshToken,
          );
          calEventId = await createCalendarEvent(
            accessToken,
            studentName,
            instrument,
            selectedSlot,
          );
        } catch (err) {
          console.error(
            "Calendar event creation error:",
            (err as Error).message,
          );
        }
      }

      // Update request status
      await supabase
        .from("reschedule_requests")
        .update({
          status: "approved",
          updated_at: new Date().toISOString(),
          ...(calEventId ? { calendar_event_id: calEventId } : {}),
        })
        .eq("id", pending.id);

      // Log
      await supabase.from("tempo_automation_logs").insert({
        user_id: userId,
        student_identifier: studentName,
        event_type: "reschedule_approved",
        message: `אושר: ${selectedSlot.label}`,
      });

      // Confirm to student
      if (whapiToken && studentPhone) {
        await sendWhatsApp(
          whapiToken,
          studentPhone,
          `✅ השיעור אושר!\n📅 ${selectedSlot.label}\n\nמחכים לך 🎵`,
        ).catch(console.error);
      }

      // Acknowledge to teacher
      if (whapiToken) {
        await sendWhatsApp(
          whapiToken,
          teacherPhone,
          `✅ אישרת שיעור עם ${studentName}\n📅 ${selectedSlot.label}${calEventId ? "\n📆 נוסף ליומן" : ""}`,
        ).catch(console.error);
      }

      return ok200({
        source: "teacher",
        action: "approved",
        student: studentName,
      });
    }

    if (teacherIntent === "reject") {
      await supabase
        .from("reschedule_requests")
        .update({ status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", pending.id);

      await supabase.from("tempo_automation_logs").insert({
        user_id: userId,
        student_identifier: studentName,
        event_type: "reschedule_rejected",
        message: `נדחה: ${selectedSlot.label}`,
      });

      if (whapiToken && studentPhone) {
        await sendWhatsApp(
          whapiToken,
          studentPhone,
          `מצטערים, המועד המבוקש אינו זמין.\nאנא פנה שוב ונמצא מועד חלופי 📅`,
        ).catch(console.error);
      }

      return ok200({
        source: "teacher",
        action: "rejected",
        student: studentName,
      });
    }

    // intent === "other" — teacher sent something unrelated
    return ok200({ source: "teacher", intent: "other" });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STUDENT PATH
  // ══════════════════════════════════════════════════════════════════════════════

  // ── Find student by phone ────────────────────────────────────────────────────
  const { data: studentRows, error: findErr } = await supabase
    .from("students")
    .select("*")
    .eq("user_id", userId)
    .or(`phone.eq.${fromPhone},contact_phone.eq.${fromPhone}`)
    .limit(1);

  if (findErr) {
    console.error("Student lookup error:", findErr);
    return new Response(JSON.stringify({ error: findErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const studentRow = studentRows?.[0] ?? null;
  if (!studentRow) {
    console.warn(`Unknown sender ${fromPhone} for user ${userId}`);
    return ok200({ skipped: true, reason: "unknown_sender" });
  }

  const studentId: string = studentRow.id;
  const studentName: string = studentRow.name || "(ללא שם)";

  // ── Check for a pending slot-selection request ───────────────────────────────
  const { data: pendingSelList } = await supabase
    .from("reschedule_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("student_phone", fromPhone)
    .eq("status", "pending_selection")
    .order("created_at", { ascending: false })
    .limit(1);

  const pendingSelection = pendingSelList?.[0];

  if (pendingSelection) {
    // Student is replying with their choice
    const options: Slot[] = pendingSelection.options;
    const idx = parseSlotSelection(messageText, options.length);

    if (idx === null) {
      // Couldn't parse — re-prompt
      if (whapiToken) {
        await sendWhatsApp(
          whapiToken,
          fromPhone,
          `לא הבנתי 😊 אנא שלח מספר בין 1 ל-${options.length} לבחירת המועד.`,
        ).catch(console.error);
      }
      return ok200({ note: "selection_unclear" });
    }

    const chosen = options[idx];

    // Move to awaiting teacher approval
    await supabase
      .from("reschedule_requests")
      .update({
        selected_option: chosen,
        status: "pending_approval",
        updated_at: new Date().toISOString(),
      })
      .eq("id", pendingSelection.id);

    await supabase.from("tempo_automation_logs").insert({
      user_id: userId,
      student_identifier: studentName,
      event_type: "reschedule_selected",
      message: `בחר/ה: ${chosen.label}`,
    });

    // Notify teacher for approval
    if (whapiToken && teacherPhone) {
      await sendWhatsApp(
        whapiToken,
        teacherPhone,
        `📅 בקשת שיבוץ מחדש\n\n👤 ${studentName}\n🕒 ${chosen.label}\n\nלאישור: שלח *אשר*\nלדחייה: שלח *דחה*`,
      ).catch(console.error);
    }

    // Acknowledge to student
    if (whapiToken) {
      await sendWhatsApp(
        whapiToken,
        fromPhone,
        `✓ בחרת: ${chosen.label}\n\nהבקשה נשלחה לאישור המורה — אחזור אליך בקרוב 🎵`,
      ).catch(console.error);
    }

    return ok200({ action: "slot_selected", slot: chosen.label });
  }

  // ── Classify new message intent ──────────────────────────────────────────────
  const intent = await classifyStudentIntent(messageText, anthropic);

  // Log incoming message
  await supabase
    .from("tempo_automation_logs")
    .insert({
      user_id: userId,
      student_identifier: studentName,
      event_type:
        intent === "cancel"
          ? "cancel"
          : intent === "paid"
            ? "paid"
            : intent === "reschedule"
              ? "reschedule_request"
              : "incoming",
      message: messageText,
    })
    .catch(console.error);

  // ── Handle cancel ────────────────────────────────────────────────────────────
  if (intent === "cancel") {
    if (teacherPhone && whapiToken) {
      await sendWhatsApp(
        whapiToken,
        teacherPhone,
        `⚠️ ביטול שיעור: ${studentName}\n"${messageText}"`,
      ).catch(console.error);
    }
    return ok200({ intent: "cancel" });
  }

  // ── Handle reschedule ────────────────────────────────────────────────────────
  if (intent === "reschedule") {
    const hasCalendar =
      googleRefreshToken && googleClientId && googleClientSecret;

    if (!hasCalendar) {
      // Calendar Bot not configured — forward to teacher manually
      if (whapiToken) {
        if (studentRow.phone || studentRow.contact_phone) {
          await sendWhatsApp(
            whapiToken,
            fromPhone,
            `קיבלתי! אעביר את בקשתך למורה ויצור איתך קשר בקרוב 📅`,
          ).catch(console.error);
        }
        if (teacherPhone) {
          await sendWhatsApp(
            whapiToken,
            teacherPhone,
            `📅 ${studentName} מבקש/ת לשנות מועד שיעור.\nיומן לא מחובר — טפל/י ידנית.`,
          ).catch(console.error);
        }
      }
      return ok200({ intent: "reschedule", note: "calendar_not_configured" });
    }

    try {
      const accessToken = await refreshAccessToken(
        googleClientId,
        googleClientSecret,
        googleRefreshToken,
      );
      const slots = await findAvailableSlots(accessToken, availability, 10, 4);

      if (slots.length === 0) {
        if (whapiToken) {
          await sendWhatsApp(
            whapiToken,
            fromPhone,
            `אין מועדים פנויים ב-10 הימים הקרובים.\nנסה שוב מאוחר יותר, או פנה ישירות למורה 🙏`,
          ).catch(console.error);
        }
        return ok200({ intent: "reschedule", note: "no_slots" });
      }

      // Upsert request (replace any previous pending_selection for this student)
      await supabase.from("reschedule_requests").upsert(
        {
          user_id: userId,
          student_id: studentId,
          student_phone: fromPhone,
          options: slots,
          selected_option: null,
          status: "pending_selection",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,student_phone,status" },
      );

      // Send options to student
      const lines = slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
      await sendWhatsApp(
        whapiToken,
        fromPhone,
        `שלום! קיבלתי את בקשתך 😊\n\nהמועדים הזמינים הקרובים:\n${lines}\n\nשלח/י את מספר המועד המועדף (1–${slots.length}).`,
      ).catch(console.error);

      return ok200({ intent: "reschedule", slots: slots.length });
    } catch (err) {
      console.error("Reschedule flow error:", (err as Error).message);

      // Graceful fallback — forward to teacher
      if (whapiToken && teacherPhone) {
        await sendWhatsApp(
          whapiToken,
          teacherPhone,
          `📅 ${studentName} מבקש/ת לשנות מועד שיעור. שגיאה בגישה ליומן — טפל/י ידנית.`,
        ).catch(console.error);
      }
      return ok200({ intent: "reschedule", error: (err as Error).message });
    }
  }

  // ── paid / other ─────────────────────────────────────────────────────────────
  return ok200({ intent });
});
