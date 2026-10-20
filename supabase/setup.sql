-- Our Budget: run this once in your Supabase project (SQL Editor → New query → Run).
-- The table only ever holds ciphertext. Supabase cannot read your expenses.

create table if not exists public.records (
  household  text        not null check (length(household) >= 32),
  id         text        not null check (length(id) <= 100),
  data       text        not null check (length(data) <= 100000),
  client_ts  bigint      not null,
  server_ts  timestamptz not null default clock_timestamp(),
  primary key (household, id)
);

create index if not exists records_household_server_ts on public.records (household, server_ts);

-- Newer edit wins; also stamps server time so phones can pull only what changed.
create or replace function public.records_merge() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.client_ts < old.client_ts then
    new.data := old.data;
    new.client_ts := old.client_ts;
  end if;
  new.server_ts := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_merge on public.records;
create trigger records_merge before insert or update on public.records
  for each row execute function public.records_merge();

-- Row Level Security: a phone can only see rows for the household id it sends
-- in the x-household header (a random 48-character id from your invite code).
alter table public.records enable row level security;

create or replace function public.request_household() returns text
language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'x-household', '')
$$;

drop policy if exists records_select on public.records;
drop policy if exists records_insert on public.records;
drop policy if exists records_update on public.records;

create policy records_select on public.records for select to anon
  using (household = public.request_household());
create policy records_insert on public.records for insert to anon
  with check (household = public.request_household());
create policy records_update on public.records for update to anon
  using (household = public.request_household())
  with check (household = public.request_household());

-- No deletes from the app (deletes are synced as encrypted tombstones).
revoke all on public.records from anon, authenticated;
grant select, insert, update on public.records to anon;
