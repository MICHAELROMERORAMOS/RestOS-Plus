create or replace function private.advance_station_round(
  p_order_id uuid,
  p_round_id uuid,
  p_station_type text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_permission text;
  v_next text;
  v_pending boolean;
  v_payment_status text;
  v_service_mode text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_station_type not in ('kitchen','bar') then raise exception 'Invalid station'; end if;

  select location_id into v_location
  from public.orders
  where id=p_order_id
  for update;

  if v_location is null then raise exception 'Order not found'; end if;

  v_permission := case when p_station_type='bar' then 'bar.update' else 'kitchen.update' end;
  if not private.user_has_location_permission(v_location,v_permission) then
    raise exception 'Not allowed to update this station';
  end if;

  if exists (
    select 1
    from public.order_items oi
    join public.kitchen_stations s on s.id=oi.station_id
    where oi.order_id=p_order_id
      and oi.round_id=p_round_id
      and s.station_type=p_station_type
      and oi.status='sent'
  ) then
    v_next := 'preparing';

    update public.order_items oi
    set status='preparing'
    from public.kitchen_stations s
    where oi.station_id=s.id
      and oi.order_id=p_order_id
      and oi.round_id=p_round_id
      and s.station_type=p_station_type
      and oi.status='sent';

  elsif exists (
    select 1
    from public.order_items oi
    join public.kitchen_stations s on s.id=oi.station_id
    where oi.order_id=p_order_id
      and oi.round_id=p_round_id
      and s.station_type=p_station_type
      and oi.status='preparing'
  ) then
    v_next := 'ready';

    update public.order_items oi
    set status='ready'
    from public.kitchen_stations s
    where oi.station_id=s.id
      and oi.order_id=p_order_id
      and oi.round_id=p_round_id
      and s.station_type=p_station_type
      and oi.status='preparing';
  else
    return 'ready';
  end if;

  select exists (
    select 1
    from public.order_items
    where order_id=p_order_id
      and status in ('sent','preparing')
  ) into v_pending;

  select payment_status, service_mode
  into v_payment_status, v_service_mode
  from public.orders
  where id=p_order_id;

  if not v_pending then
    if v_service_mode='table' then
      -- Table orders remain active until every ready line has been dispatched/served.
      if v_payment_status='paid' then
        update public.orders
        set status='open',
            closed_at=null,
            closed_by=null
        where id=p_order_id
          and status<>'cancelled';
      else
        update public.orders
        set status='awaiting_payment'
        where id=p_order_id
          and status<>'cancelled';
      end if;
    elsif v_payment_status='paid' then
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user)
      where id=p_order_id;

      perform private.release_order_tables(p_order_id);
    else
      update public.orders
      set status='awaiting_payment'
      where id=p_order_id
        and status<>'cancelled';
    end if;

    if exists (
      select 1 from public.orders
      where id=p_order_id and service_mode='delivery'
    ) then
      update public.orders
      set delivery_status='ready'
      where id=p_order_id;
    end if;
  elsif exists (
    select 1 from public.orders
    where id=p_order_id and service_mode='delivery'
  ) then
    update public.orders
    set delivery_status='preparing'
    where id=p_order_id;
  end if;

  return v_next;
end;
$function$;

create or replace function private.mark_order_item_served(
  p_order_id uuid,
  p_item_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_service_mode text;
  v_item_status text;
  v_station_type text;
  v_permission text;
  v_remaining boolean;
  v_payment_status text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select
    o.location_id,
    o.service_mode,
    oi.status,
    s.station_type
  into
    v_location,
    v_service_mode,
    v_item_status,
    v_station_type
  from public.order_items oi
  join public.orders o on o.id=oi.order_id
  join public.kitchen_stations s on s.id=oi.station_id
  where oi.id=p_item_id
    and oi.order_id=p_order_id
  for update of oi, o;

  if v_location is null then raise exception 'Order item not found'; end if;
  if v_service_mode<>'table' then raise exception 'Item dispatch is only available for table orders'; end if;

  v_permission := case when v_station_type='bar' then 'bar.update' else 'kitchen.update' end;
  if not private.user_has_location_permission(v_location,v_permission) then
    raise exception 'Not allowed to dispatch this item';
  end if;

  if v_item_status='served' then
    return 'served';
  end if;

  if v_item_status<>'ready' then
    raise exception 'Only ready items can be dispatched';
  end if;

  update public.order_items
  set status='served'
  where id=p_item_id
    and order_id=p_order_id
    and status='ready';

  select exists (
    select 1
    from public.order_items
    where order_id=p_order_id
      and status not in ('served','cancelled')
  ) into v_remaining;

  select payment_status into v_payment_status
  from public.orders
  where id=p_order_id;

  if not v_remaining then
    if v_payment_status='paid' then
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user)
      where id=p_order_id
        and status<>'cancelled';

      perform private.release_order_tables(p_order_id);
    else
      update public.orders
      set status='awaiting_payment'
      where id=p_order_id
        and status<>'cancelled';
    end if;
  end if;

  return 'served';
end;
$function$;

create or replace function public.mark_order_item_served(
  p_order_id uuid,
  p_item_id uuid
)
returns text
language sql
set search_path = ''
as $function$
  select private.mark_order_item_served(p_order_id,p_item_id);
$function$;

revoke all on function private.mark_order_item_served(uuid,uuid) from public, anon;
grant execute on function private.mark_order_item_served(uuid,uuid) to authenticated;
revoke all on function public.mark_order_item_served(uuid,uuid) from public, anon;
grant execute on function public.mark_order_item_served(uuid,uuid) to authenticated;

do $migration$
declare
  v_oid oid;
  v_definition text;
  v_old text := 'if v_order.payment_status=''paid'' and not v_pending then';
  v_new text := 'if v_order.payment_status=''paid'' and not v_pending and (v_order.service_mode<>''table'' or not exists (select 1 from public.order_items where order_id=v_order.id and status not in (''served'',''cancelled''))) then';
begin
  select p.oid
  into v_oid
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private'
    and p.proname='record_order_payments'
    and pg_get_function_identity_arguments(p.oid)='p_allocations jsonb, p_method text'
  limit 1;

  if v_oid is null then
    raise exception 'private.record_order_payments(jsonb,text) not found';
  end if;

  v_definition := pg_get_functiondef(v_oid);

  if position(v_old in v_definition)=0 then
    raise exception 'Expected payment finalization clause not found';
  end if;

  v_definition := replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$migration$;
