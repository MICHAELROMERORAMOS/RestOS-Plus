create table if not exists public.table_order_sessions (
  table_id uuid primary key references public.dining_tables(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  claimed_by uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists table_order_sessions_location_seen_idx
  on public.table_order_sessions(location_id, last_seen_at desc);

alter table public.table_order_sessions enable row level security;

revoke all on table public.table_order_sessions from anon;
revoke insert, update, delete on table public.table_order_sessions from authenticated;
grant select on table public.table_order_sessions to authenticated;

drop policy if exists table_order_sessions_read_location on public.table_order_sessions;
create policy table_order_sessions_read_location
on public.table_order_sessions
for select
to authenticated
using (private.can_read_operational_location(location_id));

create or replace function private.load_table_order_sessions(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_sessions jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view table sessions';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table_id', s.table_id,
        'claimed_at', s.claimed_at,
        'last_seen_at', s.last_seen_at,
        'claimed_by_me', s.claimed_by = v_user
      )
      order by s.claimed_at
    ),
    '[]'::jsonb
  )
  into v_sessions
  from public.table_order_sessions s
  where s.restaurant_id = p_restaurant_id
    and s.location_id = p_location_id
    and s.last_seen_at >= now() - interval '5 minutes';

  return v_sessions;
end;
$function$;

create or replace function private.claim_table_order_session(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_table_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_session public.table_order_sessions%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id, 'orders.create') then
    raise exception 'Not allowed to create orders';
  end if;

  perform 1
  from public.dining_tables t
  join public.locations l on l.id = t.location_id
  where t.id = p_table_id
    and t.location_id = p_location_id
    and t.active = true
    and l.restaurant_id = p_restaurant_id
    and l.active = true
  for update of t;

  if not found then
    raise exception 'Invalid table';
  end if;

  if exists (
    select 1
    from public.order_table_links otl
    join public.orders o on o.id = otl.order_id
    where otl.table_id = p_table_id
      and otl.unlinked_at is null
      and o.restaurant_id = p_restaurant_id
      and o.location_id = p_location_id
      and o.status in ('draft', 'open', 'awaiting_payment')
  ) then
    delete from public.table_order_sessions
    where table_id = p_table_id;

    return jsonb_build_object(
      'ok', false,
      'status', 'occupied',
      'table_id', p_table_id
    );
  end if;

  delete from public.table_order_sessions
  where table_id = p_table_id
    and last_seen_at < now() - interval '5 minutes';

  select *
  into v_session
  from public.table_order_sessions
  where table_id = p_table_id
  for update;

  if found then
    if v_session.claimed_by <> v_user then
      return jsonb_build_object(
        'ok', false,
        'status', 'claimed_by_other',
        'table_id', p_table_id,
        'claimed_at', v_session.claimed_at
      );
    end if;

    update public.table_order_sessions
    set last_seen_at = now()
    where table_id = p_table_id
    returning * into v_session;

    return jsonb_build_object(
      'ok', true,
      'status', 'claimed',
      'table_id', v_session.table_id,
      'claimed_at', v_session.claimed_at,
      'last_seen_at', v_session.last_seen_at,
      'claimed_by_me', true
    );
  end if;

  insert into public.table_order_sessions(
    table_id,
    restaurant_id,
    location_id,
    claimed_by
  )
  values(
    p_table_id,
    p_restaurant_id,
    p_location_id,
    v_user
  )
  returning * into v_session;

  return jsonb_build_object(
    'ok', true,
    'status', 'claimed',
    'table_id', v_session.table_id,
    'claimed_at', v_session.claimed_at,
    'last_seen_at', v_session.last_seen_at,
    'claimed_by_me', true
  );
end;
$function$;

create or replace function private.touch_table_order_session(p_table_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  update public.table_order_sessions
  set last_seen_at = now()
  where table_id = p_table_id
    and claimed_by = v_user;

  return found;
end;
$function$;

create or replace function private.release_table_order_session(p_table_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  delete from public.table_order_sessions
  where table_id = p_table_id
    and claimed_by = v_user;

  return found;
end;
$function$;

create or replace function private.enforce_table_order_session_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_claimed_by uuid;
begin
  perform 1
  from public.dining_tables t
  where t.id = new.table_id
  for update;

  delete from public.table_order_sessions
  where table_id = new.table_id
    and last_seen_at < now() - interval '5 minutes';

  select claimed_by
  into v_claimed_by
  from public.table_order_sessions
  where table_id = new.table_id
  for update;

  if found then
    if v_user is null or v_claimed_by <> v_user then
      raise exception 'Table is being opened by another user';
    end if;

    delete from public.table_order_sessions
    where table_id = new.table_id
      and claimed_by = v_user;
  end if;

  return new;
end;
$function$;

drop trigger if exists order_table_links_enforce_order_session on public.order_table_links;
create trigger order_table_links_enforce_order_session
before insert on public.order_table_links
for each row
execute function private.enforce_table_order_session_on_link();

create or replace function public.load_table_order_sessions(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select private.load_table_order_sessions(p_restaurant_id, p_location_id);
$function$;

create or replace function public.claim_table_order_session(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_table_id uuid
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.claim_table_order_session(p_restaurant_id, p_location_id, p_table_id);
$function$;

create or replace function public.touch_table_order_session(p_table_id uuid)
returns boolean
language sql
set search_path = ''
as $function$
  select private.touch_table_order_session(p_table_id);
$function$;

create or replace function public.release_table_order_session(p_table_id uuid)
returns boolean
language sql
set search_path = ''
as $function$
  select private.release_table_order_session(p_table_id);
$function$;

revoke all on function public.load_table_order_sessions(uuid, uuid) from public, anon;
revoke all on function public.claim_table_order_session(uuid, uuid, uuid) from public, anon;
revoke all on function public.touch_table_order_session(uuid) from public, anon;
revoke all on function public.release_table_order_session(uuid) from public, anon;

grant execute on function public.load_table_order_sessions(uuid, uuid) to authenticated;
grant execute on function public.claim_table_order_session(uuid, uuid, uuid) to authenticated;
grant execute on function public.touch_table_order_session(uuid) to authenticated;
grant execute on function public.release_table_order_session(uuid) to authenticated;

revoke all on function private.load_table_order_sessions(uuid, uuid) from public;
revoke all on function private.claim_table_order_session(uuid, uuid, uuid) from public;
revoke all on function private.touch_table_order_session(uuid) from public;
revoke all on function private.release_table_order_session(uuid) from public;
revoke all on function private.enforce_table_order_session_on_link() from public;

do $block$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'table_order_sessions'
  ) then
    alter publication supabase_realtime add table public.table_order_sessions;
  end if;
end
$block$;
