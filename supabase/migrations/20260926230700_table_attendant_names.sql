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

  with attendants as (
    select
      s.table_id,
      s.claimed_at,
      s.last_seen_at,
      s.claimed_by = v_user as claimed_by_me,
      coalesce(
        nullif(btrim(p.full_name), ''),
        nullif(btrim(p.username::text), ''),
        nullif(split_part(p.email::text, '@', 1), ''),
        'Usuario'
      ) as attendant_name,
      'draft'::text as session_type
    from public.table_order_sessions s
    left join public.profiles p on p.id = s.claimed_by
    where s.restaurant_id = p_restaurant_id
      and s.location_id = p_location_id
      and s.last_seen_at >= now() - interval '5 minutes'

    union all

    select
      otl.table_id,
      o.opened_at as claimed_at,
      null::timestamptz as last_seen_at,
      o.opened_by = v_user as claimed_by_me,
      coalesce(
        nullif(btrim(p.full_name), ''),
        nullif(btrim(p.username::text), ''),
        nullif(split_part(p.email::text, '@', 1), ''),
        'Usuario'
      ) as attendant_name,
      'order'::text as session_type
    from public.order_table_links otl
    join public.orders o on o.id = otl.order_id
    left join public.profiles p on p.id = o.opened_by
    where otl.unlinked_at is null
      and o.restaurant_id = p_restaurant_id
      and o.location_id = p_location_id
      and o.status in ('draft', 'open', 'awaiting_payment')
      and not exists (
        select 1
        from public.table_order_sessions s
        where s.table_id = otl.table_id
          and s.last_seen_at >= now() - interval '5 minutes'
      )
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table_id', a.table_id,
        'claimed_at', a.claimed_at,
        'last_seen_at', a.last_seen_at,
        'claimed_by_me', a.claimed_by_me,
        'attendant_name', a.attendant_name,
        'session_type', a.session_type
      )
      order by a.claimed_at nulls last, a.table_id
    ),
    '[]'::jsonb
  )
  into v_sessions
  from attendants a;

  return v_sessions;
end;
$function$;
