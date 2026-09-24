-- Hello Beaches: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor > New query and press Run.
-- Running it again is safe; it only creates what is missing and replaces the functions.
--
-- Part 1: community beach ratings (used by the site directly).
-- Part 2: the Google Maps allowance counter (used only by the google-place Edge Function).

-- ============================================================================================
-- Part 1: community ratings
-- ============================================================================================

create table if not exists public.beach_ratings (
  beach_id   text        not null,
  voter      uuid        not null,
  stars      smallint    not null,
  ip_hash    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (beach_id, voter),
  constraint beach_ratings_beach_id_format check (beach_id ~ '^(node|way|relation)/[0-9]{1,15}$'),
  constraint beach_ratings_stars_range check (stars between 1 and 5)
);

create index if not exists beach_ratings_ip_recent on public.beach_ratings (ip_hash, updated_at);

-- The table is closed to the public API on purpose: row level security with no policies, and no
-- grants. Visitors reach it only through the two functions below, which check every input.
alter table public.beach_ratings enable row level security;
revoke all on table public.beach_ratings from anon, authenticated;

-- Save or change one visitor's rating and return the beach's new average.
create or replace function public.rate_beach(p_beach text, p_voter uuid, p_stars integer)
returns table (avg_stars numeric, votes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_headers json;
  v_ip      text;
  v_hash    text;
  v_recent  integer;
begin
  if p_beach is null or p_beach !~ '^(node|way|relation)/[0-9]{1,15}$' then
    raise exception 'Invalid beach id' using errcode = '22023';
  end if;
  if p_voter is null then
    raise exception 'Missing voter id' using errcode = '22023';
  end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    raise exception 'Stars must be between 1 and 5' using errcode = '22023';
  end if;

  -- Slow down floods: at most 60 ratings an hour from one connection. Only a hash of the address is kept.
  v_headers := nullif(current_setting('request.headers', true), '')::json;
  v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  if v_ip is not null then
    v_hash := md5(v_ip);
    select count(*) into v_recent
      from public.beach_ratings r
     where r.ip_hash = v_hash
       and r.updated_at > now() - interval '1 hour';
    if v_recent >= 60 then
      raise exception 'Too many ratings from this connection. Try again in an hour.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.beach_ratings as r (beach_id, voter, stars, ip_hash)
  values (p_beach, p_voter, p_stars::smallint, v_hash)
  on conflict (beach_id, voter)
  do update set stars = excluded.stars, ip_hash = excluded.ip_hash, updated_at = now();

  return query
    select round(avg(r.stars), 2), count(*)
      from public.beach_ratings r
     where r.beach_id = p_beach;
end;
$$;

-- Averages for up to 200 beaches at once, for the list view.
create or replace function public.beach_rating_summary(p_beaches text[])
returns table (beach_id text, avg_stars numeric, votes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select r.beach_id, round(avg(r.stars), 2), count(*)
    from public.beach_ratings r
   where r.beach_id = any (p_beaches[1:200])
   group by r.beach_id;
$$;

revoke all on function public.rate_beach(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.beach_rating_summary(text[]) from public, anon, authenticated;
grant execute on function public.rate_beach(text, uuid, integer) to anon, authenticated;
grant execute on function public.beach_rating_summary(text[]) to anon, authenticated;

-- ============================================================================================
-- Part 2: Google Maps allowance counter
-- Google gives 1,000 free calls a month per kind (Place Details Enterprise, Place Details Photos).
-- The Edge Function books every call here first; once a month's count reaches 900 it is refused,
-- so the bill stays at zero. Months follow Google's billing clock (US Pacific time).
-- ============================================================================================

create table if not exists public.google_usage (
  scope text    not null,
  kind  text    not null,
  used  integer not null default 0,
  primary key (scope, kind)
);

-- Beach to Google place. Google allows keeping place IDs indefinitely; nothing else is stored.
create table if not exists public.google_places (
  beach_id     text        primary key,
  place_id     text,
  looked_up_at timestamptz not null default now(),
  constraint google_places_beach_id_format check (beach_id ~ '^(node|way|relation)/[0-9]{1,15}$')
);

alter table public.google_usage  enable row level security;
alter table public.google_places enable row level security;
revoke all on table public.google_usage  from anon, authenticated;
revoke all on table public.google_places from anon, authenticated;

-- How many of p_amount calls of one kind may go ahead now. Books them before it returns.
create or replace function public.claim_google(p_kind text, p_amount integer, p_ip_hash text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_month_cap constant integer := 900;   -- Google's free allowance is 1,000 a month; keep a margin
  v_ip_cap    constant integer := 40;    -- per connection per day, so one visitor cannot use it all
  v_now        timestamp := now() at time zone 'America/Los_Angeles';
  v_month      text := 'month:' || to_char(v_now, 'YYYY-MM');
  v_day        text := 'ip:' || to_char(v_now, 'YYYY-MM-DD') || ':' || coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_month_used integer;
  v_ip_used    integer;
  v_allowed    integer;
begin
  if p_kind is null or p_kind not in ('details', 'photo') then
    raise exception 'Unknown kind' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 10 then
    raise exception 'Amount must be 1 to 10' using errcode = '22023';
  end if;

  insert into public.google_usage (scope, kind) values (v_month, p_kind), (v_day, p_kind)
  on conflict do nothing;
  -- Lock both counters (always in the same order) so parallel requests cannot overshoot.
  select u.used into v_month_used from public.google_usage u where u.scope = v_month and u.kind = p_kind for update;
  select u.used into v_ip_used    from public.google_usage u where u.scope = v_day   and u.kind = p_kind for update;

  v_allowed := greatest(0, least(p_amount, v_month_cap - v_month_used, v_ip_cap - v_ip_used));
  if v_allowed > 0 then
    update public.google_usage u set used = u.used + v_allowed
     where u.kind = p_kind and u.scope in (v_month, v_day);
  end if;

  -- Housekeeping: per-connection rows older than two days are no longer needed.
  if v_ip_used = 0 then
    delete from public.google_usage u
     where u.scope like 'ip:%' and u.scope < 'ip:' || to_char(v_now - interval '2 days', 'YYYY-MM-DD');
  end if;

  return v_allowed;
end;
$$;

create or replace function public.google_place_get(p_beach text)
returns table (place_id text, looked_up_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.place_id, g.looked_up_at from public.google_places g where g.beach_id = p_beach;
$$;

create or replace function public.google_place_put(p_beach text, p_place text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.google_places (beach_id, place_id, looked_up_at)
  values (p_beach, nullif(p_place, ''), now())
  on conflict (beach_id) do update set place_id = excluded.place_id, looked_up_at = now();
$$;

-- Only the Edge Function (service role) may use these three.
revoke all on function public.claim_google(text, integer, text) from public, anon, authenticated;
revoke all on function public.google_place_get(text) from public, anon, authenticated;
revoke all on function public.google_place_put(text, text) from public, anon, authenticated;
grant execute on function public.claim_google(text, integer, text) to service_role;
grant execute on function public.google_place_get(text) to service_role;
grant execute on function public.google_place_put(text, text) to service_role;

-- Tell the API layer about the new functions right away.
notify pgrst, 'reload schema';
