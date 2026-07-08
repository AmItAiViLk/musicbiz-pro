-- Per-teacher lesson length (minutes). Drives free-slot computation in the
-- reschedule/swap engine. Default 45 (a lesson slot is 45 minutes).
alter table user_settings
  add column if not exists lesson_duration_minutes integer not null default 45;
