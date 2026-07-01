import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildClassifyPrompt,
  parseCancelReason,
  parseIntent,
} from "./classify.ts";

Deno.test("parseIntent maps clean labels", () => {
  assertEquals(parseIntent("cancel"), "cancel");
  assertEquals(parseIntent("paid"), "paid");
  assertEquals(parseIntent("reschedule"), "reschedule");
});

Deno.test("parseIntent extracts label from a sentence", () => {
  assertEquals(parseIntent("The intent is: paid."), "paid");
});

Deno.test("parseIntent falls back to other", () => {
  assertEquals(parseIntent("בלהבלה"), "other");
  assertEquals(parseIntent(""), "other");
});

Deno.test("buildClassifyPrompt includes the message and labels", () => {
  const p = buildClassifyPrompt("אני חולה");
  assertEquals(p.includes("אני חולה"), true);
  assertEquals(p.includes("cancel"), true);
  assertEquals(p.includes("reschedule"), true);
});

Deno.test("parseCancelReason maps labels and falls back to unknown", () => {
  assertEquals(parseCancelReason("exempt"), "exempt");
  assertEquals(parseCancelReason("chargeable"), "chargeable");
  assertEquals(parseCancelReason("unknown"), "unknown");
  assertEquals(parseCancelReason("משהו לא ברור"), "unknown");
  assertEquals(parseCancelReason(""), "unknown");
});
