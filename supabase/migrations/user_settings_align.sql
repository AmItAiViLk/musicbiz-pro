-- Align user_settings with the application code.
-- The table was missing the columns the app reads/writes, so every settings
-- save silently failed and the table stayed empty. This adds them (additive,
-- non-destructive) and enforces one row per user via a unique user_id.

-- 1. Ensure inserts without an explicit id work (id is the row PK).
alter table user_settings alter column id set default gen_random_uuid();

-- 2. Add the columns the app expects.
alter table user_settings
  add column if not exists user_id uuid,
  add column if not exists google_calendar_key text,
  add column if not exists google_client_id text,
  add column if not exists morning_key text,
  add column if not exists morning_secret text,
  add column if not exists webhook_secret text;

-- 3. One settings row per user (required for upsert on user_id).
create unique index if not exists user_settings_user_id_key
  on user_settings (user_id);

-- 4. Seed / enable automation for the current teacher so reminders run.
insert into user_settings (user_id, automation_enabled)
select id, true from auth.users where email = 'amitaivilk@gmail.com'
on conflict (user_id) do update set automation_enabled = true;
