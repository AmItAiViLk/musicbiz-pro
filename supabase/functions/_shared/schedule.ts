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

// ─── Free-slot computation (reschedule) ─────────────────────────────────────────

export interface FreeSlot {
  day: number; // 0=Sun … 6=Sat
  time: string; // 'HH:MM'
}

const SLOT_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Hourly candidate start times ('HH:MM') within [start, end). */
function hourlySlots(startTime: string, endTime: string): string[] {
  const [sh, sm] = startTime.split(":").map((x) => parseInt(x, 10));
  const [eh, em] = endTime.split(":").map((x) => parseInt(x, 10));
  const endMin = eh * 60 + em;
  const out: string[] = [];
  let cur = sh * 60 + sm;
  while (cur + 60 <= endMin) {
    out.push(
      `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(
        cur % 60,
      ).padStart(2, "0")}`,
    );
    cur += 60;
  }
  return out;
}

/** Free slots = availability windows (hourly) minus occupied (day,time). */
export function computeFreeSlots(
  availability: {
    day_of_week: number;
    start_time: string;
    end_time: string;
  }[],
  occupied: { day: number; time: string }[],
): FreeSlot[] {
  const taken = new Set(occupied.map((o) => `${o.day}|${o.time}`));
  const free: FreeSlot[] = [];
  for (const w of availability) {
    for (const time of hourlySlots(w.start_time, w.end_time)) {
      if (!taken.has(`${w.day_of_week}|${time}`)) {
        free.push({ day: w.day_of_week, time });
      }
    }
  }
  return free;
}

/** Hebrew label, e.g. "יום שני 09:00". */
export function slotLabel(slot: FreeSlot): string {
  return `יום ${SLOT_DAYS[slot.day] ?? "?"} ${slot.time}`;
}
