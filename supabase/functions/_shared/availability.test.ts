import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseAvailability } from "./availability.ts";

Deno.test("parseAvailability reads a clean JSON array", () => {
  const raw =
    '[{"day":1,"start":"16:00","end":"20:00"},{"day":3,"start":"08:00","end":"12:00"}]';
  assertEquals(parseAvailability(raw), [
    { day: 1, start: "16:00", end: "20:00" },
    { day: 3, start: "08:00", end: "12:00" },
  ]);
});

Deno.test("parseAvailability tolerates surrounding prose/code fences", () => {
  const raw = 'בטח:\n```json\n[{"day":0,"start":"09:00","end":"11:00"}]\n```';
  assertEquals(parseAvailability(raw), [
    { day: 0, start: "09:00", end: "11:00" },
  ]);
});

Deno.test("parseAvailability drops malformed entries", () => {
  const raw =
    '[{"day":9,"start":"16:00","end":"20:00"},{"day":2,"start":"bad","end":"12:00"},{"day":2,"start":"10:00","end":"12:00"}]';
  assertEquals(parseAvailability(raw), [
    { day: 2, start: "10:00", end: "12:00" },
  ]);
});

Deno.test("parseAvailability returns [] on junk", () => {
  assertEquals(parseAvailability("אין לי מושג"), []);
});
