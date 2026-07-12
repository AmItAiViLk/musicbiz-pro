-- Swap engine (Scheduling Layer 2) schema additions.
-- Run in: Supabase Dashboard → SQL Editor (clear the editor first).

-- Per-student consent for the bot to contact them for a swap without the
-- teacher approving the contact first.
alter table students
  add column if not exists auto_swap_ok boolean not null default false;

-- Swap lifecycle fields on the existing reschedule_requests table.
alter table reschedule_requests
  add column if not exists kind text not null default 'reschedule',       -- 'reschedule' | 'swap'
  add column if not exists student_availability jsonb,                     -- AvailabilityWindow[]
  add column if not exists swap_target_student_id text,                    -- the partner being asked
  add column if not exists swap_target_slot jsonb,                         -- FreeSlot the partner will move to
  add column if not exists swap_candidate_ids jsonb not null default '[]', -- remaining SwapCandidate[]
  add column if not exists deadline_at timestamptz;                        -- 24h decline/timeout clock

-- Fast lookup of a partner's active swap request by their phone.
create index if not exists idx_reschedule_swap_partner
  on reschedule_requests (user_id, swap_target_student_id, status);
