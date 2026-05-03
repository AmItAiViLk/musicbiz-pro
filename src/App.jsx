import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabase.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWhatsAppNumber(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("972")) return digits; // already international
  if (digits.startsWith("0")) return "972" + digits.slice(1); // Israeli local
  if (digits.length === 9) return "972" + digits; // without leading 0
  return digits;
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Israeli national & school holidays — lessons are typically cancelled on these days
// Format: 'YYYY-MM-DD'. Covers 2025–2027.
const ISRAELI_HOLIDAYS = new Set([
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

function calcMonthlyLessons(lessonDay) {
  if (lessonDay === "" || lessonDay == null) return 0;
  const dayIndex = parseInt(lessonDay);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
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

// Returns the Date when reminder should be sent for this student:
//   Sunday lesson  → Friday at 13:00  (respects 24-hour cancellation rule)
//   Other days     → 25 hours before lesson time
function getReminderSendDate(student) {
  const dayIdx = parseInt(student.lessonDay);
  if (isNaN(dayIdx) || !student.lessonTime || !student.lessonTime.includes(":"))
    return null;
  const [h, m] = student.lessonTime.split(":").map(Number);
  const today = new Date();
  const diff = (dayIdx - today.getDay() + 7) % 7;
  const lessonDate = new Date(today);
  lessonDate.setDate(today.getDate() + (diff === 0 ? 7 : diff));
  lessonDate.setHours(h, m, 0, 0);
  if (dayIdx === 0) {
    // Sunday: send Friday 13:00
    const friday = new Date(lessonDate);
    friday.setDate(lessonDate.getDate() - 2);
    friday.setHours(13, 0, 0, 0);
    return friday;
  }
  return new Date(lessonDate.getTime() - 25 * 60 * 60 * 1000);
}

function isReminderDueToday(student) {
  const d = getReminderSendDate(student);
  if (!d) return false;
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

// Returns YYYY-MM-DD of the next occurrence of dayIndex (today counts if not yet passed)
function getNextOccurrence(dayIndex) {
  const today = new Date();
  const diff = (dayIndex - today.getDay() + 7) % 7;
  const next = new Date(today);
  next.setDate(today.getDate() + (diff === 0 ? 7 : diff));
  return next.toISOString().split("T")[0];
}

// WhatsApp: deep link on mobile (opens app directly), web.whatsapp.com on desktop
function openWhatsApp(phone, message) {
  const number = toWhatsAppNumber(phone);
  const encoded = encodeURIComponent(message);
  const url = isMobileDevice()
    ? `whatsapp://send?phone=${number}&text=${encoded}`
    : `https://web.whatsapp.com/send?phone=${number}&text=${encoded}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

// role: 'student' | 'parent' | null (null = auto-detect from contactName)
function getMsgParts(student, role = null) {
  const asParent =
    role === "parent" || (role === null && !!student.contactName);
  return {
    greeting: asParent ? student.contactName || student.name : student.name,
    lessonRef: asParent && student.contactName ? `של ${student.name}` : "שלנו",
  };
}

// Reminder targets — uses reminder_to_student / reminder_to_parent
function resolveReminderTargets(student) {
  const toStudent = student.reminderToStudent ?? true;
  const toParent = student.reminderToParent ?? false;
  const targets = [];
  if (toStudent && student.phone)
    targets.push({
      phone: student.phone,
      role: "student",
      label: student.name,
    });
  if (toParent && student.contactPhone)
    targets.push({
      phone: student.contactPhone,
      role: "parent",
      label: student.contactName || "הורה",
    });
  if (targets.length === 0) {
    const phone = student.contactPhone || student.phone;
    if (phone)
      targets.push({
        phone,
        role: student.contactPhone ? "parent" : "student",
        label: student.contactName || student.name,
      });
  }
  return targets;
}

// Billing targets — uses billing_to_student / billing_to_parent
function resolveBillingTargets(student) {
  const toStudent = student.billingToStudent ?? false;
  const toParent = student.billingToParent ?? true;
  const targets = [];
  if (toStudent && student.phone)
    targets.push({
      phone: student.phone,
      role: "student",
      label: student.name,
    });
  if (toParent && student.contactPhone)
    targets.push({
      phone: student.contactPhone,
      role: "parent",
      label: student.contactName || "הורה",
    });
  if (targets.length === 0) {
    const phone = student.contactPhone || student.phone;
    if (phone)
      targets.push({
        phone,
        role: student.contactPhone ? "parent" : "student",
        label: student.contactName || student.name,
      });
  }
  return targets;
}

// Alias used for moved-lesson / late-cancel (operational, uses reminder prefs)
const resolveWaTargets = resolveReminderTargets;

function buildReminderMessage(student, role = null) {
  const { greeting, lessonRef } = getMsgParts(student, role);
  const dayName =
    student.lessonDay !== "" && student.lessonDay != null
      ? DAYS[parseInt(student.lessonDay)]
      : "—";
  return `היי ${greeting}, מזכיר שהשיעור ${lessonRef} מחר (יום ${dayName}) בשעה ${student.lessonTime || "—"}. (ביטול פחות מ-24 ש׳ מראש כרוך בתשלום).`;
}

function buildMovedLessonMessage(student, newDayIdx, newTime, role = null) {
  const { greeting, lessonRef } = getMsgParts(student, role);
  const dayName = DAYS[parseInt(newDayIdx)] || "";
  return `היי ${greeting}, רק מעדכן שהשיעור ${lessonRef} הוזז ליום ${dayName} בשעה ${newTime}.`;
}

function buildLateCancellationMessage(student, role = null) {
  const { greeting, lessonRef } = getMsgParts(student, role);
  return `היי ${greeting}, קיבלתי את הודעת הביטול. מכיוון שהביטול נעשה פחות מ-24 שעות לפני השיעור ${lessonRef}, הוא יחויב בתשלום כרגיל.`;
}

function buildBillingMessage(student, role = null) {
  const { greeting, lessonRef } = getMsgParts(student, role);
  const count = calcMonthlyLessons(student.lessonDay);
  const total = count * (Number(student.price) || 0);
  return `היי ${greeting}, החודש צפויים ${count} שיעורים ${lessonRef} (לאחר חגים), הסכום לתשלום הוא ${total} ש"ח. ניתן להעביר בביט/פייבוקס/העברה בנקאית.`;
}

// ─── Supabase row ↔ app object converters ────────────────────────────────────

function dbToStudent(row) {
  return {
    id: row.id,
    name: row.name,
    instrument: row.instrument,
    phone: row.phone || "",
    level: row.level,
    contactName: row.contact_name || "",
    contactPhone: row.contact_phone || "",
    price: row.price || 0,
    lessonDay: row.lesson_day ?? "",
    lessonTime: row.lesson_time || "",
    avatar: row.avatar || "",
    googleEventId: row.google_event_id || null,
    // 4-way communication toggles (fall back to legacy send_to_* if new cols absent)
    reminderToStudent: row.reminder_to_student ?? row.send_to_student ?? true,
    reminderToParent: row.reminder_to_parent ?? false,
    billingToStudent: row.billing_to_student ?? false,
    billingToParent: row.billing_to_parent ?? row.send_to_parent ?? true,
    progress: 0,
    nextLesson: null,
  };
}

function studentToDb(student, userId) {
  return {
    id: student.id,
    user_id: userId,
    name: student.name,
    instrument: student.instrument,
    phone: student.phone,
    level: student.level,
    contact_name: student.contactName,
    contact_phone: student.contactPhone,
    price: student.price,
    lesson_day: student.lessonDay,
    lesson_time: student.lessonTime,
    avatar: student.avatar,
    google_event_id: student.googleEventId,
    reminder_to_student: student.reminderToStudent ?? true,
    reminder_to_parent: student.reminderToParent ?? false,
    billing_to_student: student.billingToStudent ?? false,
    billing_to_parent: student.billingToParent ?? true,
  };
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GCAL_BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

async function createOrUpdateCalendarEvent(student, token) {
  const dayCode = GCAL_BYDAY[parseInt(student.lessonDay)];
  const startDate = getNextOccurrence(parseInt(student.lessonDay));
  const [h, m] = student.lessonTime.split(":");
  const endHour = String(parseInt(h) + 1).padStart(2, "0");

  const event = {
    summary:
      `שיעור ${student.instrument !== "לא צוין" ? student.instrument : ""} — ${student.name}`.trim(),
    description: [
      `תלמיד: ${student.name}`,
      student.instrument !== "לא צוין" ? `כלי: ${student.instrument}` : "",
      `רמה: ${student.level}`,
      student.contactName ? `הורה: ${student.contactName}` : "",
      student.price ? `מחיר לשיעור: ₪${student.price}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    start: {
      dateTime: `${startDate}T${student.lessonTime}:00`,
      timeZone: "Asia/Jerusalem",
    },
    end: {
      dateTime: `${startDate}T${endHour}:${m}:00`,
      timeZone: "Asia/Jerusalem",
    },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${dayCode}`],
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 1440 },
      ],
    },
  };

  const isUpdate = !!student.googleEventId;
  const url = isUpdate
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${student.googleEventId}`
    : "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  const res = await fetch(url, {
    method: isUpdate ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return await res.json(); // { id, ... }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];
const DAY_IDX = [0, 1, 2, 3, 4, 5];

const AVATAR_COLORS = [
  "bg-indigo-500",
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
];

const NAV_ITEMS = [
  {
    id: "schedule",
    label: "לוח שיעורים",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    ),
  },
  {
    id: "students",
    label: "תלמידים",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    id: "invoices",
    label: "חשבוניות",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "הגדרות",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

const VIEW_LABELS = {
  schedule: "לוח שיעורים",
  students: "תלמידים",
  invoices: "חשבוניות",
  settings: "הגדרות",
};

// ─── Quick Import Parser ──────────────────────────────────────────────────────

const QI_DAY_MAP = {
  // Hebrew (with and without יום prefix)
  ראשון: 0,
  "יום ראשון": 0,
  שני: 1,
  "יום שני": 1,
  שלישי: 2,
  "יום שלישי": 2,
  רביעי: 3,
  "יום רביעי": 3,
  חמישי: 4,
  "יום חמישי": 4,
  שישי: 5,
  "יום שישי": 5,
  שבת: 6,
  "יום שבת": 6,
  // English full
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  // English abbreviated
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

// Parses multi-line text like:
//   ישראל - שני 16:00
//   שרה - Tuesday 17:30
// Returns array of partial student objects ready for import.
function parseQuickImport(text) {
  return text
    .split("\n")
    .flatMap((line) => line.split(",")) // support comma-separated on one line
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      // Split on first dash/em-dash/en-dash
      const sepIdx = entry.search(/\s*[-–—]\s*/);
      if (sepIdx === -1) return null;
      const name = entry.slice(0, sepIdx).trim();
      if (!name) return null;
      const rest = entry
        .slice(sepIdx)
        .replace(/^[-–—\s]+/, "")
        .trim();

      // Extract HH:MM or H:MM
      const timeMatch = rest.match(/\b(\d{1,2}):(\d{2})\b/);
      const lessonTime = timeMatch
        ? `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`
        : "";

      // Extract day: remove time, trim, lowercase for lookup
      const dayRaw = rest.replace(timeMatch ? timeMatch[0] : "", "").trim();
      const dayKey = dayRaw.toLowerCase();
      const dayIdx = QI_DAY_MAP[dayRaw] ?? QI_DAY_MAP[dayKey];
      const lessonDay = dayIdx !== undefined ? String(dayIdx) : "";

      return { name, lessonDay, lessonTime };
    })
    .filter(Boolean);
}

// ─── Quick Import Box ─────────────────────────────────────────────────────────

function QuickImportBox({ onImport }) {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);

  // Only import entries that have name + day + time (no partial/fake data)
  const parsed = parseQuickImport(text);
  const valid = parsed.filter(
    (p) => p.name && p.lessonDay !== "" && p.lessonTime,
  );

  function handleImport() {
    if (valid.length === 0) return;
    onImport(valid);
    setDone(true);
    setTimeout(() => {
      setText("");
      setDone(false);
    }, 2000);
  }

  return (
    <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-4 space-y-3">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
        ייבוא מהיר
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"ישראל - שני 16:00\nשרה - שלישי 17:30"}
        rows={3}
        dir="rtl"
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40 transition resize-none font-mono"
      />

      {valid.length > 0 && (
        <div className="space-y-1 max-h-28 overflow-y-auto">
          {valid.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              <span className="text-white font-semibold">{s.name}</span>
              <span className="text-slate-400">
                {DAYS[parseInt(s.lessonDay)]} {s.lessonTime}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={handleImport}
        disabled={valid.length === 0 || done}
        className={`w-full text-sm font-bold py-2.5 rounded-xl transition-all ${
          done
            ? "bg-emerald-600 text-white"
            : valid.length > 0
              ? "bg-indigo-600 hover:bg-indigo-500 text-white"
              : "bg-slate-800 text-slate-600 cursor-not-allowed"
        }`}
      >
        {done
          ? `✓ ${valid.length} תלמידים נוספו`
          : valid.length > 0
            ? `הוסף ${valid.length} תלמידים`
            : "שם - יום שעה"}
      </button>
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function WhatsAppButton({ phone }) {
  if (!phone) return null;
  const number = toWhatsAppNumber(phone);
  const href = isMobileDevice()
    ? `whatsapp://send?phone=${number}`
    : `https://web.whatsapp.com/send?phone=${number}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center justify-center w-7 h-7 text-emerald-400 hover:text-emerald-300 transition-colors shrink-0"
      title="פתח WhatsApp"
    >
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    </a>
  );
}

// ─── Student Form ─────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  instrument: "",
  phone: "",
  level: "מתחיל",
  contactName: "",
  contactPhone: "",
  price: "",
  lessonDay: "",
  lessonTime: "",
  reminderToStudent: true,
  reminderToParent: false,
  billingToStudent: false,
  billingToParent: true,
};

function StudentForm({
  initial = EMPTY_FORM,
  onSave,
  onClose,
  onDelete,
  title,
  saveLabel,
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave({
      name: form.name.trim(),
      instrument: form.instrument.trim() || "לא צוין",
      phone: form.phone.trim(),
      level: form.level,
      contactName: form.contactName.trim(),
      contactPhone: form.contactPhone.trim(),
      price: form.price !== "" ? Number(form.price) : 0,
      lessonDay: form.lessonDay,
      lessonTime: form.lessonTime.trim(),
      reminderToStudent: form.reminderToStudent,
      reminderToParent: form.reminderToParent,
      billingToStudent: form.billingToStudent,
      billingToParent: form.billingToParent,
    });
    onClose();
  }

  const inp =
    "w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40 transition";
  const lbl = "block text-xs font-medium text-slate-400 mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-[#16161d] border border-white/[0.07] rounded-t-3xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[92dvh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
          <h3 className="font-bold text-white text-base">{title}</h3>
          <div className="flex items-center gap-1">
            {onDelete && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-colors"
                title="מחק תלמיד"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-white/[0.05] rounded-xl transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="overflow-y-auto flex-1 p-5 space-y-5"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={lbl}>שם מלא *</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="ישראל ישראלי"
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>כלי נגינה</label>
              <input
                type="text"
                value={form.instrument}
                onChange={(e) => set("instrument", e.target.value)}
                placeholder="פסנתר, גיטרה..."
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>רמה</label>
              <select
                value={form.level}
                onChange={(e) => set("level", e.target.value)}
                className={inp}
              >
                <option>מתחיל</option>
                <option>בינוני</option>
                <option>מתקדם</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className={lbl}>טלפון תלמיד</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="050-000-0000"
                dir="ltr"
                className={inp}
              />
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
              איש קשר (הורה)
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>שם ההורה</label>
                <input
                  type="text"
                  value={form.contactName}
                  onChange={(e) => set("contactName", e.target.value)}
                  placeholder="רחל כהן"
                  className={inp}
                />
              </div>
              <div>
                <label className={lbl}>טלפון הורה</label>
                <input
                  type="tel"
                  value={form.contactPhone}
                  onChange={(e) => set("contactPhone", e.target.value)}
                  placeholder="050-000-0000"
                  dir="ltr"
                  className={inp}
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
              שליחת הודעות
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-slate-800 rounded-xl p-2.5 space-y-2">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                  תזכורות
                </p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.reminderToStudent}
                    onChange={(e) => set("reminderToStudent", e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 shrink-0"
                  />
                  <span className="text-slate-300">לתלמיד</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.reminderToParent}
                    onChange={(e) => set("reminderToParent", e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 shrink-0"
                  />
                  <span className="text-slate-300">להורה</span>
                </label>
              </div>
              <div className="bg-slate-800 rounded-xl p-2.5 space-y-2">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                  חיוב
                </p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.billingToStudent}
                    onChange={(e) => set("billingToStudent", e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 shrink-0"
                  />
                  <span className="text-slate-300">לתלמיד</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.billingToParent}
                    onChange={(e) => set("billingToParent", e.target.checked)}
                    className="w-4 h-4 accent-indigo-500 shrink-0"
                  />
                  <span className="text-slate-300">להורה</span>
                </label>
              </div>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
              שיעור וחיוב
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={lbl}>יום קבוע</label>
                <select
                  value={form.lessonDay}
                  onChange={(e) => set("lessonDay", e.target.value)}
                  className={inp}
                >
                  <option value="">יום</option>
                  <option value="0">ראשון</option>
                  <option value="1">שני</option>
                  <option value="2">שלישי</option>
                  <option value="3">רביעי</option>
                  <option value="4">חמישי</option>
                  <option value="5">שישי</option>
                  <option value="6">שבת</option>
                </select>
              </div>
              <div>
                <label className={lbl}>שעה</label>
                <input
                  type="time"
                  value={form.lessonTime}
                  onChange={(e) => set("lessonTime", e.target.value)}
                  dir="ltr"
                  className={inp}
                />
              </div>
              <div>
                <label className={lbl}>מחיר (₪)</label>
                <input
                  type="number"
                  min="0"
                  value={form.price}
                  onChange={(e) => set("price", e.target.value)}
                  placeholder="160"
                  dir="ltr"
                  className={inp}
                />
              </div>
            </div>
          </div>
        </form>

        {confirmDelete ? (
          <div className="px-5 py-4 border-t border-slate-800 shrink-0 space-y-3">
            <p className="text-sm text-center text-slate-300">
              למחוק את <span className="font-bold text-white">{form.name}</span>
              ? לא ניתן לבטל פעולה זו.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-semibold py-3 rounded-xl transition-colors"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white text-sm font-bold py-3 rounded-xl transition-colors"
              >
                כן, מחק
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-3 px-5 py-4 border-t border-slate-800 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-semibold py-3 rounded-xl transition-colors"
            >
              ביטול
            </button>
            <button
              onClick={handleSubmit}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-3 rounded-xl transition-colors shadow-lg shadow-indigo-900/40"
            >
              {saveLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Today's Reminders Panel ─────────────────────────────────────────────────

// ─── WA Choice Modal ─────────────────────────────────────────────────────────

const WA_ICON = (
  <svg
    className="w-4 h-4 text-emerald-400 shrink-0"
    fill="currentColor"
    viewBox="0 0 24 24"
  >
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

function WaChoiceModal({ targets, buildMessage, onClose }) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      dir="rtl"
    >
      <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 w-full max-w-xs space-y-3">
        <p className="font-bold text-white text-center text-sm">שלח הודעה ל:</p>
        <div className="space-y-2">
          {targets.map((t) => (
            <button
              key={t.role}
              onClick={() => {
                openWhatsApp(t.phone, buildMessage(t.role));
                onClose();
              }}
              className="w-full flex items-center gap-3 bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold py-3 px-4 rounded-xl transition-colors"
            >
              {WA_ICON}
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="w-full text-sm text-slate-400 border border-slate-700 hover:border-slate-600 py-2.5 rounded-xl transition-colors"
        >
          ביטול
        </button>
      </div>
    </div>
  );
}

function TodayRemindersPanel({ students }) {
  const [waChoice, setWaChoice] = useState(null);
  const dueToday = students.filter(
    (s) => resolveWaTargets(s).length > 0 && isReminderDueToday(s),
  );

  function sendWa(s) {
    const targets = resolveWaTargets(s);
    if (targets.length === 1)
      openWhatsApp(targets[0].phone, buildReminderMessage(s, targets[0].role));
    else
      setWaChoice({
        targets,
        buildMessage: (role) => buildReminderMessage(s, role),
      });
  }

  return (
    <>
      {waChoice && (
        <WaChoiceModal
          targets={waChoice.targets}
          buildMessage={waChoice.buildMessage}
          onClose={() => setWaChoice(null)}
        />
      )}
      {dueToday.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-amber-400 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <p className="text-sm font-bold text-amber-300">
              {dueToday.length} תזכורות לשלוח היום
            </p>
          </div>
          <div className="space-y-2">
            {dueToday.map((s) => {
              const isSundayLesson = parseInt(s.lessonDay) === 0;
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 bg-white/[0.02] rounded-xl px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      {s.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {isSundayLesson ? "שיעור ביום ראשון" : "שיעור מחר"} ·{" "}
                      {s.lessonTime}
                    </p>
                  </div>
                  <button
                    onClick={() => sendWa(s)}
                    className="flex items-center gap-1.5 text-xs font-bold text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg transition-all shrink-0"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                    שלח
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Moved Lesson Modal ───────────────────────────────────────────────────────

function MovedLessonModal({
  student,
  initialDay = "",
  initialTime = "",
  onClose,
}) {
  const [newDay, setNewDay] = useState(initialDay);
  const [newTime, setNewTime] = useState(initialTime);
  const [waChoice, setWaChoice] = useState(null);

  function sendWa() {
    const targets = resolveWaTargets(student);
    if (targets.length === 0) return;
    if (targets.length === 1) {
      openWhatsApp(
        targets[0].phone,
        buildMovedLessonMessage(student, newDay, newTime, targets[0].role),
      );
      onClose();
    } else
      setWaChoice({
        targets,
        buildMessage: (role) =>
          buildMovedLessonMessage(student, newDay, newTime, role),
      });
  }

  const hasTarget = resolveWaTargets(student).length > 0;

  const inp =
    "w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40 transition";

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
      dir="rtl"
    >
      <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-bold text-white">שיעור הוזז — {student.name}</p>
          <button
            onClick={onClose}
            className="p-1 text-slate-500 hover:text-white"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              יום חדש
            </label>
            <select
              value={newDay}
              onChange={(e) => setNewDay(e.target.value)}
              className={inp}
            >
              <option value="">בחר יום</option>
              {DAYS.map((d, i) => (
                <option key={i} value={String(i)}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              שעה חדשה
            </label>
            <input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className={inp}
            />
          </div>
          {newDay !== "" && newTime && (
            <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl p-3 text-xs text-slate-300 leading-relaxed">
              {buildMovedLessonMessage(student, newDay, newTime)}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 text-sm font-semibold text-slate-400 border border-slate-700 hover:border-slate-600 rounded-xl py-2.5 transition-colors"
          >
            ביטול
          </button>
          <button
            onClick={sendWa}
            disabled={!newDay || !newTime || !hasTarget}
            className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
          >
            שלח WhatsApp
          </button>
        </div>
      </div>
      {waChoice && (
        <WaChoiceModal
          targets={waChoice.targets}
          buildMessage={waChoice.buildMessage}
          onClose={() => {
            setWaChoice(null);
            onClose();
          }}
        />
      )}
    </div>
  );
}

// ─── Cal Changes Modal ────────────────────────────────────────────────────────

function CalChangesModal({ changes, onClose }) {
  const [waChoice, setWaChoice] = useState(null);

  function sendWa(c) {
    const targets = resolveWaTargets(c.student);
    if (targets.length === 0) return;
    if (targets.length === 1)
      openWhatsApp(
        targets[0].phone,
        buildMovedLessonMessage(
          c.student,
          c.newDay,
          c.newTime,
          targets[0].role,
        ),
      );
    else
      setWaChoice({
        targets,
        buildMessage: (role) =>
          buildMovedLessonMessage(c.student, c.newDay, c.newTime, role),
      });
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
      dir="rtl"
    >
      <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl w-full max-w-md max-h-[70vh] flex flex-col">
        <div className="flex items-center gap-3 p-5 border-b border-slate-800">
          <div className="w-9 h-9 bg-amber-500/10 rounded-xl flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5 text-amber-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="font-bold text-white">שינויים ב-Google Calendar</p>
            <p className="text-xs text-slate-400">
              {changes.length} שיעורים הוזזו
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {changes.map((c, i) => {
            const oldDay = DAYS[parseInt(c.student.lessonDay)] || "?";
            const newDay = DAYS[parseInt(c.newDay)] || "?";
            const hasTarget = resolveWaTargets(c.student).length > 0;
            return (
              <div
                key={i}
                className="bg-white/[0.03] border border-white/[0.07] rounded-xl p-4 space-y-2"
              >
                <p className="font-semibold text-white">{c.student.name}</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400 line-through">
                    {oldDay} {c.student.lessonTime}
                  </span>
                  <svg
                    className="w-3 h-3 text-amber-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    viewBox="0 0 24 24"
                  >
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  <span className="text-amber-300 font-semibold">
                    {newDay} {c.newTime}
                  </span>
                </div>
                {hasTarget && (
                  <button
                    onClick={() => sendWa(c)}
                    className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 py-2 rounded-lg transition-all"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                    שלח הודעת הזזה
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="border-t border-slate-800 p-4">
          <button
            onClick={onClose}
            className="w-full text-sm font-semibold text-slate-400 border border-slate-700 hover:border-slate-600 rounded-xl py-2.5 transition-colors"
          >
            סגור
          </button>
        </div>
      </div>
      {waChoice && (
        <WaChoiceModal
          targets={waChoice.targets}
          buildMessage={waChoice.buildMessage}
          onClose={() => setWaChoice(null)}
        />
      )}
    </div>
  );
}

// ─── Schedule View ────────────────────────────────────────────────────────────

function ScheduleView({
  students,
  onEditStudent,
  googleToken,
  onSyncCalendar,
  onOpenImport,
  onConnectGoogle,
  clientId,
  onImportStudents,
}) {
  const today = new Date();
  const todayDayIdx = today.getDay();
  const [selectedDay, setSelectedDay] = useState(
    todayDayIdx <= 5 ? todayDayIdx : 0,
  );

  // Robust check: lessonDay can be string "0"-"6" or int 0-6; treat "" / null / undefined as unset
  function hasSchedule(s) {
    const d = s.lessonDay;
    const t = s.lessonTime;
    const daySet = d !== "" && d !== null && d !== undefined;
    const dayValid = daySet && !isNaN(parseInt(d));
    const timeSet = typeof t === "string" && t.includes(":") && t.length >= 3;
    return dayValid && timeSet;
  }

  const scheduledStudents = students.filter(hasSchedule);
  const todayStudents = students.filter(
    (s) => hasSchedule(s) && parseInt(s.lessonDay) === todayDayIdx,
  );

  // Build grid data: time → dayIdx → students[]
  const allTimes = [
    ...new Set(scheduledStudents.map((s) => s.lessonTime)),
  ].sort();
  const gridData = {};
  for (const t of allTimes) {
    gridData[t] = {};
    for (const d of DAY_IDX) gridData[t][d] = [];
  }
  for (const s of scheduledStudents) {
    const d = parseInt(s.lessonDay);
    if (DAY_IDX.includes(d) && gridData[s.lessonTime])
      gridData[s.lessonTime][d].push(s);
  }

  const stats = [
    {
      label: "שיעורים מתוזמנים",
      value: scheduledStudents.length,
      color: "text-indigo-400",
    },
    {
      label: "שיעורים היום",
      value: todayStudents.length,
      color: "text-emerald-400",
    },
    { label: "תלמידים פעילים", value: students.length, color: "text-blue-400" },
  ];

  const emptyState = (
    <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-12 flex flex-col items-center text-center">
      <div className="w-14 h-14 bg-slate-800 rounded-full flex items-center justify-center mb-4">
        <svg
          className="w-7 h-7 text-slate-600"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </div>
      <p className="font-semibold text-slate-300 mb-1">לוח השיעורים ריק</p>
      <p className="text-sm text-slate-500">הוסף תלמידים עם יום ושעה קבועים</p>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">לוח שיעורים</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            {today.toLocaleDateString("he-IL", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        {googleToken ? (
          <button
            onClick={onOpenImport}
            className="flex items-center gap-2 text-xs font-bold text-blue-400 border border-blue-500/30 hover:border-blue-400 hover:bg-blue-500/10 px-3 py-2 rounded-xl transition-all shrink-0"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            ייבא מ-Google Calendar
          </button>
        ) : clientId ? (
          <button
            onClick={() => onConnectGoogle(clientId)}
            className="flex items-center gap-2 text-xs font-bold text-slate-300 border border-slate-700 hover:border-blue-500/50 hover:text-blue-400 hover:bg-blue-500/10 px-3 py-2 rounded-xl transition-all shrink-0"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            חבר Google Calendar
          </button>
        ) : null}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-3 sm:p-4"
          >
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium leading-tight">
              {s.label}
            </p>
            <p className={`text-2xl sm:text-3xl font-bold mt-1 ${s.color}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Quick Import */}
      <QuickImportBox onImport={onImportStudents} />

      {/* Today's Reminders */}
      <TodayRemindersPanel students={students} />

      {/* ── Mobile: day tabs + list ── */}
      <div className="md:hidden">
        {scheduledStudents.length === 0 ? (
          emptyState
        ) : (
          <>
            {/* Day selector */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide -mx-1 px-1">
              {DAYS.map((day, i) => {
                const hasStudents = scheduledStudents.some(
                  (s) => parseInt(s.lessonDay) === i,
                );
                const isToday = i === todayDayIdx;
                return (
                  <button
                    key={day}
                    onClick={() => setSelectedDay(i)}
                    className={`shrink-0 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                      selectedDay === i
                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/40"
                        : isToday
                          ? "bg-slate-800 text-indigo-400 border border-indigo-500/40"
                          : "bg-slate-900 text-slate-400 border border-slate-800"
                    } ${!hasStudents && selectedDay !== i ? "opacity-40" : ""}`}
                  >
                    {day}
                    {isToday && (
                      <span className="block text-[9px] font-normal opacity-70 mt-0.5">
                        היום
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Day list */}
            <div className="space-y-2 mt-3">
              {(() => {
                const dayStudents = scheduledStudents
                  .filter((s) => parseInt(s.lessonDay) === selectedDay)
                  .sort((a, b) => a.lessonTime.localeCompare(b.lessonTime));
                if (dayStudents.length === 0)
                  return (
                    <p className="text-center text-slate-500 py-10 text-sm">
                      אין שיעורים ביום זה
                    </p>
                  );
                return dayStudents.map((s) => {
                  const idx = students.indexOf(s);
                  const waPhone = s.contactPhone || s.phone;
                  return (
                    <div
                      key={s.id}
                      onClick={() => onEditStudent(s)}
                      className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-4 flex items-center gap-3 active:bg-white/[0.06] cursor-pointer"
                    >
                      <div className="text-center shrink-0 w-12">
                        <span
                          className="text-sm font-bold text-slate-300"
                          dir="ltr"
                        >
                          {s.lessonTime}
                        </span>
                      </div>
                      <div
                        className={`w-9 h-9 rounded-full ${AVATAR_COLORS[idx % AVATAR_COLORS.length]} flex items-center justify-center text-white text-xs font-bold shrink-0`}
                      >
                        {s.avatar}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-100 truncate">
                          {s.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {s.instrument} · {s.level}
                        </p>
                      </div>
                      {waPhone && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <WhatsAppButton phone={waPhone} />
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}
      </div>

      {/* ── Desktop: full weekly grid (always visible) ── */}
      <div className="hidden md:block">
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[560px]">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 w-16 bg-slate-900">
                    שעה
                  </th>
                  {DAYS.map((day, i) => {
                    const isToday = i === todayDayIdx;
                    return (
                      <th
                        key={day}
                        className={`px-2 py-3 text-center text-xs font-semibold ${isToday ? "text-indigo-400 bg-indigo-500/10" : "text-slate-400"}`}
                      >
                        {day}
                        {isToday && (
                          <span className="block text-[10px] text-indigo-400/60 font-normal mt-0.5">
                            היום
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {allTimes.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-12 text-center text-slate-500 text-sm"
                    >
                      הוסף תלמידים עם יום ושעה קבועים כדי למלא את הלוח
                    </td>
                  </tr>
                ) : (
                  allTimes.map((time, rowIdx) => (
                    <tr
                      key={time}
                      className={`border-b border-white/[0.05] ${rowIdx % 2 === 0 ? "" : "bg-white/[0.02]"}`}
                    >
                      <td
                        className="px-4 py-2 text-slate-500 font-mono text-xs font-semibold"
                        dir="ltr"
                      >
                        {time}
                      </td>
                      {DAY_IDX.map((dayIdx) => {
                        const cell = gridData[time][dayIdx];
                        const isToday = dayIdx === todayDayIdx;
                        return (
                          <td
                            key={dayIdx}
                            className={`px-1.5 py-1.5 align-top ${isToday ? "bg-indigo-500/5" : ""}`}
                          >
                            <div className="space-y-1">
                              {cell.map((s) => {
                                const colorIdx =
                                  students.indexOf(s) % AVATAR_COLORS.length;
                                return (
                                  <button
                                    key={s.id}
                                    onClick={() => onEditStudent(s)}
                                    className="w-full text-right group rounded-xl px-2.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-indigo-500/50 transition-all"
                                  >
                                    <div className="flex items-center gap-1.5">
                                      <div
                                        className={`w-5 h-5 rounded-full ${AVATAR_COLORS[colorIdx]} flex items-center justify-center text-white text-[9px] font-bold shrink-0`}
                                      >
                                        {s.avatar}
                                      </div>
                                      <span className="text-xs font-medium text-slate-200 truncate group-hover:text-white">
                                        {s.name}
                                      </span>
                                    </div>
                                    {s.instrument !== "לא צוין" && (
                                      <p className="text-[10px] text-slate-500 mt-0.5 pr-6 truncate">
                                        {s.instrument}
                                      </p>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Calendar sync banner */}
      {googleToken && scheduledStudents.length > 0 && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-blue-400 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <p className="text-sm text-blue-300">Google Calendar מחובר</p>
          </div>
          <button
            onClick={() => onSyncCalendar(scheduledStudents)}
            className="text-xs font-semibold text-blue-300 border border-blue-500/40 hover:bg-blue-500/20 px-3 py-1.5 rounded-lg transition-all"
          >
            סנכרן את כל השיעורים
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Contact Picker Sync ──────────────────────────────────────────────────────

// Strip instrument/relation noise before name matching
const CONTACT_NOISE = [
  "גיטרה",
  "בס",
  "פסנתר",
  "כינור",
  "תופים",
  "חליל",
  "אבא של",
  "אמא של",
  "אב של",
  "אם של",
];

function cleanContactName(raw) {
  let s = raw;
  for (const kw of CONTACT_NOISE) s = s.replace(new RegExp(kw, "gi"), "");
  return s.replace(/\s+/g, " ").trim();
}

function contactNamesMatch(a, b) {
  if (!a || !b) return false;
  const na = cleanContactName(a).toLowerCase();
  const nb = cleanContactName(b).toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function ContactSyncModal({ students, onSave, onClose }) {
  const supported = typeof navigator !== "undefined" && "contacts" in navigator;
  const [step, setStep] = useState(supported ? "pick" : "unsupported");
  const [matches, setMatches] = useState([]); // { student, contactName, newPhone, field, status: 'pending'|'confirmed'|'skipped' }
  const [confirming, setConfirming] = useState({}); // index → true while saving
  const [error, setError] = useState(null);

  async function handlePick() {
    setError(null);
    try {
      const contacts = await navigator.contacts.select(["name", "tel"], {
        multiple: true,
      });
      if (!contacts || contacts.length === 0) return;

      const found = [];
      for (const contact of contacts) {
        const rawName = (contact.name || [])[0] || "";
        const phone = (contact.tel || [])[0] || "";
        if (!rawName || !phone) continue;

        for (const student of students) {
          if (contactNamesMatch(rawName, student.name)) {
            found.push({
              student,
              contactName: rawName,
              newPhone: phone,
              field: "phone",
              status: "pending",
            });
          } else if (
            student.contactName &&
            contactNamesMatch(rawName, student.contactName)
          ) {
            found.push({
              student,
              contactName: rawName,
              newPhone: phone,
              field: "contactPhone",
              status: "pending",
            });
          }
        }
      }
      setMatches(found);
      setStep("review");
    } catch (err) {
      if (err.name === "AbortError") return;
      setError(err.message);
    }
  }

  async function confirmOne(i) {
    setConfirming((p) => ({ ...p, [i]: true }));
    await onSave([matches[i]]);
    setMatches((prev) =>
      prev.map((m, idx) => (idx === i ? { ...m, status: "confirmed" } : m)),
    );
    setConfirming((p) => ({ ...p, [i]: false }));
  }

  function skipOne(i) {
    setMatches((prev) =>
      prev.map((m, idx) => (idx === i ? { ...m, status: "skipped" } : m)),
    );
  }

  const pending = matches.filter((m) => m.status === "pending").length;
  const confirmed = matches.filter((m) => m.status === "confirmed").length;
  const allResolved = matches.length > 0 && pending === 0;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#16161d] border border-white/[0.08] rounded-2xl w-full max-w-md max-h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <h2 className="font-bold text-white text-lg">סנכרן מאנשי קשר</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {step === "unsupported" && (
            <div className="flex flex-col items-center text-center gap-4 py-4">
              <div className="w-16 h-16 bg-slate-700/50 rounded-full flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-slate-500"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 24 24"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4m0 4h.01" />
                </svg>
              </div>
              <div>
                <p className="text-white font-bold mb-1">
                  הדפדפן אינו תומך ב-Contact Picker
                </p>
                <p className="text-sm text-slate-400 leading-relaxed">
                  תכונה זו זמינה ב-Chrome ל-Android בלבד.
                  <br />
                  עדכן מספרים ידנית דרך עריכת כרטיס התלמיד.
                </p>
              </div>
            </div>
          )}

          {step === "pick" && (
            <div className="flex flex-col items-center text-center gap-4 py-4">
              <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-indigo-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 24 24"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div>
                <p className="text-white font-bold mb-1">
                  בחר אנשי קשר לסנכרון
                </p>
                <p className="text-sm text-slate-400 leading-relaxed">
                  בחר מאנשי הקשר שלך — המערכת תתאים לפי שם (מתעלמת מ״גיטרה״,
                  ״אמא של״ וכו׳).
                </p>
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                onClick={handlePick}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl transition-colors"
              >
                פתח אנשי קשר
              </button>
            </div>
          )}

          {step === "review" && matches.length === 0 && (
            <div className="text-center py-8">
              <p className="text-slate-300 font-semibold mb-1">
                לא נמצאו התאמות
              </p>
              <p className="text-slate-500 text-sm">
                אף שם מאנשי הקשר שנבחרו לא תואם תלמיד קיים
              </p>
            </div>
          )}

          {step === "review" && matches.length > 0 && (
            <>
              <p className="text-xs text-slate-500">
                {allResolved
                  ? `סיום — ${confirmed} עודכנו`
                  : `${pending} מתוך ${matches.length} ממתינים לאישור`}
              </p>
              {matches.map((m, i) => {
                const currentPhone =
                  m.field === "phone"
                    ? m.student.phone
                    : m.student.contactPhone;
                const isDone = m.status !== "pending";
                return (
                  <div
                    key={i}
                    className={`rounded-xl border p-3 transition-colors ${
                      m.status === "confirmed"
                        ? "border-emerald-500/30 bg-emerald-500/5 opacity-60"
                        : m.status === "skipped"
                          ? "border-slate-700/30 bg-slate-800/20 opacity-40"
                          : "border-slate-700 bg-slate-800/50"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-white text-sm">
                            {m.student.name}
                          </p>
                          <svg
                            className="w-3 h-3 text-slate-500 shrink-0"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            viewBox="0 0 24 24"
                          >
                            <path d="M5 12h14M12 5l7 7-7 7" />
                          </svg>
                          <p className="text-xs text-slate-400 truncate">
                            {m.contactName}
                          </p>
                        </div>
                        <div
                          className="flex items-center gap-2 mt-1 text-xs"
                          dir="ltr"
                        >
                          <span className="text-slate-500">
                            {currentPhone || "—"}
                          </span>
                          <svg
                            className="w-3 h-3 text-slate-600 shrink-0"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                          >
                            <path d="M5 12h14M12 5l7 7-7 7" />
                          </svg>
                          <span className="text-emerald-400 font-medium">
                            {m.newPhone}
                          </span>
                        </div>
                      </div>
                      {!isDone ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => confirmOne(i)}
                            disabled={!!confirming[i]}
                            className="text-xs font-bold text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/15 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {confirming[i] ? "..." : "אשר"}
                          </button>
                          <button
                            onClick={() => skipOne(i)}
                            className="text-xs font-semibold text-slate-500 hover:text-slate-300 border border-slate-700 hover:border-slate-600 px-2 py-1.5 rounded-lg transition-colors"
                          >
                            דלג
                          </button>
                        </div>
                      ) : (
                        <span
                          className={`text-xs font-semibold shrink-0 ${m.status === "confirmed" ? "text-emerald-400" : "text-slate-600"}`}
                        >
                          {m.status === "confirmed" ? "✓ עודכן" : "דולג"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {(step === "unsupported" ||
          (step === "review" && (matches.length === 0 || allResolved))) && (
          <div className="p-4 border-t border-slate-800">
            <button
              onClick={onClose}
              className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl transition-colors"
            >
              סגור
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Students View ────────────────────────────────────────────────────────────

function StudentsView({
  students,
  onAddStudent,
  onEditStudent,
  googleToken,
  onSyncOne,
  onSyncContacts,
}) {
  const [showModal, setShowModal] = useState(false);
  const [showContactSync, setShowContactSync] = useState(false);
  const [syncing, setSyncing] = useState({});
  const [movedStudent, setMovedStudent] = useState(null);
  const [waChoice, setWaChoice] = useState(null);

  function sendWa(student, buildFn, resolveFn = resolveReminderTargets) {
    const targets = resolveFn(student);
    if (targets.length === 0) return;
    if (targets.length === 1)
      openWhatsApp(targets[0].phone, buildFn(targets[0].role));
    else setWaChoice({ targets, buildMessage: buildFn });
  }

  async function handleSyncOne(s, e) {
    e.stopPropagation();
    setSyncing((p) => ({ ...p, [s.id]: true }));
    await onSyncOne(s);
    setSyncing((p) => ({ ...p, [s.id]: false }));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">תלמידים</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            {students.length} תלמידים פעילים
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowContactSync(true)}
            title="סנכרן מספרי טלפון מאנשי קשר"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-sm font-semibold px-3 py-2.5 rounded-xl transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              <path d="M19 8l2 2 4-4" strokeWidth={2} />
            </svg>
            <span className="hidden sm:inline">אנשי קשר</span>
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors shadow-lg shadow-indigo-900/30"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="hidden xs:inline">הוסף תלמיד</span>
            <span className="xs:hidden">הוסף</span>
          </button>
        </div>
      </div>

      {students.length === 0 ? (
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-14 flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-slate-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h3 className="font-bold text-slate-200 mb-1">אין תלמידים עדיין</h3>
          <p className="text-sm text-slate-500 mb-6">
            הוסף את התלמיד הראשון כדי להתחיל
          </p>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            הוסף תלמיד ראשון
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {students.map((student, i) => {
            const hasWaTarget = !!(student.phone || student.contactPhone);
            const monthlyCount = calcMonthlyLessons(student.lessonDay);
            const monthlyTotal = monthlyCount * (Number(student.price) || 0);
            const dayName =
              student.lessonDay !== "" && student.lessonDay != null
                ? DAYS[parseInt(student.lessonDay)]
                : null;
            const canSync =
              googleToken &&
              student.lessonDay !== "" &&
              student.lessonDay != null &&
              student.lessonTime;

            return (
              <div
                key={student.id}
                onClick={() => onEditStudent(student)}
                className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-4 hover:border-indigo-500/50 hover:border-indigo-500/40 hover:bg-white/[0.04] transition-all cursor-pointer group flex flex-col gap-3"
              >
                {/* Header */}
                <div className="flex items-center gap-3">
                  <div
                    className={`w-11 h-11 rounded-full ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center text-white font-bold shrink-0`}
                  >
                    {student.avatar}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-white truncate">
                      {student.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {student.instrument} · {student.level}
                    </p>
                  </div>
                  <svg
                    className="w-4 h-4 text-slate-700 group-hover:text-indigo-400 transition-colors shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </div>

                {student.contactName && (
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3.5 h-3.5 text-slate-500 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                    <span className="text-xs text-slate-400">
                      {student.contactName}
                    </span>
                  </div>
                )}

                {(student.phone || student.contactPhone) && (
                  <div
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-xs text-slate-400 truncate" dir="ltr">
                      {student.contactPhone || student.phone}
                    </span>
                    <WhatsAppButton
                      phone={student.contactPhone || student.phone}
                    />
                  </div>
                )}

                {dayName && student.lessonTime && (
                  <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] rounded-xl px-2.5 py-1.5 w-fit text-xs">
                    <svg
                      className="w-3 h-3 text-indigo-400"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                    <span className="text-slate-300 font-medium">
                      {dayName} · {student.lessonTime}
                    </span>
                    {student.price > 0 && (
                      <span className="text-slate-500 border-r border-slate-700 pr-2 mr-1">
                        ₪{student.price}
                      </span>
                    )}
                  </div>
                )}

                {/* Action rows */}
                {(hasWaTarget || canSync) && (
                  <div
                    className="space-y-2 pt-1 border-t border-slate-800"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Row 1: Reminder · Billing · Calendar */}
                    <div className="flex gap-2">
                      {hasWaTarget && (
                        <>
                          <button
                            onClick={() =>
                              sendWa(student, (role) =>
                                buildReminderMessage(student, role),
                              )
                            }
                            className={`flex-1 flex items-center justify-center gap-1 text-xs font-semibold border rounded-xl py-2 transition-all ${isReminderDueToday(student) ? "text-amber-300 border-amber-500/50 bg-amber-500/10" : "text-emerald-400 border-slate-700 hover:border-emerald-500/50 hover:bg-emerald-500/10"}`}
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                            </svg>
                            {isReminderDueToday(student)
                              ? "תזכורת !"
                              : "תזכורת"}
                          </button>
                          <button
                            onClick={() =>
                              sendWa(
                                student,
                                (role) => buildBillingMessage(student, role),
                                resolveBillingTargets,
                              )
                            }
                            title={`${monthlyCount} שיעורים · ₪${monthlyTotal}`}
                            className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold text-indigo-400 border border-slate-700 hover:border-indigo-500/50 hover:bg-indigo-500/10 rounded-xl py-2 transition-all"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              viewBox="0 0 24 24"
                            >
                              <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                            </svg>
                            חיוב
                          </button>
                        </>
                      )}
                      {canSync && (
                        <button
                          onClick={(e) => handleSyncOne(student, e)}
                          disabled={syncing[student.id]}
                          className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold text-blue-400 border border-slate-700 hover:border-blue-500/50 hover:bg-blue-500/10 rounded-xl py-2 transition-all disabled:opacity-50"
                        >
                          <svg
                            className={`w-3.5 h-3.5 ${syncing[student.id] ? "animate-spin" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                          >
                            <path d="M23 4v6h-6M1 20v-6h6" />
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                          </svg>
                          {student.googleEventId ? "עדכן" : "יומן"}
                        </button>
                      )}
                    </div>
                    {/* Row 2: Moved · Late Cancellation */}
                    {hasWaTarget && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setMovedStudent(student)}
                          className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold text-amber-400 border border-slate-700 hover:border-amber-500/50 hover:bg-amber-500/10 rounded-xl py-1.5 transition-all"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            viewBox="0 0 24 24"
                          >
                            <path d="M5 12h14M12 5l7 7-7 7" />
                          </svg>
                          הוזז
                        </button>
                        <button
                          onClick={() =>
                            sendWa(student, (role) =>
                              buildLateCancellationMessage(student, role),
                            )
                          }
                          className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold text-red-400 border border-slate-700 hover:border-red-500/50 hover:bg-red-500/10 rounded-xl py-1.5 transition-all"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            viewBox="0 0 24 24"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                          ביטול מאוחר
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <StudentForm
          title="הוספת תלמיד חדש"
          saveLabel="הוסף תלמיד"
          onSave={(data) =>
            onAddStudent({
              id: crypto.randomUUID(),
              avatar: getInitials(data.name),
              progress: 0,
              nextLesson: null,
              googleEventId: null,
              ...data,
            })
          }
          onClose={() => setShowModal(false)}
        />
      )}

      {movedStudent && (
        <MovedLessonModal
          student={movedStudent}
          onClose={() => setMovedStudent(null)}
        />
      )}

      {waChoice && (
        <WaChoiceModal
          targets={waChoice.targets}
          buildMessage={waChoice.buildMessage}
          onClose={() => setWaChoice(null)}
        />
      )}

      {showContactSync && (
        <ContactSyncModal
          students={students}
          onSave={onSyncContacts}
          onClose={() => setShowContactSync(false)}
        />
      )}
    </div>
  );
}

// ─── Google Calendar Import Wizard ───────────────────────────────────────────

const GCAL_DAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseGCalEvent(event) {
  // Extract day index from RRULE (e.g. RRULE:FREQ=WEEKLY;BYDAY=TU)
  let lessonDay = "";
  let lessonTime = "";
  const rrule = (event.recurrence || []).find((r) => r.startsWith("RRULE:"));
  if (rrule) {
    const byday = rrule.match(/BYDAY=([A-Z]+)/);
    if (byday) lessonDay = String(GCAL_DAY_MAP[byday[1]] ?? "");
  }
  // Extract time from start.dateTime (e.g. 2024-01-09T16:00:00+02:00)
  if (event.start?.dateTime) {
    const t = new Date(event.start.dateTime);
    lessonTime = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  // Guess student name from summary (e.g. "שיעור גיטרה — דניאל")
  let name = event.summary || "";
  const dashParts = name.split(/—|–|-/);
  if (dashParts.length > 1) name = dashParts[dashParts.length - 1].trim();

  return { name, lessonDay, lessonTime, googleEventId: event.id };
}

function GCalImportWizard({
  googleToken,
  existingStudents,
  onImport,
  onClose,
}) {
  const [step, setStep] = useState("fetch"); // fetch | review | done
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function fetchEvents() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
          "?singleEvents=false&maxResults=250&fields=items(id,summary,recurrence,start)",
        { headers: { Authorization: `Bearer ${googleToken}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Keep weekly recurring events that look like lessons
      const weekly = (json.items || []).filter((e) => {
        if (!(e.recurrence || []).some((r) => r.includes("FREQ=WEEKLY")))
          return false;
        const title = (e.summary || "").toLowerCase();
        return (
          title.includes("lesson") ||
          title.includes("שיעור") ||
          title.includes(" - ") ||
          title.includes(" — ")
        );
      });
      const parsed = weekly.map((e) => ({
        ...parseGCalEvent(e),
        gcalSummary: e.summary,
      }));
      // Pre-select events not already in the students list
      const existingEventIds = new Set(
        existingStudents.map((s) => s.googleEventId).filter(Boolean),
      );
      const initial = {};
      parsed.forEach((e, i) => {
        if (!existingEventIds.has(e.googleEventId)) initial[i] = true;
      });
      setEvents(parsed);
      setSelected(initial);
      setStep("review");
    } catch (err) {
      setError(`שגיאה בטעינה: ${err.message}`);
    }
    setLoading(false);
  }

  function toggle(i) {
    setSelected((prev) => ({ ...prev, [i]: !prev[i] }));
  }

  function handleImport() {
    const toImport = events.filter((_, i) => selected[i]);
    onImport(toImport);
    setStep("done");
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
      dir="rtl"
    >
      <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b border-slate-800">
          <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5 text-blue-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="font-bold text-white">ייבוא מ-Google Calendar</p>
            <p className="text-xs text-slate-400">
              אירועים שבועיים חוזרים → תלמידים
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === "fetch" && (
            <div className="text-center space-y-4 py-6">
              <p className="text-sm text-slate-300">
                אוביא את כל האירועים החוזרים השבועיים מ-Google Calendar שלך
                ואהפוך אותם לתלמידים.
              </p>
              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  {error}
                </p>
              )}
              <button
                onClick={fetchEvents}
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />{" "}
                    טוען...
                  </>
                ) : (
                  "טען אירועים מהיומן"
                )}
              </button>
            </div>
          )}

          {step === "review" && events.length === 0 && (
            <div className="text-center py-8">
              <p className="text-slate-400 text-sm">
                לא נמצאו אירועים שבועיים חוזרים ביומן.
              </p>
            </div>
          )}

          {step === "review" && events.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400 mb-3">
                סמן את האירועים שברצונך לייבא כתלמידים ({events.length} נמצאו)
              </p>
              {events.map((ev, i) => {
                const dayName =
                  ev.lessonDay !== "" ? DAYS[parseInt(ev.lessonDay)] : "?";
                return (
                  <label
                    key={i}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${selected[i] ? "border-indigo-500/50 bg-indigo-500/10" : "border-slate-800 bg-slate-800/50 hover:border-slate-700"}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!selected[i]}
                      onChange={() => toggle(i)}
                      className="w-4 h-4 accent-indigo-500 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">
                        {ev.name || ev.gcalSummary}
                      </p>
                      <p className="text-xs text-slate-400">{ev.gcalSummary}</p>
                    </div>
                    <div className="text-xs text-slate-400 shrink-0 text-left">
                      <p>{dayName}</p>
                      <p>{ev.lessonTime}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {step === "done" && (
            <div className="text-center space-y-3 py-8">
              <div className="w-14 h-14 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto">
                <svg
                  className="w-7 h-7 text-emerald-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  viewBox="0 0 24 24"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <p className="font-bold text-white">הייבוא הושלם!</p>
              <p className="text-sm text-slate-400">
                התלמידים נוספו — ערוך כל אחד כדי להוסיף פרטים.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {step === "review" && events.length > 0 && (
          <div className="border-t border-slate-800 p-4 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 text-sm font-semibold text-slate-400 border border-slate-700 hover:border-slate-600 rounded-xl py-2.5 transition-colors"
            >
              ביטול
            </button>
            <button
              onClick={handleImport}
              disabled={selectedCount === 0}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
            >
              ייבא {selectedCount} תלמידים
            </button>
          </div>
        )}
        {step === "done" && (
          <div className="border-t border-slate-800 p-4">
            <button
              onClick={onClose}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
            >
              סגור
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Invoices View ────────────────────────────────────────────────────────────

function InvoicesView({ students, settings = {} }) {
  const [waChoice, setWaChoice] = useState(null);
  const [morningStatus, setMorningStatus] = useState({}); // { [studentId]: 'loading'|'paid'|'unpaid'|'unknown'|'error'|'no-creds' }

  const hasMorning = !!(settings.morningKey && settings.morningSecret);

  async function checkPayment(s) {
    if (!hasMorning) {
      setMorningStatus((p) => ({ ...p, [s.id]: "no-creds" }));
      return;
    }
    setMorningStatus((p) => ({ ...p, [s.id]: "loading" }));
    try {
      const res = await fetch(
        `/api/morning-status?clientName=${encodeURIComponent(s.name)}`,
        {
          headers: {
            "x-morning-key": settings.morningKey,
            "x-morning-secret": settings.morningSecret,
          },
        },
      );
      const data = await res.json();
      const items =
        data.items || data.data || (Array.isArray(data) ? data : []);
      // Morning returns status: 'open' (unpaid) or 'closed'/'paid' (paid)
      const latest = items[0];
      if (!latest) {
        setMorningStatus((p) => ({ ...p, [s.id]: "unknown" }));
        return;
      }
      const st = (latest.status || latest.paymentStatus || "").toLowerCase();
      const paid = st === "paid" || st === "closed";
      setMorningStatus((p) => ({ ...p, [s.id]: paid ? "paid" : "unpaid" }));
    } catch {
      setMorningStatus((p) => ({ ...p, [s.id]: "error" }));
    }
  }

  function MorningBadge({ id }) {
    const st = morningStatus[id];
    if (!st) return null;
    const map = {
      loading: { label: "...", cls: "text-slate-400" },
      paid: { label: "✓ שולם", cls: "text-emerald-400" },
      unpaid: { label: "! לא שולם", cls: "text-amber-400" },
      unknown: { label: "לא נמצא", cls: "text-slate-500" },
      error: { label: "שגיאה", cls: "text-red-400" },
      "no-creds": { label: "חסר API", cls: "text-slate-500" },
    };
    const { label, cls } = map[st] || {};
    return <span className={`text-[11px] font-semibold ${cls}`}>{label}</span>;
  }

  function sendWa(s) {
    const targets = resolveBillingTargets(s);
    if (targets.length === 0) return;
    if (targets.length === 1)
      openWhatsApp(targets[0].phone, buildBillingMessage(s, targets[0].role));
    else
      setWaChoice({
        targets,
        buildMessage: (role) => buildBillingMessage(s, role),
      });
  }

  const now = new Date();
  const monthLabel = now.toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
  const rows = students
    .filter((s) => s.price > 0 && s.lessonDay !== "" && s.lessonDay != null)
    .map((s) => ({
      student: s,
      count: calcMonthlyLessons(s.lessonDay),
      total: calcMonthlyLessons(s.lessonDay) * Number(s.price),
    }));
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white">חשבוניות</h2>
        <p className="text-sm text-slate-400 mt-0.5">{monthLabel}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'סה"כ לחיוב', value: `₪${grandTotal}`, color: "text-white" },
          { label: "לתלמידים", value: rows.length, color: "text-indigo-400" },
          {
            label: "ממוצע",
            value: rows.length
              ? `₪${Math.round(grandTotal / rows.length)}`
              : "₪0",
            color: "text-blue-400",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-3 sm:p-4"
          >
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium">
              {s.label}
            </p>
            <p className={`text-xl sm:text-3xl font-bold mt-1 ${s.color}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-12 flex flex-col items-center text-center">
          <div className="w-14 h-14 bg-slate-800 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-7 h-7 text-slate-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <p className="font-semibold text-slate-300 mb-1">אין נתוני חיוב</p>
          <p className="text-sm text-slate-500">הוסף מחיר ויום קבוע לתלמידים</p>
        </div>
      ) : (
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl overflow-hidden">
          {/* Mobile: cards */}
          <div className="sm:hidden divide-y divide-slate-800">
            {rows.map(({ student: s, count, total }, i) => {
              const hasTarget = resolveWaTargets(s).length > 0;
              return (
                <div key={s.id} className="p-4 flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center text-white text-[11px] font-bold shrink-0`}
                  >
                    {s.avatar}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-100 truncate">
                      {s.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {count} שיעורים × ₪{s.price}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-bold text-white">₪{total}</span>
                    <MorningBadge id={s.id} />
                    {hasMorning && (
                      <button
                        onClick={() => checkPayment(s)}
                        className="text-[11px] font-semibold text-slate-400 hover:text-emerald-400 border border-slate-700 hover:border-emerald-500/40 px-2 py-1 rounded-lg transition-all"
                      >
                        בדוק
                      </button>
                    )}
                    {hasTarget && (
                      <button
                        onClick={() => sendWa(s)}
                        className="text-emerald-400 hover:text-emerald-300"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Desktop: table */}
          <table className="w-full text-sm hidden sm:table">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-right px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  תלמיד
                </th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  יום
                </th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  שיעורים
                </th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  סכום
                </th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map(({ student: s, count, total }, i) => {
                const hasTarget = resolveWaTargets(s).length > 0;
                return (
                  <tr
                    key={s.id}
                    className="hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-7 h-7 rounded-full ${AVATAR_COLORS[i % AVATAR_COLORS.length]} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}
                        >
                          {s.avatar}
                        </div>
                        <div>
                          <p className="font-bold text-slate-100">{s.name}</p>
                          {s.contactName && (
                            <p className="text-xs text-slate-500">
                              {s.contactName}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-slate-400 text-xs">
                      {DAYS[parseInt(s.lessonDay)]} · {s.lessonTime}
                    </td>
                    <td className="px-5 py-3.5 text-slate-300">
                      {count} × ₪{s.price}
                    </td>
                    <td className="px-5 py-3.5 font-bold text-white">
                      ₪{total}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <MorningBadge id={s.id} />
                        {hasMorning && (
                          <button
                            onClick={() => checkPayment(s)}
                            className="text-[11px] font-semibold text-slate-400 hover:text-emerald-400 border border-slate-700 hover:border-emerald-500/40 px-2 py-1 rounded-lg transition-all"
                          >
                            בדוק
                          </button>
                        )}
                        {hasTarget && (
                          <button
                            onClick={() => sendWa(s)}
                            className="text-xs font-semibold text-emerald-400 border border-slate-700 hover:border-emerald-500/50 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                          >
                            <svg
                              className="w-3 h-3"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                            </svg>
                            שלח חיוב
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {waChoice && (
        <WaChoiceModal
          targets={waChoice.targets}
          buildMessage={waChoice.buildMessage}
          onClose={() => setWaChoice(null)}
        />
      )}
    </div>
  );
}

// ─── Settings View ────────────────────────────────────────────────────────────

const HEBREW_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];

function SettingsView({
  settings,
  onSave,
  googleToken,
  onConnectGoogle,
  onDisconnectGoogle,
  userId,
  supabaseUrl,
  calendarBotConnected,
  availability = [],
  onSaveAvailability,
}) {
  const [form, setForm] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [testingAutomation, setTestingAutomation] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [availWindows, setAvailWindows] = useState(availability);

  const webhookUrl =
    supabaseUrl && userId
      ? `${supabaseUrl}/functions/v1/whatsapp-webhook?user_id=${userId}${form.webhookSecret ? `&secret=${form.webhookSecret}` : ""}`
      : "";

  async function handleTestAutomation() {
    if (!form.whapiToken) return;
    setTestingAutomation(true);
    setTestResult(null);
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/send-reminders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_AUTOMATION_SECRET}`,
        },
        body: JSON.stringify({ test: true, userId }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult(
        res.ok
          ? `✓ נשלחו ${data.sent ?? 0} הודעות`
          : `שגיאה: ${data.error || res.status}`,
      );
    } catch (err) {
      setTestResult(`שגיאה: ${err.message}`);
    }
    setTestingAutomation(false);
    setTimeout(() => setTestResult(null), 5000);
  }

  // Sync form if settings change externally
  useEffect(() => {
    setForm(settings);
  }, [settings]);

  useEffect(() => {
    setAvailWindows(availability);
  }, [availability]);

  function handleSave(e) {
    e.preventDefault();
    onSave(form);
    if (onSaveAvailability) onSaveAvailability(availWindows);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function addWindow(day) {
    setAvailWindows((prev) => [
      ...prev,
      { day_of_week: day, start_time: "09:00", end_time: "13:00" },
    ]);
  }

  function removeWindow(day, idx) {
    setAvailWindows((prev) => {
      const dayWindows = prev.filter((w) => w.day_of_week === day);
      const removed = dayWindows[idx];
      return prev.filter((w) => w !== removed);
    });
  }

  function updateWindow(day, idx, field, value) {
    setAvailWindows((prev) => {
      const result = [...prev];
      const dayWindows = result.filter((w) => w.day_of_week === day);
      const target = dayWindows[idx];
      const globalIdx = result.indexOf(target);
      result[globalIdx] = { ...result[globalIdx], [field]: value };
      return result;
    });
  }

  const inp =
    "w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40 transition font-mono";

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold text-white">הגדרות</h2>
        <p className="text-sm text-slate-400 mt-0.5">חיבורים ואינטגרציות</p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {/* ── Google Calendar ── */}
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-blue-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-100">Google Calendar</p>
              <p className="text-xs text-slate-500">
                יצירת אירועים חוזרים לפי מערכת השיעורים
              </p>
            </div>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-semibold shrink-0 ${googleToken ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-500"}`}
            >
              {googleToken ? "מחובר" : "לא מחובר"}
            </span>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Client ID (OAuth 2.0)
              </label>
              <input
                type="text"
                value={form.googleClientId || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, googleClientId: e.target.value }))
                }
                placeholder="123456789-abc.apps.googleusercontent.com"
                dir="ltr"
                className={inp}
              />
              <p className="text-[11px] text-slate-600 mt-1.5">
                נוצר ב-Google Cloud Console → APIs &amp; Services → Credentials
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                API Key
              </label>
              <input
                type="password"
                value={form.googleCalendarKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, googleCalendarKey: e.target.value }))
                }
                placeholder="AIzaSy..."
                dir="ltr"
                className={inp}
              />
            </div>

            {!googleToken ? (
              <button
                type="button"
                onClick={() => onConnectGoogle(form.googleClientId)}
                disabled={!form.googleClientId}
                className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold py-3 rounded-xl transition-colors mt-1"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                חבר Google Calendar
              </button>
            ) : (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
                <svg
                  className="w-4 h-4 text-emerald-400 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  viewBox="0 0 24 24"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <p className="text-sm text-emerald-300 flex-1">
                  חשבון Google מחובר
                </p>
                <button
                  type="button"
                  onClick={onDisconnectGoogle}
                  className="text-xs text-slate-400 hover:text-slate-200 underline"
                >
                  נתק
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Morning ── */}
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-emerald-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-100">
                Morning — חשבונית ירוקה
              </p>
              <p className="text-xs text-slate-500">הפקת חשבוניות אוטומטית</p>
            </div>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-semibold shrink-0 ${form.morningKey && form.morningSecret ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-500"}`}
            >
              {form.morningKey && form.morningSecret ? "מחובר" : "לא מחובר"}
            </span>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                API Key
              </label>
              <input
                type="password"
                value={form.morningKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, morningKey: e.target.value }))
                }
                placeholder="morning_key_..."
                dir="ltr"
                className={inp}
              />
              <p className="text-[11px] text-slate-600 mt-1.5">
                נמצא ב-Morning → הגדרות → API
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Secret
              </label>
              <input
                type="password"
                value={form.morningSecret || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, morningSecret: e.target.value }))
                }
                placeholder="morning_secret_..."
                dir="ltr"
                className={inp}
              />
            </div>
          </div>
        </div>

        {/* ── WhatsApp Automation ── */}
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-indigo-400"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-100">WhatsApp Automation</p>
              <p className="text-xs text-slate-500">
                תזכורות וחיובים אוטומטיים דרך Whapi.cloud
              </p>
            </div>
            {/* Global toggle */}
            <button
              type="button"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  automationEnabled: !f.automationEnabled,
                }))
              }
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${form.automationEnabled ? "bg-indigo-600" : "bg-slate-700"}`}
              role="switch"
              aria-checked={form.automationEnabled}
              dir="ltr"
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${form.automationEnabled ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Whapi Token
              </label>
              <input
                type="password"
                value={form.whapiToken || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, whapiToken: e.target.value }))
                }
                placeholder="whapi_..."
                dir="ltr"
                className={inp}
              />
              <p className="text-[11px] text-slate-600 mt-1.5">
                נמצא ב-Whapi.cloud → Channel → Token
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Webhook Secret
              </label>
              <input
                type="text"
                value={form.webhookSecret || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, webhookSecret: e.target.value }))
                }
                placeholder="סיסמה סודית — תואמת ל-WEBHOOK_SECRET בסופאבייס"
                dir="ltr"
                className={inp}
              />
              <p className="text-[11px] text-slate-600 mt-1.5">
                הגדר ב-Supabase → Edge Functions → Secrets כ-WEBHOOK_SECRET
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Webhook URL (העתק ל-Whapi)
              </label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={webhookUrl}
                  placeholder="יש להזין Webhook Secret כדי לייצר את ה-URL"
                  dir="ltr"
                  className={`${inp} text-slate-400 cursor-text select-all text-[11px]`}
                />
                <button
                  type="button"
                  onClick={() =>
                    webhookUrl && navigator.clipboard?.writeText(webhookUrl)
                  }
                  disabled={!webhookUrl}
                  className="shrink-0 text-slate-500 hover:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="העתק"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>
              <p className="text-[11px] text-slate-600 mt-1.5">
                הדבק את ה-URL הזה בהגדרות ה-Webhook ב-Whapi.cloud
              </p>
            </div>

            {form.whapiToken && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTestAutomation}
                  disabled={testingAutomation}
                  className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-semibold px-3 py-2 rounded-xl transition-colors disabled:opacity-50"
                >
                  <svg
                    className={`w-3.5 h-3.5 ${testingAutomation ? "animate-spin" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  {testingAutomation ? "שולח..." : "שלח הודעת בדיקה"}
                </button>
                {testResult && (
                  <span className="text-xs text-slate-400">{testResult}</span>
                )}
              </div>
            )}

            <div className="bg-white/[0.03] rounded-xl px-4 py-3 text-xs text-slate-500 leading-relaxed space-y-1">
              <p>• תזכורות נשלחות יום לפני השיעור (שישי לשיעורי ראשון)</p>
              <p>• חיוב נשלח ב-1 לחודש לתלמידים עם מחיר מוגדר</p>
              <p>• פונקציית Cron מופעלת ב-08:00 בכל בוקר (שרת)</p>
            </div>
          </div>
        </div>

        {/* ── Calendar Bot — Self-Service Rescheduling ── */}
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-indigo-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
                <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-100">
                Calendar Bot — שיבוץ עצמי
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                תלמידים מבקשים מועד דרך WhatsApp → הבוט בודק יומן → אמיתי מאשר
              </p>
            </div>
            {calendarBotConnected ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
                <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                מחובר
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-slate-600 shrink-0">
                <div className="w-2 h-2 bg-slate-600 rounded-full" />
                לא מחובר
              </div>
            )}
          </div>

          <div className="space-y-2 text-xs text-slate-500 bg-white/[0.02] rounded-xl p-3">
            <p className="font-semibold text-slate-400">
              שעות עבודה לפי הגדרת זמינות
            </p>
            <p>• הבוט מציע 3–4 מועדים פנויים בלבד לפי יומן Google</p>
            <p>• אחרי בחירת תלמיד — Amitai מקבל WhatsApp עם "אשר" / "דחה"</p>
            <p>• אישור יוצר אירוע ביומן ושולח אישור לתלמיד אוטומטית</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                const calBotClientId = import.meta.env
                  .VITE_CALENDAR_BOT_CLIENT_ID;
                const params = new URLSearchParams({
                  client_id: calBotClientId,
                  redirect_uri: window.location.origin,
                  response_type: "code",
                  scope: "https://www.googleapis.com/auth/calendar.events",
                  access_type: "offline",
                  prompt: "consent",
                });
                window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
              }}
              className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
              </svg>
              {calendarBotConnected ? "חבר מחדש" : "חבר Calendar Bot"}
            </button>
            <p className="text-xs text-slate-600">
              יש להוסיף{" "}
              <code className="bg-white/[0.06] px-1 rounded">
                {window.location.origin}
              </code>{" "}
              כ-Authorized Redirect URI ב-Google Cloud Console
            </p>
          </div>

          <p className="text-xs text-slate-600 border-t border-white/[0.05] pt-3">
            נדרש secret ב-Supabase Edge Functions:{" "}
            <code className="bg-white/[0.06] px-1 rounded">
              GOOGLE_CLIENT_SECRET
            </code>{" "}
            ו-
            <code className="bg-white/[0.06] px-1 rounded">
              GOOGLE_CLIENT_ID
            </code>
          </p>
        </div>

        {/* ── שעות זמינות ── */}
        <div className="bg-[#16161d] border border-white/[0.07] rounded-2xl p-5 sm:p-6 space-y-4">
          <div>
            <p className="font-bold text-slate-100">שעות זמינות</p>
            <p className="text-xs text-slate-500 mt-0.5">
              הגדר לכל יום את חלונות הזמן שבהם תלמידים יכולים לקבוע — הבוט יציע
              מועדים רק בחלונות האלו
            </p>
          </div>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4, 5].map((day) => {
              const dayWins = availWindows.filter((w) => w.day_of_week === day);
              return (
                <div key={day} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-400 w-16">
                      יום {HEBREW_DAYS[day]}
                    </span>
                    <button
                      type="button"
                      onClick={() => addWindow(day)}
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      הוסף חלון
                    </button>
                  </div>
                  {dayWins.length === 0 ? (
                    <p className="text-xs text-slate-700 pr-1">לא זמין</p>
                  ) : (
                    dayWins.map((w, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 bg-white/[0.03] rounded-xl px-3 py-2"
                      >
                        <input
                          type="time"
                          value={w.start_time}
                          onChange={(e) =>
                            updateWindow(day, i, "start_time", e.target.value)
                          }
                          className="bg-transparent text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 rounded px-1"
                          dir="ltr"
                        />
                        <span className="text-slate-600 text-xs">עד</span>
                        <input
                          type="time"
                          value={w.end_time}
                          onChange={(e) =>
                            updateWindow(day, i, "end_time", e.target.value)
                          }
                          className="bg-transparent text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 rounded px-1"
                          dir="ltr"
                        />
                        <button
                          type="button"
                          onClick={() => removeWindow(day, i)}
                          className="mr-auto text-slate-600 hover:text-red-400 transition-colors"
                          title="הסר חלון"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                          >
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-600 border-t border-white/[0.05] pt-3">
            שבת תמיד מושמטת. ימים ללא חלונות — הבוט לא יציע מועדים בהם.
          </p>
        </div>

        <button
          type="submit"
          className={`flex items-center gap-2 text-sm font-bold px-5 py-2.5 rounded-xl transition-all ${saved ? "bg-emerald-600 text-white" : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/30"}`}
        >
          {saved ? (
            <>
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                viewBox="0 0 24 24"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              נשמר
            </>
          ) : (
            "שמור הגדרות"
          )}
        </button>
      </form>
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

export default function App({ user }) {
  const [activeTab, setActiveTab] = useState("schedule");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [students, setStudents] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [settings, setSettings] = useState({
    googleCalendarKey: "",
    googleClientId: "",
    morningKey: "",
    morningSecret: "",
    whapiToken: "",
    webhookSecret: "",
    automationEnabled: false,
    googleRefreshToken: "", // set by gcal-oauth Edge Function, read-only from UI
  });
  const [loading, setLoading] = useState(true);
  const [editingStudent, setEditingStudent] = useState(null);
  const [googleToken, setGoogleToken] = useState(null); // ephemeral — not persisted
  const [syncMsg, setSyncMsg] = useState(null);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [calChanges, setCalChanges] = useState([]);
  const [showCalChanges, setShowCalChanges] = useState(false);

  // ── Load data from Supabase on mount ──────────────────────────────────────

  useEffect(() => {
    async function loadData() {
      const [
        { data: studentsData },
        { data: settingsData },
        { data: availData },
      ] = await Promise.all([
        supabase
          .from("students")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("user_settings")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("teacher_availability")
          .select("day_of_week, start_time, end_time")
          .eq("user_id", user.id)
          .order("day_of_week")
          .order("start_time"),
      ]);

      // ── One-time migration from localStorage ──────────────────────────────
      if (studentsData && studentsData.length === 0) {
        try {
          const raw = localStorage.getItem("musicpro_students");
          const local = raw ? JSON.parse(raw) : [];
          if (local.length > 0) {
            // Assign UUIDs if IDs are old numeric timestamps
            const migrated = local.map((s) => ({
              ...s,
              id:
                typeof s.id === "string" && s.id.includes("-")
                  ? s.id
                  : crypto.randomUUID(),
              googleEventId: s.googleEventId || null,
              avatar: s.avatar || getInitials(s.name),
            }));
            await supabase
              .from("students")
              .insert(migrated.map((s) => studentToDb(s, user.id)));
            setStudents(migrated);
            localStorage.removeItem("musicpro_students");
            setSyncMsg({
              type: "success",
              text: `✓ ${migrated.length} תלמידים יובאו מהדפדפן לענן בהצלחה`,
            });
            setTimeout(() => setSyncMsg(null), 5000);
            setLoading(false);
            // Also migrate settings
            const rawSettings = localStorage.getItem("musicpro_settings");
            if (rawSettings) {
              const localSettings = JSON.parse(rawSettings);
              setSettings(localSettings);
              await supabase.from("user_settings").upsert({
                user_id: user.id,
                google_calendar_key: localSettings.googleCalendarKey || "",
                google_client_id: localSettings.googleClientId || "",
                morning_key: localSettings.morningKey || "",
                morning_secret: localSettings.morningSecret || "",
              });
              localStorage.removeItem("musicpro_settings");
            }
            return;
          }
        } catch {
          /* migration failed silently, continue with empty state */
        }
      }

      if (studentsData) setStudents(studentsData.map(dbToStudent));
      if (settingsData)
        setSettings({
          googleCalendarKey: settingsData.google_calendar_key || "",
          googleClientId: settingsData.google_client_id || "",
          morningKey: settingsData.morning_key || "",
          morningSecret: settingsData.morning_secret || "",
          whapiToken: settingsData.whapi_token || "",
          webhookSecret: settingsData.webhook_secret || "",
          automationEnabled: settingsData.automation_enabled ?? false,
          googleRefreshToken: settingsData.google_refresh_token || "",
        });
      if (availData)
        setAvailability(
          availData.map((r) => ({
            day_of_week: r.day_of_week,
            start_time: r.start_time.slice(0, 5), // "HH:MM"
            end_time: r.end_time.slice(0, 5),
          })),
        );
      setLoading(false);
    }
    loadData();
  }, [user.id]);

  // ── Google Calendar Bot OAuth callback ────────────────────────────────────
  // After the Google consent screen, Google redirects back with ?code=...
  // We exchange the code via the gcal-oauth Edge Function and store the refresh token.

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;

    // Remove code from URL immediately to prevent reuse on refresh
    window.history.replaceState({}, "", window.location.pathname);

    async function exchangeCode() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) return;

        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gcal-oauth`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              code,
              redirect_uri: window.location.origin,
            }),
          },
        );

        if (res.ok) {
          setSettings((prev) => ({ ...prev, googleRefreshToken: "connected" }));
          setSyncMsg({
            type: "success",
            text: "✓ Calendar Bot חובר בהצלחה — הבוט יכול כעת לגשת ליומן",
          });
          setActiveTab("settings");
        } else {
          const err = await res.json().catch(() => ({}));
          setSyncMsg({
            type: "error",
            text: `שגיאה בחיבור Calendar Bot: ${err.error || res.status}`,
          });
        }
      } catch (err) {
        setSyncMsg({ type: "error", text: `שגיאה: ${err.message}` });
      }
      setTimeout(() => setSyncMsg(null), 6000);
    }

    exchangeCode();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Google Calendar OAuth ──────────────────────────────────────────────────

  function connectGoogle(clientId) {
    if (!clientId) {
      setSyncMsg({ type: "error", text: "הכנס Client ID בהגדרות תחילה." });
      return;
    }
    if (!window.google?.accounts?.oauth2) {
      setSyncMsg({
        type: "error",
        text: "ספריית Google טרם נטענה — רענן את הדף ונסה שנית.",
      });
      return;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GCAL_SCOPE,
      callback: (response) => {
        if (response.access_token) {
          setGoogleToken(response.access_token);
          setSyncMsg({ type: "success", text: "Google Calendar חובר בהצלחה!" });
          setTimeout(() => setSyncMsg(null), 3000);
        } else {
          setSyncMsg({
            type: "error",
            text: `שגיאה: ${response.error || "unknown"} — ${response.error_description || "נסה שנית"}`,
          });
        }
      },
      error_callback: (err) => {
        // err.type: 'popup_closed', 'access_denied', 'invalid_client', etc.
        if (err.type === "popup_closed") return; // user closed popup — not an error
        const hints = {
          invalid_client:
            "invalid_client — בדוק ש-Client ID נכון ושה-Origins http://localhost:5173 ו-https://music-app-chi-three.vercel.app מוגדרים ב-Authorized JavaScript Origins ב-Google Cloud Console (לא Redirect URI).",
          access_denied:
            "access_denied — המשתמש לא אישר גישה. אם האפליקציה במצב Testing, הוסף את כתובת Gmail שלך ב-Test Users.",
        };
        const msg = hints[err.type] || `שגיאת Google: ${err.type}`;
        setSyncMsg({ type: "error", text: msg });
      },
    });
    client.requestAccessToken();
  }

  function disconnectGoogle() {
    if (googleToken && window.google) {
      window.google.accounts.oauth2.revoke(googleToken, () => {});
    }
    setGoogleToken(null);
  }

  const syncStudent = useCallback(
    async (student) => {
      if (!googleToken) return;
      try {
        const result = await createOrUpdateCalendarEvent(student, googleToken);
        setStudents((prev) =>
          prev.map((s) =>
            s.id === student.id ? { ...s, googleEventId: result.id } : s,
          ),
        );
        await supabase
          .from("students")
          .update({ google_event_id: result.id })
          .eq("id", student.id);
        setSyncMsg({
          type: "success",
          text: `${student.name} — ${student.googleEventId ? "עודכן" : "נוסף"} ביומן`,
        });
      } catch (err) {
        setSyncMsg({ type: "error", text: `שגיאה: ${err.message}` });
      }
      setTimeout(() => setSyncMsg(null), 4000);
    },
    [googleToken, setStudents],
  );

  async function syncAllStudents(scheduledStudents) {
    for (const s of scheduledStudents) await syncStudent(s);
  }

  // ── Settings save ─────────────────────────────────────────────────────────

  async function saveSettings(newSettings) {
    setSettings(newSettings);
    await supabase.from("user_settings").upsert({
      user_id: user.id,
      google_calendar_key: newSettings.googleCalendarKey,
      google_client_id: newSettings.googleClientId,
      morning_key: newSettings.morningKey,
      morning_secret: newSettings.morningSecret,
      whapi_token: newSettings.whapiToken,
      webhook_secret: newSettings.webhookSecret,
      automation_enabled: newSettings.automationEnabled,
    });
  }

  // ── Availability save ─────────────────────────────────────────────────────

  async function saveAvailability(windows) {
    setAvailability(windows);
    await supabase.from("teacher_availability").delete().eq("user_id", user.id);
    if (windows.length > 0) {
      await supabase.from("teacher_availability").insert(
        windows.map((w) => ({
          user_id: user.id,
          day_of_week: w.day_of_week,
          start_time: w.start_time,
          end_time: w.end_time,
        })),
      );
    }
  }

  // ── Sign out ──────────────────────────────────────────────────────────────

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  // ── Student CRUD ───────────────────────────────────────────────────────────

  async function addStudent(student) {
    setStudents((prev) => [...prev, student]);
    await supabase.from("students").insert(studentToDb(student, user.id));
  }

  async function addStudents(partialList) {
    const newStudents = partialList.map((p) => ({
      id: crypto.randomUUID(),
      name: p.name,
      instrument: "לא צוין",
      phone: "",
      level: "מתחיל",
      contactName: "",
      contactPhone: "",
      price: 0,
      lessonDay: p.lessonDay,
      lessonTime: p.lessonTime,
      avatar: getInitials(p.name),
      googleEventId: null,
      reminderToStudent: true,
      reminderToParent: false,
      billingToStudent: false,
      billingToParent: true,
      progress: 0,
      nextLesson: null,
    }));
    setStudents((prev) => [...prev, ...newStudents]);
    await supabase
      .from("students")
      .insert(newStudents.map((s) => studentToDb(s, user.id)));
    setSyncMsg({
      type: "success",
      text: `✓ ${newStudents.length} תלמידים נוספו`,
    });
    setTimeout(() => setSyncMsg(null), 3000);
  }

  // ── GCal Change Detection ─────────────────────────────────────────────────

  const detectCalChanges = useCallback(async () => {
    if (!googleToken || students.length === 0) return;
    try {
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
          "?singleEvents=false&maxResults=500&fields=items(id,summary,recurrence,start)",
        { headers: { Authorization: `Bearer ${googleToken}` } },
      );
      if (!res.ok) return;
      const json = await res.json();
      const eventMap = {};
      for (const ev of json.items || []) eventMap[ev.id] = ev;

      const changes = [];
      for (const student of students) {
        if (!student.googleEventId) continue;
        const ev = eventMap[student.googleEventId];
        if (!ev) continue;
        const parsed = parseGCalEvent(ev);
        const dayChanged =
          parsed.lessonDay !== "" &&
          parsed.lessonDay !== String(student.lessonDay);
        const timeChanged =
          parsed.lessonTime !== "" && parsed.lessonTime !== student.lessonTime;
        if (dayChanged || timeChanged) {
          changes.push({
            student,
            newDay: parsed.lessonDay,
            newTime: parsed.lessonTime,
          });
        }
      }
      if (changes.length > 0) {
        setCalChanges(changes);
        setShowCalChanges(true);
      }
    } catch {
      /* silent — token may have expired */
    }
  }, [googleToken, students]);

  // Poll for GCal changes every 10 minutes while token is live
  useEffect(() => {
    if (!googleToken) return;
    detectCalChanges();
    const interval = setInterval(detectCalChanges, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [googleToken, detectCalChanges]);

  async function importStudentsFromGCal(gcalEvents) {
    const newStudents = gcalEvents.map((ev) => ({
      id: crypto.randomUUID(),
      name: ev.name || ev.gcalSummary || "תלמיד",
      instrument: "לא צוין",
      phone: "",
      level: "מתחיל",
      contactName: "",
      contactPhone: "",
      price: 0,
      lessonDay: ev.lessonDay,
      lessonTime: ev.lessonTime,
      avatar: getInitials(ev.name || ev.gcalSummary || "ת"),
      googleEventId: ev.googleEventId,
      reminderToStudent: true,
      reminderToParent: false,
      billingToStudent: false,
      billingToParent: true,
      progress: 0,
      nextLesson: null,
    }));
    if (newStudents.length === 0) return;
    setStudents((prev) => [...prev, ...newStudents]);
    await supabase
      .from("students")
      .insert(newStudents.map((s) => studentToDb(s, user.id)));
    setSyncMsg({
      type: "success",
      text: `✓ ${newStudents.length} תלמידים יובאו מ-Google Calendar`,
    });
    setTimeout(() => setSyncMsg(null), 4000);
  }

  async function saveEditedStudent(data) {
    const updated = { ...editingStudent, ...data };
    setStudents((prev) =>
      prev.map((s) => (s.id === editingStudent.id ? updated : s)),
    );
    setEditingStudent(null);
    await supabase
      .from("students")
      .update(studentToDb(updated, user.id))
      .eq("id", updated.id);
  }

  async function deleteStudent() {
    const id = editingStudent.id;
    setEditingStudent(null);
    setStudents((prev) => prev.filter((s) => s.id !== id));
    await supabase.from("students").delete().eq("id", id);
  }

  // ── Contact Picker sync ────────────────────────────────────────────────────

  async function syncContactPhones(updates) {
    if (updates.length === 0) return;
    const patched = [...students];
    for (const { student, newPhone, field } of updates) {
      const idx = patched.findIndex((s) => s.id === student.id);
      if (idx === -1) continue;
      patched[idx] = { ...patched[idx], [field]: newPhone };
      const dbField = field === "phone" ? "phone" : "contact_phone";
      await supabase
        .from("students")
        .update({ [dbField]: newPhone })
        .eq("id", student.id);
    }
    setStudents(patched);
    setSyncMsg({
      type: "success",
      text: `✓ ${updates.length} מספרים עודכנו מאנשי קשר`,
    });
    setTimeout(() => setSyncMsg(null), 3500);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderView() {
    switch (activeTab) {
      case "schedule":
        return (
          <ScheduleView
            students={students}
            onEditStudent={setEditingStudent}
            googleToken={googleToken}
            onSyncCalendar={syncAllStudents}
            onOpenImport={() => setShowImportWizard(true)}
            onConnectGoogle={connectGoogle}
            clientId={settings.googleClientId}
            onImportStudents={addStudents}
          />
        );
      case "students":
        return (
          <StudentsView
            students={students}
            onAddStudent={addStudent}
            onEditStudent={setEditingStudent}
            googleToken={googleToken}
            onSyncOne={syncStudent}
            onSyncContacts={syncContactPhones}
          />
        );
      case "invoices":
        return <InvoicesView students={students} settings={settings} />;
      case "settings":
        return (
          <SettingsView
            settings={settings}
            onSave={saveSettings}
            googleToken={googleToken}
            onConnectGoogle={connectGoogle}
            onDisconnectGoogle={disconnectGoogle}
            userId={user.id}
            supabaseUrl={import.meta.env.VITE_SUPABASE_URL}
            calendarBotConnected={!!settings.googleRefreshToken}
            availability={availability}
            onSaveAvailability={saveAvailability}
          />
        );
      default:
        return null;
    }
  }

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0d0d11]">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh bg-[#0d0d11] overflow-hidden" dir="rtl">
      {/* ── Sidebar ── */}
      <aside
        className={`${sidebarOpen ? "w-56" : "w-14"} bg-[#111117] border-l border-white/[0.07] flex flex-col transition-all duration-300 shrink-0 hidden sm:flex`}
      >
        <div className="flex items-center gap-3 px-4 py-5 border-b border-white/[0.07]">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <svg className="w-4 h-[14px]" viewBox="0 0 48 46" fill="white">
              <path d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
            </svg>
          </div>
          {sidebarOpen && (
            <div>
              <p className="font-bold text-white text-sm tracking-tight">
                Tempo
              </p>
              <p className="text-[11px] text-slate-500">ניהול תלמידים</p>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all text-right ${
                activeTab === item.id
                  ? "bg-indigo-500/[0.12] text-indigo-300"
                  : "text-slate-500 hover:bg-white/[0.05] hover:text-slate-200"
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              {sidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        <div
          className={`border-t border-white/[0.07] p-3 flex items-center gap-2.5 ${!sidebarOpen && "justify-center"}`}
        >
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {user.email?.[0]?.toUpperCase() || "א"}
          </div>
          {sidebarOpen && (
            <div className="flex-1 min-w-0">
              <p
                className="text-xs font-semibold text-slate-200 truncate"
                dir="ltr"
              >
                {user.email}
              </p>
              <button
                onClick={handleSignOut}
                className="text-[11px] text-slate-500 hover:text-red-400 transition-colors"
              >
                התנתק
              </button>
            </div>
          )}
          {!sidebarOpen && (
            <button onClick={handleSignOut} title="התנתק" className="hidden" />
          )}
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-[#111117] border-b border-white/[0.07] px-4 sm:px-6 py-3.5 flex items-center gap-3 shrink-0">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="p-1.5 rounded-xl text-slate-500 hover:bg-white/[0.05] hover:text-white transition-colors hidden sm:block"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center sm:hidden shrink-0">
            <svg
              className="w-3.5 h-3 text-white"
              viewBox="0 0 48 46"
              fill="white"
            >
              <path d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
            </svg>
          </div>
          <h1 className="text-base font-bold text-white">
            {VIEW_LABELS[activeTab]}
          </h1>
          <div className="mr-auto flex items-center gap-2">
            {googleToken && (
              <>
                <div
                  className="w-2 h-2 bg-emerald-400 rounded-full"
                  title="Google Calendar מחובר"
                />
                <button
                  onClick={detectCalChanges}
                  title="בדוק שינויים ביומן"
                  className="p-1.5 text-slate-500 hover:bg-white/[0.05] hover:text-blue-400 rounded-xl transition-colors hidden sm:block"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </>
            )}
            <button
              onClick={() => calChanges.length > 0 && setShowCalChanges(true)}
              className="relative p-1.5 text-slate-500 hover:bg-white/[0.05] hover:text-white rounded-xl transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {calChanges.length > 0 ? (
                <span className="absolute top-1 right-1 w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
              ) : (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-indigo-500 rounded-full" />
              )}
            </button>
          </div>
        </header>

        {/* Sync toast */}
        {syncMsg && (
          <div
            className={`mx-4 mt-3 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium border ${
              syncMsg.type === "success"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-red-500/10 border-red-500/30 text-red-300"
            }`}
          >
            <svg
              className="w-4 h-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              {syncMsg.type === "success" ? (
                <polyline points="20 6 9 17 4 12" />
              ) : (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              )}
            </svg>
            {syncMsg.text}
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {renderView()}
        </main>

        {/* ── Mobile bottom nav ── */}
        <nav className="sm:hidden bg-[#111117] border-t border-white/[0.06] flex shrink-0 safe-bottom">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-semibold transition-colors ${
                activeTab === item.id ? "text-indigo-300" : "text-slate-600"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* GCal changes modal */}
      {showCalChanges && calChanges.length > 0 && (
        <CalChangesModal
          changes={calChanges}
          onClose={() => setShowCalChanges(false)}
        />
      )}

      {/* GCal import wizard */}
      {showImportWizard && (
        <GCalImportWizard
          googleToken={googleToken}
          existingStudents={students}
          onImport={importStudentsFromGCal}
          onClose={() => setShowImportWizard(false)}
        />
      )}

      {/* Edit modal */}
      {editingStudent && (
        <StudentForm
          title={`עריכה — ${editingStudent.name}`}
          saveLabel="שמור שינויים"
          initial={{
            name: editingStudent.name,
            instrument:
              editingStudent.instrument === "לא צוין"
                ? ""
                : editingStudent.instrument,
            phone: editingStudent.phone || "",
            level: editingStudent.level,
            contactName: editingStudent.contactName || "",
            contactPhone: editingStudent.contactPhone || "",
            price: editingStudent.price > 0 ? String(editingStudent.price) : "",
            lessonDay: editingStudent.lessonDay ?? "",
            lessonTime: editingStudent.lessonTime || "",
            reminderToStudent: editingStudent.reminderToStudent ?? true,
            reminderToParent: editingStudent.reminderToParent ?? false,
            billingToStudent: editingStudent.billingToStudent ?? false,
            billingToParent: editingStudent.billingToParent ?? true,
          }}
          onSave={saveEditedStudent}
          onDelete={deleteStudent}
          onClose={() => setEditingStudent(null)}
        />
      )}
    </div>
  );
}
