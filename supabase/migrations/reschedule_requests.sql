-- ── Self-Service Student Rescheduling ────────────────────────────────────────
-- Run this in: Supabase Dashboard → SQL Editor

-- 1. Add google_refresh_token to user_settings
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS google_refresh_token text;

-- 2. Reschedule requests — tracks the full lifecycle of each request
CREATE TABLE IF NOT EXISTS reschedule_requests (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid        NOT NULL,                  -- teacher's user_id
  student_id       text        NOT NULL,                  -- students.id (text UUID)
  student_phone    text        NOT NULL,                  -- normalised E.164
  options          jsonb       NOT NULL DEFAULT '[]',     -- Slot[] offered to student
  selected_option  jsonb,                                 -- chosen Slot
  calendar_event_id text,                                 -- GCal event ID after approval
  status           text        NOT NULL DEFAULT 'pending_selection',
  -- 'pending_selection' | 'pending_approval' | 'approved' | 'rejected'
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Only one *active* (pending_selection) request per teacher+student at a time.
-- Completed (approved/rejected) rows remain in history without blocking new requests.
CREATE UNIQUE INDEX IF NOT EXISTS reschedule_requests_active_unique
  ON reschedule_requests (user_id, student_phone)
  WHERE status = 'pending_selection';

-- Indexes for fast webhook lookups
CREATE INDEX IF NOT EXISTS idx_reschedule_user_status
  ON reschedule_requests (user_id, status);

CREATE INDEX IF NOT EXISTS idx_reschedule_student_phone
  ON reschedule_requests (user_id, student_phone, status);

-- 3. RLS — only the owning teacher can read their own requests
ALTER TABLE reschedule_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_all" ON reschedule_requests;
CREATE POLICY "owner_all" ON reschedule_requests
  FOR ALL USING (auth.uid() = user_id);
