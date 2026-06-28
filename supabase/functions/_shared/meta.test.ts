import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTemplatePayload, buildTextPayload } from "./meta.ts";

Deno.test("buildTemplatePayload normalizes phone and orders params", () => {
  const p = buildTemplatePayload("0541234567", "lesson_reminder", "he", [
    "דנה",
    "שלנו",
    "שני",
    "16:00",
  ]);
  assertEquals(p.to, "972541234567");
  assertEquals(p.type, "template");
  assertEquals(p.template.name, "lesson_reminder");
  assertEquals(p.template.language.code, "he");
  assertEquals(
    p.template.components[0].parameters.map((x) => x.text),
    ["דנה", "שלנו", "שני", "16:00"],
  );
});

Deno.test("buildTextPayload normalizes phone and wraps body", () => {
  const p = buildTextPayload("972501112222", "שלום");
  assertEquals(p.to, "972501112222");
  assertEquals(p.type, "text");
  assertEquals(p.text.body, "שלום");
});
