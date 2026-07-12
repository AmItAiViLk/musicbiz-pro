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

/** Hebrew day name for a slot, e.g. "שני". */
export function slotDayName(slot: FreeSlot): string {
  return SLOT_DAYS[slot.day] ?? "?";
}

// ─── Swap-candidate logic (reschedule Layer 2) ──────────────────────────────────

export interface AvailabilityWindow {
  day: number; // 0=Sun … 6=Sat
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface SwapCandidate {
  studentId: string;
  slot: FreeSlot;
}

function hhmmToMin(t: string): number {
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** True if the whole [time, time+slotMinutes) fits within one availability window. */
export function slotFitsAvailability(
  slot: FreeSlot,
  windows: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): boolean {
  const start = hhmmToMin(slot.time);
  const end = start + slotMinutes;
  return windows.some(
    (w) =>
      w.day === slot.day &&
      start >= hhmmToMin(w.start) &&
      end <= hhmmToMin(w.end),
  );
}

/** Subset of free slots that fall within the given availability windows. */
export function slotsFittingAvailability(
  free: FreeSlot[],
  windows: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): FreeSlot[] {
  return free.filter((s) => slotFitsAvailability(s, windows, slotMinutes));
}

/**
 * One-hop swap candidates for a direct (mutual) swap: students whose CURRENT
 * slot falls within the rescheduling student's stated preferences. The
 * rescheduling student takes the candidate's slot; the candidate moves into the
 * rescheduling student's vacated slot — so no free slot is required.
 *
 * Candidates are ordered by the rescheduling student's preference: the window
 * they listed first comes first, then earlier times within a window.
 */
export function findSwapCandidates(
  occupied: { day: number; time: string; studentId: string }[],
  reschedulingStudentId: string,
  studentAvailability: AvailabilityWindow[],
  slotMinutes: number = DEFAULT_SLOT_MINUTES,
): SwapCandidate[] {
  return occupied
    .filter((o) => o.studentId !== reschedulingStudentId)
    .map((o) => {
      const slot = { day: o.day, time: o.time };
      const idx = studentAvailability.findIndex((w) =>
        slotFitsAvailability(slot, [w], slotMinutes),
      );
      return { studentId: o.studentId, slot, idx };
    })
    .filter((c) => c.idx >= 0)
    .sort(
      (a, b) =>
        a.idx - b.idx || hhmmToMin(a.slot.time) - hhmmToMin(b.slot.time),
    )
    .map(({ studentId, slot }) => ({ studentId, slot }));
}
