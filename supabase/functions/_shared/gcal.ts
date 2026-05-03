/**
 * gcal.ts — Google Calendar helpers for Tempo Edge Functions
 *
 * Handles:
 *  - Refreshing a stored OAuth refresh token → short-lived access token
 *  - Finding available 60-minute slots between 08:30–13:30 (Israel time)
 *  - Creating a new calendar event after an approved reschedule
 */

import { ISRAELI_HOLIDAYS } from "./holidays.ts";

// ─── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface Slot {
  start: string; // ISO datetime (UTC)
  end: string; // ISO datetime (UTC)
  label: string; // Hebrew display string e.g. "יום שני, 14 אפריל בשעה 09:30"
}

export interface AvailabilityWindow {
  day_of_week: number; // 0=Sun … 6=Sat
  start_time: string; // "HH:MM"
  end_time: string; // "HH:MM"
}

/** Default: Sun–Fri 08:30–13:30 */
const DEFAULT_AVAILABILITY: AvailabilityWindow[] = [0, 1, 2, 3, 4, 5].map(
  (d) => ({ day_of_week: d, start_time: "08:30", end_time: "13:30" }),
);

/** Generate all 60-min candidate start times within a window */
function windowStarts(startTime: string, endTime: string): [number, number][] {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const endMinutes = eh * 60 + em;
  const starts: [number, number][] = [];
  let cur = sh * 60 + sm;
  while (cur + 60 <= endMinutes) {
    starts.push([Math.floor(cur / 60), cur % 60]);
    cur += 60;
  }
  return starts;
}

// ─── Timezone utilities ────────────────────────────────────────────────────────

/** Israel day-of-week (0=Sun … 6=Sat) for a UTC Date */
function israelWeekday(date: Date): number {
  const dayStr = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[dayStr] ?? 0;
}

/** "YYYY-MM-DD" in Israel timezone */
function israelDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(date);
}

/**
 * Return the UTC Date that corresponds to israelHour:israelMinute
 * on the Israel-calendar day of `baseUtcDate`.
 */
function israelDateTime(
  baseUtcDate: Date,
  israelHour: number,
  israelMinute: number,
): Date {
  const dateStr = israelDateKey(baseUtcDate); // "YYYY-MM-DD"
  // Candidate: treat the time as UTC, then subtract Israel offset
  const naiveMs = new Date(
    `${dateStr}T${String(israelHour).padStart(2, "0")}:${String(israelMinute).padStart(2, "0")}:00Z`,
  ).getTime();

  // Israel is UTC+2 (winter) or UTC+3 (DST). Try both; keep whichever
  // produces the correct Israel local hour.
  for (const offsetHours of [3, 2]) {
    const candidate = new Date(naiveMs - offsetHours * 3600_000);
    const actualHour = parseInt(
      new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Jerusalem",
        hour: "2-digit",
        hour12: false,
      }).format(candidate),
    );
    if (actualHour === israelHour) return candidate;
  }
  // Fallback
  return new Date(naiveMs - 2 * 3600_000);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Exchange a stored refresh token for a short-lived access token.
 * @throws on HTTP error or missing access_token in response
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

/**
 * Query the teacher's Google Calendar (primary) and return up to `count`
 * free 60-minute slots in the next `lookAheadDays` days.
 * Only slots within the teacher's configured availability windows are considered.
 * Saturday and Israeli holidays are always skipped.
 *
 * If `availability` is empty the DEFAULT_AVAILABILITY (Sun–Fri 08:30–13:30) is used.
 */
export async function findAvailableSlots(
  accessToken: string,
  availability: AvailabilityWindow[] = [],
  lookAheadDays = 10,
  count = 4,
): Promise<Slot[]> {
  const windows = availability.length > 0 ? availability : DEFAULT_AVAILABILITY;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 1); // start from tomorrow
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + lookAheadDays);

  const freebusyRes = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      timeZone: "Asia/Jerusalem",
      items: [{ id: "primary" }],
    }),
  });

  if (!freebusyRes.ok) {
    const err = await freebusyRes.text();
    throw new Error(`Freebusy API error ${freebusyRes.status}: ${err}`);
  }

  const fbData = await freebusyRes.json();
  const busy: Array<{ start: string; end: string }> =
    fbData.calendars?.primary?.busy ?? [];

  const slots: Slot[] = [];

  for (let d = 0; d < lookAheadDays && slots.length < count; d++) {
    const dayUtc = new Date(startDate);
    dayUtc.setDate(dayUtc.getDate() + d);

    const weekday = israelWeekday(dayUtc);

    // Always skip Saturday
    if (weekday === 6) continue;

    // Skip Israeli holidays
    if (ISRAELI_HOLIDAYS.has(israelDateKey(dayUtc))) continue;

    // Get configured windows for this weekday
    const dayWindows = windows.filter((w) => w.day_of_week === weekday);
    if (dayWindows.length === 0) continue; // teacher not available this day

    for (const win of dayWindows) {
      if (slots.length >= count) break;
      for (const [h, m] of windowStarts(win.start_time, win.end_time)) {
        if (slots.length >= count) break;

        const slotStart = israelDateTime(dayUtc, h, m);
        const slotEnd = new Date(slotStart.getTime() + 3600_000); // +1 hour

        // Check overlap with busy periods
        const isBusy = busy.some(({ start, end }) => {
          const bs = new Date(start).getTime();
          const be = new Date(end).getTime();
          return slotStart.getTime() < be && slotEnd.getTime() > bs;
        });

        if (!isBusy) {
          const datePart = new Intl.DateTimeFormat("he-IL", {
            timeZone: "Asia/Jerusalem",
            weekday: "long",
            day: "numeric",
            month: "long",
          }).format(slotStart);
          const timePart = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
            label: `${datePart} בשעה ${timePart}`,
          });
        }
      }
    }
  }

  return slots;
}

/**
 * Create a new Google Calendar event for an approved reschedule.
 * Returns the new event ID.
 */
export async function createCalendarEvent(
  accessToken: string,
  studentName: string,
  instrument: string,
  slot: Slot,
): Promise<string> {
  const summary = instrument
    ? `שיעור ${instrument} — ${studentName}`
    : `שיעור — ${studentName}`;

  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary,
      start: { dateTime: slot.start, timeZone: "Asia/Jerusalem" },
      end: { dateTime: slot.end, timeZone: "Asia/Jerusalem" },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Create event failed ${res.status}: ${JSON.stringify(data)}`,
    );
  }
  return data.id as string;
}
