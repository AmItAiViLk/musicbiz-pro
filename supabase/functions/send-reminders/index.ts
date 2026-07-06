/**
 * send-reminders/index.ts — Deno Edge Function
 *
 * Triggered either by pg_cron (automated daily run) or by the Settings UI
 * (manual test). Sends WhatsApp reminders and billing messages via Whapi.cloud.
 *
 * Expected request:
 *   POST /send-reminders
 *   Authorization: Bearer <AUTOMATION_SECRET>
 *   Content-Type: application/json
 *   Body (optional): { "test": true, "userId": "<uuid>" }   ← manual trigger
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTemplate } from "../_shared/meta.ts";
import {
  resolveReminderTargets,
  resolveBillingTargets,
  buildReminderParams,
  buildBillingParams,
  buildPaymentReminderParams,
  Student,
} from "../_shared/messaging.ts";
import {
  isReminderDueTodayIsrael,
  isBillingDay,
  calcMonthlyLessons,
} from "../_shared/holidays.ts";
import { hebrewMonthLabel, yearMonthKey } from "../_shared/schedule.ts";
import { getMorningPaid } from "../_shared/morning.ts";

/** "Now" in Israel local time. */
function nowIsrael(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
}

// ─── Meta WhatsApp template config ──────────────────────────────────────────────
// One central Meta number/token is used for all sends during the single-teacher phase.
// Template names must EXACTLY match the approved names in WhatsApp Manager.
const REMINDER_TEMPLATE = "lesson_reminderlesson_reminder";
const BILLING_TEMPLATE = "monthly_billing";
const PAYMENT_REMINDER_TEMPLATE = "payment_reminder";
const TEMPLATE_LANG = "he";

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ─── DB row → Student mapper ──────────────────────────────────────────────────

