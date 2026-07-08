import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBillingParams,
  buildPaymentReminderParams,
  buildReminderParams,
  buildRescheduleConfirmParams,
  Student,
} from "./messaging.ts";

const base: Student = {
  id: "1",
  name: "דנה",
  phone: "0541234567",
  contactName: "",
  contactPhone: "",
  lessonDay: "1", // Monday
  lessonTime: "16:00",
  price: 80,
  reminderToStudent: true,
  reminderToParent: false,
  billingToStudent: false,
  billingToParent: true,
};

Deno.test("reminder params: no contactName uses שלנו", () => {
  assertEquals(buildReminderParams(base, "student"), [
    "דנה",
    "שלנו",
    "שני",
    "16:00",
  ]);
});

Deno.test("reminder params: parent uses 'של <name>'", () => {
  const s = { ...base, contactName: "אמא", contactPhone: "0549999999" };
  assertEquals(buildReminderParams(s, "parent"), [
    "אמא",
    "של דנה",
    "שני",
    "16:00",
  ]);
});

Deno.test("billing params order = [greeting, count, total] (3 vars)", () => {
  assertEquals(buildBillingParams(base, "student", 4), ["דנה", "4", "320"]);
});

Deno.test("payment reminder params = [amount, month]", () => {
  assertEquals(buildPaymentReminderParams(320, "יולי"), ["320", "יולי"]);
});

Deno.test("reschedule confirm params = [greeting, slot]", () => {
  assertEquals(buildRescheduleConfirmParams(base, "יום שני 09:00"), [
    "דנה",
    "יום שני 09:00",
  ]);
});
