import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeFreeSlots,
  hebrewMonthLabel,
  hoursUntilNextLesson,
  isBeyond24h,
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
