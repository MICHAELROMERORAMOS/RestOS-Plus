-- Keep the always-on operational payload small, and fetch completed orders only
-- when a history window explicitly requests them.

create or replace function private.load_operational_state(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order_ids uuid[];
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
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
    array_agg(o.id order by o.opened_at, o.order_number),
    array[]::uuid[]
  )
  into v_order_ids
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and o.location_id = p_location_id
    and (
      o.refund_due > 0.005
      or (
        o.status <> 'cancelled'
        and (
          o.status <> 'closed'
          or o.paid_total + 0.005 < o.total
          or exists (
            select 1
            from public.order_items oi
            where oi.order_id = o.id
              and oi.status not in ('served', 'cancelled')
          )
        )
      )
    );

  return private.load_operational_orders_by_ids(
    p_restaurant_id,
    p_location_id,
    v_order_ids
  );
end;
$$;

create or replace function private.load_operational_history(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_service_mode text default null,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode text := case
    when p_service_mode = 'quick' then 'counter'
    else nullif(btrim(coalesce(p_service_mode, '')), '')
  end;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_order_ids uuid[];
  v_selected_ids uuid[];
  v_has_more boolean := false;
  v_next_before timestamptz;
  v_payload jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
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

  if v_mode is not null
    and v_mode not in ('table', 'counter', 'takeaway', 'delivery', 'kiosk') then
    raise exception 'Invalid service mode';
  end if;

  select coalesce(
    array_agg(candidate.id order by candidate.sort_at desc, candidate.order_number desc),
    array[]::uuid[]
  )
  into v_order_ids
  from (
    select
      o.id,
      o.order_number,
      coalesce(o.closed_at, o.opened_at) as sort_at
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and o.location_id = p_location_id
      and (v_mode is null or o.service_mode = v_mode)
      and (p_before is null or coalesce(o.closed_at, o.opened_at) < p_before)
      and o.status = 'closed'
      and o.refund_due <= 0.005
      and o.paid_total + 0.005 >= o.total
      and exists (
        select 1
        from public.order_items oi
        where oi.order_id = o.id
          and oi.status <> 'cancelled'
      )
      and not exists (
        select 1
        from public.order_items oi
        where oi.order_id = o.id
          and oi.status not in ('served', 'cancelled')
      )
    order by sort_at desc, o.order_number desc
    limit v_limit + 1
  ) candidate;

  v_has_more := cardinality(v_order_ids) > v_limit;
  v_selected_ids := case
    when v_has_more then v_order_ids[1:v_limit]
    else v_order_ids
  end;

  select min(coalesce(o.closed_at, o.opened_at))
  into v_next_before
  from public.orders o
  where o.id = any(coalesce(v_selected_ids, array[]::uuid[]));

  v_payload := private.load_operational_orders_by_ids(
    p_restaurant_id,
    p_location_id,
    coalesce(v_selected_ids, array[]::uuid[])
  );

  return v_payload || jsonb_build_object(
    'has_more', v_has_more,
    'next_before', case when v_has_more then v_next_before else null end
  );
end;
$$;

create or replace function public.load_operational_history(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_service_mode text default null,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.load_operational_history(
    p_restaurant_id,
    p_location_id,
    p_service_mode,
    p_before,
    p_limit
  );
$$;

revoke all on function public.load_operational_history(uuid, uuid, text, timestamptz, integer) from public;
grant execute on function public.load_operational_history(uuid, uuid, text, timestamptz, integer) to authenticated;

create or replace function private.load_operational_summary(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_sales_today numeric := 0;
  v_completed_today integer := 0;
  v_table_releases jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;

  select coalesce(nullif(btrim(r.timezone), ''), 'America/Bogota')
  into v_timezone
  from public.locations l
  join public.restaurants r on r.id = l.restaurant_id
  where l.id = p_location_id
    and l.restaurant_id = p_restaurant_id
    and l.active = true;

  if v_timezone is null then
    raise exception 'Invalid restaurant/location';
  end if;

  v_day_start := date_trunc('day', now() at time zone v_timezone) at time zone v_timezone;
  v_day_end := (date_trunc('day', now() at time zone v_timezone) + interval '1 day') at time zone v_timezone;

  select coalesce(sum(p.amount), 0)
  into v_sales_today
  from public.payments p
  where p.restaurant_id = p_restaurant_id
    and p.location_id = p_location_id
    and p.status = 'completed'
    and p.paid_at >= v_day_start
    and p.paid_at < v_day_end;

  select count(*)::integer
  into v_completed_today
  from public.orders o
  where o.restaurant_id = p_restaurant_id
    and o.location_id = p_location_id
    and o.status = 'closed'
    and o.closed_at >= v_day_start
    and o.closed_at < v_day_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table_id', released.table_id,
        'released_at', released.released_at
      )
      order by released.table_id
    ),
    '[]'::jsonb
  )
  into v_table_releases
  from (
    select
      otl.table_id,
      max(coalesce(otl.unlinked_at, o.closed_at)) as released_at
    from public.order_table_links otl
    join public.orders o on o.id = otl.order_id
    where o.restaurant_id = p_restaurant_id
      and o.location_id = p_location_id
      and (otl.unlinked_at is not null or o.closed_at is not null)
    group by otl.table_id
  ) released;

  return jsonb_build_object(
    'sales_today', v_sales_today,
    'completed_orders_today', v_completed_today,
    'table_releases', v_table_releases
  );
