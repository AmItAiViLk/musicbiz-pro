import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseMorningPaid } from "./morning.ts";

Deno.test("parseMorningPaid reads status", () => {
  assertEquals(parseMorningPaid({ items: [{ status: "paid" }] }), true);
  assertEquals(parseMorningPaid({ items: [{ status: "closed" }] }), true);
  assertEquals(parseMorningPaid({ items: [{ status: "open" }] }), false);
  assertEquals(parseMorningPaid({ items: [] }), null);
  assertEquals(parseMorningPaid([{ paymentStatus: "PAID" }]), true);
});