// Maps a snake_case DB row to a camelCase Student object.
// Matches the rowToStudent helper in App.jsx, including the 4-toggle fallbacks.
// deno-lint-ignore no-explicit-any
function rowToStudent(row: Record<string, any>): Student {
  return {
    id: row.id,
    name: row.name || "",
    phone: row.phone || "",
    contactName: row.contact_name || "",
    contactPhone: row.contact_phone || "",
    lessonDay: row.lesson_day ?? "",
    lessonTime: row.lesson_time || "",
    price: Number(row.price) || 0,
    reminderToStudent: row.reminder_to_student ?? row.send_to_student ?? true,
    reminderToParent: row.reminder_to_parent ?? false,
    billingToStudent: row.billing_to_student ?? false,
    billingToParent: row.billing_to_parent ?? row.send_to_parent ?? true,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // ── Auth: validate AUTOMATION_SECRET ──────────────────────────────────────
  const automationSecret = Deno.env.get("AUTOMATION_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!automationSecret || bearerToken !== automationSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let isTest = false;
  let requestedUserId: string | null = null;
  let action = "";
  let requestedStudentId = "";

  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      isTest = body?.test === true;
      requestedUserId = body?.userId ?? null;
      action = body?.action ?? "";
      requestedStudentId = body?.studentId ?? "";
    }
  } catch {
    // Non-JSON body is fine (pg_cron sends no body)
  }

  // ── Supabase admin client ──────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Central Meta credentials (single shared WhatsApp number) ───────────────
  const metaToken = Deno.env.get("WHAPI_TOKEN")!; // permanent Meta access token
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;

  // ── Action: send one payment reminder (teacher confirmed in the app) ───────
  if (action === "payment_reminder" && requestedUserId && requestedStudentId) {
    const ymNow = yearMonthKey(nowIsrael());
    const { data: payRow } = await supabase
      .from("payment_status")
      .select("*")
      .eq("user_id", requestedUserId)
      .eq("student_id", requestedStudentId)
      .eq("year_month", ymNow)
      .maybeSingle();
    const { data: stuRow } = await supabase
      .from("students")
      .select("*")
      .eq("id", requestedStudentId)
      .maybeSingle();
    if (!payRow || !stuRow) {
      return new Response(JSON.stringify({ ok: false, error: "not found" }), {
        status: 404,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const student = rowToStudent(stuRow);
    const params = buildPaymentReminderParams(
      Number(payRow.amount) || 0,
      hebrewMonthLabel(payRow.year_month),
    );
    let sent = 0;
    for (const target of resolveBillingTargets(student)) {
      try {
        await sendTemplate(
          metaToken,
          phoneNumberId,
          target.phone,
          PAYMENT_REMINDER_TEMPLATE,
          TEMPLATE_LANG,
          params,
        );
        sent++;
      } catch (err) {
        console.error("payment_reminder send failed:", (err as Error).message);
      }
    }
    await supabase
      .from("payment_status")
      .update({
        reminder_state: "reminded",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payRow.id);
    return new Response(JSON.stringify({ ok: true, sent }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── Fetch eligible user_settings rows ─────────────────────────────────────
  let settingsQuery = supabase
    .from("user_settings")
    .select("*")
    .eq("automation_enabled", true);

  if (isTest && requestedUserId) {
    // Manual test: scope to the requesting user only
    settingsQuery = settingsQuery.eq("user_id", requestedUserId);
  }

  const { data: userRows, error: settingsErr } = await settingsQuery;
  if (settingsErr) {
    console.error("Failed to fetch user_settings:", settingsErr);
    return new Response(JSON.stringify({ error: settingsErr.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── Process each user ──────────────────────────────────────────────────────
  let sent = 0;
  const errors: string[] = [];

  const billingToday = isBillingDay();

  for (const userRow of userRows ?? []) {
    const userId: string = userRow.user_id;

    // Fetch students for this teacher
    const { data: studentRows, error: studentsErr } = await supabase
      .from("students")
      .select("*")
      .eq("user_id", userId);

    if (studentsErr) {
      const msg = `students fetch failed for user ${userId}: ${studentsErr.message}`;
      console.error(msg);
      errors.push(msg);
      continue;
    }

    for (const row of studentRows ?? []) {
      const student = rowToStudent(row);

      // ── Lesson reminder ──────────────────────────────────────────────────
      if (isReminderDueTodayIsrael(student) || isTest) {
        const targets = resolveReminderTargets(student);
        for (const target of targets) {
          try {
            const params = buildReminderParams(student, target.role);
            await sendTemplate(
              metaToken,
              phoneNumberId,
              target.phone,
              REMINDER_TEMPLATE,
              TEMPLATE_LANG,
              params,
            );
            await supabase.from("tempo_automation_logs").insert({
              student_identifier: student.name,
              action_type: "reminder_sent",
              raw_data: params.join(" | "),
            });
            sent++;
          } catch (err) {
            const msg = `reminder failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
            console.error(msg);
            errors.push(msg);
            await supabase.from("tempo_automation_logs").insert({
              student_identifier: student.name,
              action_type: "reminder_error",
              raw_data: msg,
            });
          }
        }
      }

      // ── Monthly billing ──────────────────────────────────────────────────
      if ((billingToday || isTest) && student.price > 0) {
        const monthlyCount = calcMonthlyLessons(student.lessonDay);

        // Record this student as unpaid for the month (foundation for reminders).
        const total = monthlyCount * (student.price ?? 0);
        await supabase.from("payment_status").upsert(
          {
            user_id: userId,
            student_id: student.id,
            student_name: student.name,
            year_month: yearMonthKey(nowIsrael()),
            amount: total,
            status: "unpaid",
            reminder_state: "none",
            billed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          // Do NOT overwrite an existing row (e.g. one already marked paid) if
          // billing is re-run for the same month.
          {
            onConflict: "user_id,student_id,year_month",
            ignoreDuplicates: true,
          },
        );

        const targets = resolveBillingTargets(student);
        for (const target of targets) {
          try {
            const params = buildBillingParams(
              student,
              target.role,
              monthlyCount,
            );
            await sendTemplate(
              metaToken,
              phoneNumberId,
              target.phone,
              BILLING_TEMPLATE,
              TEMPLATE_LANG,
              params,
            );
            await supabase.from("tempo_automation_logs").insert({
              student_identifier: student.name,
              action_type: "billing_sent",
              raw_data: params.join(" | "),
            });
            sent++;
          } catch (err) {
            const msg = `billing failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
            console.error(msg);
            errors.push(msg);
            await supabase.from("tempo_automation_logs").insert({
              student_identifier: student.name,
              action_type: "billing_error",
              raw_data: msg,
            });
          }
        }
      }
    }

    // ── Payment status check + 7-day dunning flag ──────────────────────────
    const { data: unpaidRows } = await supabase
      .from("payment_status")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "unpaid");

    for (const pay of unpaidRows ?? []) {
      // deno-lint-ignore no-explicit-any
      const stu = (studentRows ?? []).find((s: any) => s.id === pay.student_id);
      const mode = stu?.payment_tracking_mode ?? "manual";

      // Auto-read Morning for auto-mode students; never override a manual mark.
      if (
        mode === "morning" &&
        pay.paid_source !== "manual" &&
        userRow.morning_key &&
        userRow.morning_secret
      ) {
        const paid = await getMorningPaid(
          userRow.morning_key,
          userRow.morning_secret,
          pay.student_name,
        );
        if (paid === true) {
          await supabase
            .from("payment_status")
            .update({
              status: "paid",
              paid_source: "morning",
              updated_at: new Date().toISOString(),
            })
            .eq("id", pay.id);
          continue;
        }
      }

      // Flag for the teacher to confirm once 7+ days have passed since billing.
      const days =
        (Date.now() - new Date(pay.billed_at).getTime()) /
        (1000 * 60 * 60 * 24);
      if (days >= 7 && pay.reminder_state === "none") {
        await supabase
          .from("payment_status")
          .update({
            reminder_state: "pending_confirm",
            updated_at: new Date().toISOString(),
          })
          .eq("id", pay.id);
      }
    }
  }

  return new Response(JSON.stringify({ sent, errors }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
