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

/** Default lesson length in minutes (a lesson slot is 45 minutes). */
export const DEFAULT_SLOT_MINUTES = 45;

/** Minutes since midnight for an 'HH:MM' string. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** 'HH:MM' string for minutes since midnight. */
function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

/**
 * Free slots = availability windows minus occupied lessons.
 *
 * Candidate start times are packed back-to-back from each window's start in
 * steps of `slotMinutes`, using the full window without overlap. A candidate is
 * free only if its [start, start+slotMinutes) range does not overlap any
 * occupied lesson (each occupied lesson also spans `slotMinutes`), so a lesson
 * on a non-round time correctly blocks the minutes it actually uses.
 */
export function computeFreeSlots(
  availability: {
    day_of_week: number;
    start_time: string;
    end_time: string;
  }[],
  occupied: { day: number; time: string }[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): FreeSlot[] {
  const busyByDay = new Map<number, number[]>();
  for (const o of occupied) {
    const arr = busyByDay.get(o.day) ?? [];
    arr.push(toMinutes(o.time));
    busyByDay.set(o.day, arr);
  }

  const free: FreeSlot[] = [];
  for (const w of availability) {
    const start = toMinutes(w.start_time);
    const end = toMinutes(w.end_time);
    const busy = busyByDay.get(w.day_of_week) ?? [];
    for (let cur = start; cur + slotMinutes <= end; cur += slotMinutes) {
      const overlaps = busy.some(
        (b) => cur < b + slotMinutes && b < cur + slotMinutes,
      );
      if (!overlaps) free.push({ day: w.day_of_week, time: toTime(cur) });
    }
  }
  return free;
}

/** Hebrew label, e.g. "יום שני 09:00". */
export function slotLabel(slot: FreeSlot): string {
  return `יום ${SLOT_DAYS[slot.day] ?? "?"} ${slot.time}`;
}
