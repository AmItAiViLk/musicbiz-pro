import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeFreeSlots,
  findSwapCandidates,
  hebrewMonthLabel,
  hoursUntilNextLesson,
  isBeyond24h,
  slotFitsAvailability,
  slotLabel,
  yearMonthKey,
} from "./schedule.ts";

// 2026-06-28 is a Sunday.
const sunday10 = new Date(2026, 5, 28, 10, 0, 0); // Sun 10:00

Deno.test("lesson tomorrow (Mon 16:00) is ~30h away → beyond 24h", () => {
  const h = hoursUntilNextLesson("1", "16:00", sunday10);
  assertEquals(Math.round(h), 30);
  assertEquals(isBeyond24h("1", "16:00", sunday10), true);
});

Deno.test("lesson today later (Sun 16:00) is 6h away → within 24h", () => {
  const h = hoursUntilNextLesson("0", "16:00", sunday10);
  assertEquals(Math.round(h), 6);
  assertEquals(isBeyond24h("0", "16:00", sunday10), false);
});

Deno.test("lesson today but already passed → next week", () => {
  const monday17 = new Date(2026, 5, 29, 17, 0, 0); // Mon 17:00
  const h = hoursUntilNextLesson("1", "16:00", monday17); // Mon 16:00 passed
  assertEquals(Math.round(h), 167); // ~7 days minus 1h
});

Deno.test("invalid input → Infinity", () => {
  assertEquals(hoursUntilNextLesson("", "16:00", sunday10), Infinity);
  assertEquals(hoursUntilNextLesson("1", "", sunday10), Infinity);
});

Deno.test("yearMonthKey formats YYYY-MM", () => {
  assertEquals(yearMonthKey(new Date(2026, 0, 5)), "2026-01");
  assertEquals(yearMonthKey(new Date(2026, 11, 31)), "2026-12");
});

Deno.test("hebrewMonthLabel maps month number to name", () => {
  assertEquals(hebrewMonthLabel("2026-07"), "יולי");
  assertEquals(hebrewMonthLabel("2026-01"), "ינואר");
});

Deno.test("computeFreeSlots defaults to 45-min back-to-back slots", () => {
  const avail = [
    { day_of_week: 1, start_time: "09:00:00", end_time: "12:00:00" },
  ];
  // 09:00-12:00 packs 45-min slots: 09:00, 09:45, 10:30, 11:15.
  assertEquals(computeFreeSlots(avail, []), [
    { day: 1, time: "09:00" },
    { day: 1, time: "09:45" },
    { day: 1, time: "10:30" },
    { day: 1, time: "11:15" },
  ]);
});

Deno.test(
  "computeFreeSlots: occupied lesson blocks its full 45-min range",
  () => {
    const avail = [
      { day_of_week: 1, start_time: "09:00:00", end_time: "12:00:00" },
    ];
    // A lesson at 10:00 spans 10:00-10:45, overlapping the 09:45 and 10:30 slots.
    const occupied = [{ day: 1, time: "10:00" }];
    assertEquals(computeFreeSlots(avail, occupied), [
      { day: 1, time: "09:00" },
      { day: 1, time: "11:15" },
    ]);
  },
);

Deno.test("computeFreeSlots honors a custom slot length", () => {
  const avail = [{ day_of_week: 2, start_time: "16:00", end_time: "18:00" }];
  // 60-min slots: 16:00, 17:00. Occupied 17:00 blocks the second.
  assertEquals(computeFreeSlots(avail, [{ day: 2, time: "17:00" }], 60), [
    { day: 2, time: "16:00" },
  ]);
});

Deno.test("computeFreeSlots: no room for a full slot yields nothing", () => {
  const avail = [{ day_of_week: 3, start_time: "09:00", end_time: "09:30" }];
  assertEquals(computeFreeSlots(avail, []), []);
});

Deno.test("slotLabel formats day + time in Hebrew", () => {
  assertEquals(slotLabel({ day: 1, time: "09:00" }), "יום שני 09:00");
});

Deno.test("slotFitsAvailability: slot inside a window fits", () => {
  const windows = [{ day: 1, start: "16:00", end: "20:00" }];
  assertEquals(slotFitsAvailability({ day: 1, time: "16:00" }, windows), true);
  assertEquals(slotFitsAvailability({ day: 1, time: "19:15" }, windows), true); // 19:15-20:00
});

Deno.test(
  "slotFitsAvailability: slot spilling past the window does not fit",
  () => {
    const windows = [{ day: 1, start: "16:00", end: "20:00" }];
    assertEquals(
      slotFitsAvailability({ day: 1, time: "19:30" }, windows),
      false,
    ); // ends 20:15
    assertEquals(
      slotFitsAvailability({ day: 2, time: "16:00" }, windows),
      false,
    ); // wrong day
  },
);

Deno.test(
  "findSwapCandidates: returns students whose slot fits, auto-swap first",
  () => {
    const avail = [{ day_of_week: 1, start_time: "16:00", end_time: "20:00" }];
    const occupied = [
      { day: 1, time: "16:00", studentId: "dana" }, // the rescheduling student
      { day: 1, time: "17:00", studentId: "yossi" }, // fits dana's availability
      { day: 1, time: "19:30", studentId: "noa" }, // spills past window → excluded
      { day: 2, time: "16:00", studentId: "gil" }, // wrong day → excluded
    ];
    const danaAvailability = [{ day: 1, start: "16:45", end: "18:30" }];
    const candidates = findSwapCandidates(
      avail,
      occupied,
      "dana",
      danaAvailability,
      45,
      new Set(["yossi"]),
    );
    assertEquals(candidates, [
      { studentId: "yossi", slot: { day: 1, time: "17:00" } },
    ]);
  },
);

Deno.test(
  "findSwapCandidates: none when no free slot exists for a partner to move to",
  () => {
    // Availability window holds exactly two 45-min slots, both occupied → nowhere to move.
    const avail = [{ day_of_week: 1, start_time: "16:00", end_time: "17:30" }];
    const occupied = [
      { day: 1, time: "16:00", studentId: "dana" },
      { day: 1, time: "16:45", studentId: "yossi" },
    ];
    const danaAvailability = [{ day: 1, start: "16:00", end: "17:30" }];
    assertEquals(
      findSwapCandidates(avail, occupied, "dana", danaAvailability, 45),
      [],
    );
  },
);
