-- Patro: database setup.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run: every statement checks whether the object already exists.

-- ---------- tasks ----------
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date          date not null,                -- AD date the task belongs to
  start_time    time,                         -- null = no set time (all-day task)
  end_time      time,
  title         text not null check (char_length(title) between 1 and 200),
  description   text,
  done          boolean not null default false,
  remind        boolean not null default true,
  remind_before integer not null default 15 check (remind_before between 0 and 10080), -- minutes
  remind_at     timestamptz,                  -- when the reminder fires; set by the app
  notified_at   timestamptz,                  -- when the reminder was sent (phase 3)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists tasks_user_date_idx on public.tasks (user_id, date);
create index if not exists tasks_due_reminders_idx on public.tasks (remind_at)
  where remind and notified_at is null and not done;

-- ---------- per-user settings ----------
create table if not exists public.user_settings (
  user_id               uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  default_remind_before integer not null default 15 check (default_remind_before between 0 and 10080),
  updated_at            timestamptz not null default now()
);

-- ---------- keep updated_at current ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---------- row level security: each user sees only their own rows ----------
alter table public.tasks enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------- repeating tasks (added later; safe to re-run) ----------
-- repeat: none | daily | weekly | monthly | yearly, every `repeat_every` of those.
-- repeat_until: last day (null = forever). repeat_count: "ends after N times" as chosen in the app.
-- done_dates / skip_dates: the repeats ticked off / deleted one by one.
alter table public.tasks add column if not exists repeat       text    not null default 'none';
alter table public.tasks add column if not exists repeat_every integer not null default 1;
alter table public.tasks add column if not exists repeat_until date;
alter table public.tasks add column if not exists repeat_count integer;
alter table public.tasks add column if not exists done_dates   date[]  not null default '{}';
alter table public.tasks add column if not exists skip_dates   date[]  not null default '{}';
do $$ begin
  alter table public.tasks add constraint tasks_repeat_ok
    check (repeat in ('none','daily','weekly','monthly','yearly') and repeat_every between 1 and 99);
exception when duplicate_object then null; end $$;

-- ---------- phone alarms + snooze (added later; safe to re-run) ----------
alter table public.tasks         add column if not exists alarm          boolean not null default false;
alter table public.user_settings add column if not exists snooze_enabled boolean not null default false;
alter table public.user_settings add column if not exists snooze_minutes integer not null default 5;
do $$ begin
  alter table public.user_settings add constraint user_settings_snooze_ok check (snooze_minutes between 1 and 60);
exception when duplicate_object then null; end $$;

-- ---------- alert at the end time (added later; safe to re-run) ----------
alter table public.tasks add column if not exists end_alert text not null default 'none';
do $$ begin
  alter table public.tasks add constraint tasks_end_alert_ok check (end_alert in ('none','notify','alarm'));
exception when duplicate_object then null; end $$;