end;
$$;

create or replace function public.load_operational_summary(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.load_operational_summary(p_restaurant_id, p_location_id);
$$;

revoke all on function public.load_operational_summary(uuid, uuid) from public;
grant execute on function public.load_operational_summary(uuid, uuid) to authenticated;

-- One request can now fetch cancellation requests for all unpaid orders shown
-- by Cashier. This replaces the former one-RPC-per-order fan-out.
create or replace function private.list_my_kitchen_void_requests_batch(
  p_restaurant_id uuid,
  p_order_refs text[]
)
returns table(
  id uuid,
  order_ref text,
  items jsonb,
  reason text,
  status text,
  review_note text,
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_user
      and m.restaurant_id = p_restaurant_id
      and m.status = 'active'
  ) then
    raise exception 'Not a member of this restaurant';
  end if;

  if coalesce(cardinality(p_order_refs), 0) = 0 then
    return;
  end if;

  return query
  select
    r.id,
    r.order_ref,
    r.items,
    r.reason,
    r.status,
    r.review_note,
    r.reviewed_at,
    r.applied_at,
    r.created_at
  from public.kitchen_void_requests r
  where r.restaurant_id = p_restaurant_id
    and r.requested_by = v_user
    and r.order_ref = any(p_order_refs)
    and r.created_at > now() - interval '24 hours'
  order by r.created_at desc;
end;
$$;

create or replace function public.list_my_kitchen_void_requests_batch(
  p_restaurant_id uuid,
  p_order_refs text[]
)
returns table(
  id uuid,
  order_ref text,
  items jsonb,
  reason text,
  status text,
  review_note text,
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select *
  from private.list_my_kitchen_void_requests_batch(
    p_restaurant_id,
    p_order_refs
  );
$$;

revoke all on function public.list_my_kitchen_void_requests_batch(uuid, text[]) from public;
grant execute on function public.list_my_kitchen_void_requests_batch(uuid, text[]) to authenticated;

-- Realtime clients need SELECT visibility. Requesters only see their own rows;
-- reviewers see rows belonging to restaurants where their active role has the
-- review permission. No client-side INSERT/UPDATE/DELETE grant is added.
grant select on table public.kitchen_void_requests to authenticated;

drop policy if exists "Members receive relevant kitchen void changes"
  on public.kitchen_void_requests;

create policy "Members receive relevant kitchen void changes"
on public.kitchen_void_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.restaurant_id = kitchen_void_requests.restaurant_id
      and m.status = 'active'
      and (
        kitchen_void_requests.requested_by = (select auth.uid())
        or exists (
          select 1
          from public.role_permissions rp
          where rp.role_id = m.role_id
            and rp.permission_code = 'orders.void.review_unpaid'
        )
      )
  )
);

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'kitchen_void_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.kitchen_void_requests';
  end if;
end;
$$;
