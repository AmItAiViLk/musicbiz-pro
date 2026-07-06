/**
 * schedule.ts — pure scheduling helpers (no I/O), shared by the webhook and
 * later by the reschedule/swap engine.
 */

/**
 * Hours from `now` until the next occurrence of a weekly lesson.
 *
 * @param lessonDay  string index '0'=Sunday … '6'=Saturday
 * @param lessonTime 'HH:MM'
 * @param now        current time (already in the teacher's local timezone)
 * @returns hours until the next occurrence (>= 0), or Infinity if inputs invalid.
 */
export function hoursUntilNextLesson(
  lessonDay: string,
  lessonTime: string,
  now: Date,
): number {
  const dayIdx = parseInt(lessonDay, 10);
  if (isNaN(dayIdx) || !lessonTime) return Infinity;
  const [h, m] = lessonTime.split(":").map((x) => parseInt(x, 10));
  if (isNaN(h) || isNaN(m)) return Infinity;

  const dayDiff = (dayIdx - now.getDay() + 7) % 7;
  let candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayDiff,
    h,
    m,
    0,
    0,
  );
  // If that moment already passed (e.g. lesson is today but earlier), jump a week.
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayDiff + 7,
      h,
      m,
      0,
      0,
    );
  }
  return (candidate.getTime() - now.getTime()) / (1000 * 60 * 60);
}

/** True if the next lesson is 24 hours or more away (the free-cancellation window). */
export function isBeyond24h(
  lessonDay: string,
  lessonTime: string,
  now: Date,
): boolean {
  return hoursUntilNextLesson(lessonDay, lessonTime, now) >= 24;
}

/** 'YYYY-MM' for the given date (local components). */
export function yearMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const HEBREW_MONTHS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

/** Hebrew month name for a 'YYYY-MM' string (falls back to the input). */
export function hebrewMonthLabel(yearMonth: string): string {
  const m = parseInt((yearMonth || "").split("-")[1], 10);
  return HEBREW_MONTHS[m - 1] ?? yearMonth;
}
