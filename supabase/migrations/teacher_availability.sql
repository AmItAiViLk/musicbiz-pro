-- ── Dynamic Teacher Availability ─────────────────────────────────────────────
-- Run this in: Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS teacher_availability (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  created_at  timestamptz DEFAULT now(),

  CONSTRAINT availability_time_order CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_availability_user_day
  ON teacher_availability (user_id, day_of_week);

ALTER TABLE teacher_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "owner_all" ON teacher_availability
  FOR ALL USING (auth.uid() = user_id);
