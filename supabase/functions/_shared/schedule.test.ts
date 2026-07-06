import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hebrewMonthLabel,
  hoursUntilNextLesson,
  isBeyond24h,
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
