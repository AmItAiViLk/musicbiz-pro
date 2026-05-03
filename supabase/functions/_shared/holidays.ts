/**
 * holidays.ts — Israeli holidays + lesson/billing scheduling helpers.
 * Ported from App.jsx for use in Deno Edge Functions.
 */

// ─── Israeli Holidays ─────────────────────────────────────────────────────────
// Covers 2025–2027. Format: 'YYYY-MM-DD'.
// Lessons that fall on these dates are excluded from the monthly billing count.

export const ISRAELI_HOLIDAYS = new Set<string>([
  // 2025
  "2025-09-22",
  "2025-09-23", // ראש השנה
  "2025-10-01", // יום כיפור
  "2025-10-06",
  "2025-10-07", // סוכות (ראשון ושני)
  "2025-10-13",
  "2025-10-14", // שמחת תורה / שמיני עצרת
  "2025-12-25",
  "2025-12-26", // חנוכה (חופש בתי ספר)
  // 2026
  "2026-03-13", // פורים
  "2026-04-02",
  "2026-04-03",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-04-07",
  "2026-04-08", // פסח
  "2026-04-29", // יום הזיכרון
  "2026-04-30", // יום העצמאות
  "2026-05-22",
  "2026-05-23", // שבועות
  "2026-09-11",
  "2026-09-12", // ראש השנה
  "2026-09-20", // יום כיפור
  "2026-09-25",
  "2026-09-26", // סוכות
  "2026-10-02",
  "2026-10-03", // שמחת תורה
  // 2027
  "2027-03-02", // פורים
  "2027-04-21",
  "2027-04-22",
  "2027-04-23",
  "2027-04-24",
  "2027-04-25",
  "2027-04-26",
  "2027-04-27", // פסח
  "2027-05-19",
  "2027-05-20", // שבועות
]);

// ─── Helper: Israel local time ────────────────────────────────────────────────

/**
 * Returns a Date object representing "now" in the Asia/Jerusalem timezone.
 * We use toLocaleString to reconstruct a local date (not UTC-shifted).
 */
function nowInIsrael(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
}

// ─── calcMonthlyLessons ───────────────────────────────────────────────────────

/**
 * Counts how many times the given weekday occurs in the current month (Israel time),
 * minus any Israeli holidays. `lessonDay` is a string index: '0'=Sunday … '6'=Saturday.
 */
export function calcMonthlyLessons(lessonDay: string): number {
  if (lessonDay === "" || lessonDay == null) return 0;
  const dayIndex = parseInt(lessonDay, 10);
  if (isNaN(dayIndex)) return 0;

  const now = nowInIsrael();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    if (date.getDay() === dayIndex) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (!ISRAELI_HOLIDAYS.has(key)) count++;
    }
  }
  return count;
}

// ─── isReminderDueTodayIsrael ─────────────────────────────────────────────────

/**
 * Returns true if the cron job (assumed to run at 08:00 Israel time) should send
 * a reminder today for this student.
 *
 * Rules (matching The 24h Rule from CLAUDE.md):
 *   - Sunday lesson   → send on Friday (2 days before)
 *   - All other days  → send on the previous calendar day (25h rule resolved at 08:00 cron)
 *
 * `lessonDay` is a string index: '0'=Sunday … '5'=Friday.
 */
export function isReminderDueTodayIsrael(student: {
  lessonDay: string;
  lessonTime: string;
}): boolean {
  if (student.lessonDay === "" || student.lessonDay == null) return false;

  const lessonDayIdx = parseInt(student.lessonDay, 10);
  if (isNaN(lessonDayIdx)) return false;

  const today = nowInIsrael();
  const todayDow = today.getDay(); // 0=Sunday … 6=Saturday

  if (lessonDayIdx === 0) {
    // Sunday lesson → remind on Friday (dow=5)
    return todayDow === 5;
  }

  // All other days: send the day before the lesson (at 08:00 cron, 25h+ before any lesson time)
  const expectedSendDow = (lessonDayIdx - 1 + 7) % 7;
  return todayDow === expectedSendDow;
}

// ─── isBillingDay ─────────────────────────────────────────────────────────────

/**
 * Returns true if today (Israel time) is the 1st of the month —
 * the trigger for sending monthly billing summaries.
 */
export function isBillingDay(): boolean {
  return nowInIsrael().getDate() === 1;
}
