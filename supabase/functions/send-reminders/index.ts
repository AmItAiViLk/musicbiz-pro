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
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import {
  resolveReminderTargets,
  resolveBillingTargets,
  buildReminderMessage,
  buildBillingMessage,
  Student,
} from "../_shared/messaging.ts";
import {
  isReminderDueTodayIsrael,
  isBillingDay,
  calcMonthlyLessons,
} from "../_shared/holidays.ts";

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

  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      isTest = body?.test === true;
      requestedUserId = body?.userId ?? null;
    }
  } catch {
    // Non-JSON body is fine (pg_cron sends no body)
  }

  // ── Supabase admin client ──────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Fetch eligible user_settings rows ─────────────────────────────────────
  let settingsQuery = supabase
    .from("user_settings")
    .select("*")
    .eq("automation_enabled", true)
    .not("whapi_token", "is", null);

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
    const whapiToken: string = userRow.whapi_token;

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
            const message = buildReminderMessage(student, target.role);
            await sendWhatsApp(whapiToken, target.phone, message);
            await supabase.from("tempo_automation_logs").insert({
              user_id: userId,
              student_identifier: student.name,
              event_type: "reminder_sent",
              message,
            });
            sent++;
          } catch (err) {
            const msg = `reminder failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
            console.error(msg);
            errors.push(msg);
          }
        }
      }

      // ── Monthly billing ──────────────────────────────────────────────────
      if ((billingToday || isTest) && student.price > 0) {
        const monthlyCount = calcMonthlyLessons(student.lessonDay);
        const targets = resolveBillingTargets(student);
        for (const target of targets) {
          try {
            const message = buildBillingMessage(
              student,
              target.role,
              monthlyCount,
            );
            await sendWhatsApp(whapiToken, target.phone, message);
            await supabase.from("tempo_automation_logs").insert({
              user_id: userId,
              student_identifier: student.name,
              event_type: "billing_sent",
              message,
            });
            sent++;
          } catch (err) {
            const msg = `billing failed for student ${student.id} (${target.role}): ${(err as Error).message}`;
            console.error(msg);
            errors.push(msg);
          }
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent, errors }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
