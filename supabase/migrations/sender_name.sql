-- The display name students see as the sender (shared bot number names the
-- teacher). Free text — defaults to the teacher's name; a teacher can set a
-- studio/brand name instead. Run in: Supabase SQL Editor (clear it first).
alter table user_settings
  add column if not exists sender_name text;
