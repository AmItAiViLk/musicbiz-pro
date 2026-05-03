# Tempo — Music School Management

## Project Identity

- App name: **Tempo**
- Stack: React 19 + Vite + Tailwind v4 + Supabase (auth + DB)
- Purpose: Music school management — students, scheduling, billing, WhatsApp reminders

## Language

- All UI labels and messages must be in **Hebrew**
- Font: **Heebo** (Google Fonts)
- Layout direction: RTL (`dir="rtl"`)

## The 24h Rule

- Reminders are sent **25 hours before** the lesson
- Sunday lesson reminders are sent on **Friday at 13:00** (not Saturday)

## Messaging Logic

- If a student has a `contactName` (parent): address the message to the parent, refer to the student by name → `שיעור של [שם התלמיד]`
- If **no** `contactName` exists: address the student directly, use **`שלנו`** instead of repeating the student's name → `שיעור שלנו`
- Mobile WhatsApp links must use the **deep link scheme**: `whatsapp://send?phone=...&text=...`
- Desktop WhatsApp links use: `https://web.whatsapp.com/send?phone=...&text=...`

## Billing

- Monthly lesson count = occurrences of the student's lesson day in the current month − Israeli holidays
- Total = lesson count × price per lesson
- Israeli holidays list is maintained in `ISRAELI_HOLIDAYS` (Set of `YYYY-MM-DD` strings) in `App.jsx`

## Communication

- Always communicate with the user in **Hebrew**

## Automation / Logging

- Primary automation log table: `tempo_automation_logs`
- `student_id` is always type **text** (never integer)

## AI / Token Efficiency

- Use **Haiku** (claude-haiku-4-5-20251001) for classification tasks to minimize token cost
