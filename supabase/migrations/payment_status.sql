-- Per-student monthly payment tracking.
create table if not exists payment_status (
  id             uuid default gen_random_uuid() primary key,
  user_id        uuid not null,
  student_id     text not null,
  student_name   text,
  year_month     text not null,                 -- 'YYYY-MM'
  amount         numeric default 0,
  billed_at      timestamptz default now(),
  status         text not null default 'unpaid', -- 'unpaid' | 'paid'
  paid_source    text,                            -- 'manual' | 'morning' | null
  reminder_state text not null default 'none',    -- 'none'|'pending_confirm'|'reminded'|'escalated'
  updated_at     timestamptz default now()
);

create unique index if not exists payment_status_unique
  on payment_status (user_id, student_id, year_month);

create index if not exists payment_status_user_month
  on payment_status (user_id, year_month, status);

alter table payment_status enable row level security;
drop policy if exists "owner_all" on payment_status;
create policy "owner_all" on payment_status
  for all using (auth.uid() = user_id);

-- How the teacher tracks payment.
alter table user_settings
  add column if not exists payment_tracking_mode text default 'manual';
