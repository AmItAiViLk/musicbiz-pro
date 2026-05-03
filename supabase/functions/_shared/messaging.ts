/**
 * messaging.ts — Message builders and target resolvers.
 * Pure TypeScript port of the logic in App.jsx (no JSX/React dependencies).
 */

import { calcMonthlyLessons } from "./holidays.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Student {
  id: string;
  name: string;
  phone: string;
  contactName: string;
  contactPhone: string;
  lessonDay: string; // '0'=Sunday … '5'=Friday
  lessonTime: string; // 'HH:MM'
  price: number;
  reminderToStudent: boolean;
  reminderToParent: boolean;
  billingToStudent: boolean;
  billingToParent: boolean;
}

export interface WaTarget {
  phone: string;
  role: "student" | "parent";
  label: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Hebrew weekday names, index-aligned with JS getDay() (0=Sunday … 5=Friday)
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Derives the greeting name and lesson reference phrase for a given message role.
 *
 * Matching CLAUDE.md messaging rules:
 *   - Parent / student has contactName → address parent, reference student by name
 *   - Student, no contactName          → address student, use "שלנו"
 */
function getMsgParts(
  student: Student,
  role: "student" | "parent" | null,
): { greeting: string; lessonRef: string; dayName: string } {
  const asParent =
    role === "parent" || (role === null && !!student.contactName);
  const greeting = asParent
    ? student.contactName || student.name
    : student.name;
  const lessonRef =
    asParent && student.contactName ? `של ${student.name}` : "שלנו";
  const dayName =
    student.lessonDay !== "" && student.lessonDay != null
      ? (DAYS[parseInt(student.lessonDay, 10)] ?? "")
      : "";
  return { greeting, lessonRef, dayName };
}

// ─── Target resolvers ─────────────────────────────────────────────────────────

/**
 * Resolves which WA targets should receive a reminder for this student.
 * Falls back to any available phone if no toggles are on.
 * Matches resolveReminderTargets in App.jsx.
 */
export function resolveReminderTargets(s: Student): WaTarget[] {
  const toStudent = s.reminderToStudent ?? true;
  const toParent = s.reminderToParent ?? false;

  const targets: WaTarget[] = [];
  if (toStudent && s.phone)
    targets.push({ phone: s.phone, role: "student", label: s.name });
  if (toParent && s.contactPhone)
    targets.push({
      phone: s.contactPhone,
      role: "parent",
      label: s.contactName || "הורה",
    });

  // Fallback: if no toggles produced a target, send to any available phone
  if (targets.length === 0) {
    const phone = s.phone || s.contactPhone;
    if (phone)
      targets.push({
        phone,
        role: s.contactPhone ? "parent" : "student",
        label: s.contactName || s.name,
      });
  }
  return targets;
}

/**
 * Resolves which WA targets should receive a billing message for this student.
 * Falls back to any available phone if no toggles are on.
 * Matches resolveBillingTargets in App.jsx.
 */
export function resolveBillingTargets(s: Student): WaTarget[] {
  const toStudent = s.billingToStudent ?? false;
  const toParent = s.billingToParent ?? true;

  const targets: WaTarget[] = [];
  if (toStudent && s.phone)
    targets.push({ phone: s.phone, role: "student", label: s.name });
  if (toParent && s.contactPhone)
    targets.push({
      phone: s.contactPhone,
      role: "parent",
      label: s.contactName || "הורה",
    });

  // Fallback: if no toggles produced a target, send to any available phone
  if (targets.length === 0) {
    const phone = s.phone || s.contactPhone;
    if (phone)
      targets.push({
        phone,
        role: s.contactPhone ? "parent" : "student",
        label: s.contactName || s.name,
      });
  }
  return targets;
}

// ─── Message builders ─────────────────────────────────────────────────────────

/**
 * Builds a lesson reminder message (Hebrew).
 * Template (exact): "היי ${greeting}, מזכיר שהשיעור ${lessonRef} מחר (יום ${dayName}) בשעה ${time}. (ביטול פחות מ-24 ש׳ מראש כרוך בתשלום)."
 */
export function buildReminderMessage(
  s: Student,
  role: "student" | "parent" | null,
): string {
  const { greeting, lessonRef, dayName } = getMsgParts(s, role);
  return `היי ${greeting}, מזכיר שהשיעור ${lessonRef} מחר (יום ${dayName}) בשעה ${s.lessonTime || "—"}. (ביטול פחות מ-24 ש׳ מראש כרוך בתשלום).`;
}

/**
 * Builds a monthly billing message (Hebrew).
 * Template (exact): "היי ${greeting}, החודש צפויים ${count} שיעורים ${lessonRef} (לאחר חגים), הסכום לתשלום הוא ${total} ש"ח. ניתן להעביר בביט/פייבוקס/העברה בנקאית."
 *
 * `monthlyCount` is passed in (already computed by the caller via calcMonthlyLessons)
 * so this function remains a pure string builder with no side effects.
 */
export function buildBillingMessage(
  s: Student,
  role: "student" | "parent" | null,
  monthlyCount: number,
): string {
  const { greeting, lessonRef } = getMsgParts(s, role);
  const count = monthlyCount ?? calcMonthlyLessons(s.lessonDay);
  const total = count * (s.price ?? 0);
  return `היי ${greeting}, החודש צפויים ${count} שיעורים ${lessonRef} (לאחר חגים), הסכום לתשלום הוא ${total} ש"ח. ניתן להעביר בביט/פייבוקס/העברה בנקאית.`;
}
