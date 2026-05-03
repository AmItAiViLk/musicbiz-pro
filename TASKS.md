# Tempo — Future Tasks

## In Progress / Next Up

### Complete Student Profiles

- [ ] Phone number fields validation (Israeli format)
- [ ] Communication switches (send_to_student / send_to_parent) visible on student cards
- [ ] Profile photo / avatar color picker

### Morning API Integration

- [ ] API Key + Secret already wired in Settings — paste credentials and test
- [ ] Payment status badge in Invoices view (endpoint: `/api/morning-status`)
- [ ] Auto-skip billing reminder if Morning shows invoice already paid

### Branding & Logo — "Tempo"

- [ ] Rename app title from "MusicPro" to "Tempo" across all UI
- [ ] Replace music note SVG logo with metronome / tempo icon
- [ ] Update `<title>` in index.html
- [ ] Favicon update

### AI Auto-Responder Skill

- [ ] Design: incoming WhatsApp message → AI generates reply draft
- [ ] Options: webhook via Twilio / WhatsApp Business API
- [ ] Claude API integration for reply generation (context: student name, lesson day, last message)
- [ ] Skill file: `.claude/skills/ai-responder.md`

---

## Completed ✓

- [x] Supabase migration (students + user_settings)
- [x] Google OAuth (GIS token client) — connect from Settings or dashboard
- [x] WhatsApp deep links (`whatsapp://` on mobile)
- [x] Name logic: `שלנו` vs `של [name]` based on contactName
- [x] Communication preferences (send_to_student / send_to_parent checkboxes)
- [x] WaChoiceModal — choose student or parent when both are checked
- [x] Google Calendar import wizard (filters lesson-titled recurring events)
- [x] Quick Import — paste freeform list, parsed to students instantly
- [x] Delete student with confirmation
- [x] Morning settings fields (API Key + Secret)
- [x] Morning payment check proxy (`/api/morning-status`)
- [x] CLAUDE.md permanent rules for Tempo
