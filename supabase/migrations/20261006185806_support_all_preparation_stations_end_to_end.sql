create or replace function private.advance_station_round(
  p_order_id uuid,
  p_round_id uuid,
  p_station_type text
)
returns text
language plpgsql
security definer
set search_path=''
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

  select location_id into v_location
  from public.orders
  where id=p_order_id
  for update;

  if v_location is null then raise exception 'Order not found'; end if;

  if not exists (
    select 1
    from public.kitchen_stations s
    where s.location_id=v_location
      and s.station_type=p_station_type
      and s.active=true
  ) then
    raise exception 'Invalid or inactive preparation station';
  end if;

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

create or replace function private.mark_station_round_served(
  p_order_id uuid,
  p_round_id uuid,
  p_station_type text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_service_mode text;
  v_payment_status text;
  v_permission text;
  v_units numeric := 0;
  v_lines integer := 0;
  v_remaining boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select o.location_id, o.service_mode, o.payment_status
  into v_location, v_service_mode, v_payment_status
  from public.orders o
  where o.id=p_order_id
  for update;

  if v_location is null then raise exception 'Order not found'; end if;

  if not exists (
    select 1
    from public.kitchen_stations s
    where s.location_id=v_location
      and s.station_type=p_station_type
      and s.active=true
  ) then
    raise exception 'Invalid or inactive preparation station';
  end if;

  if v_service_mode<>'table' then
    raise exception 'Full station dispatch is only available for table orders';
  end if;

  v_permission := case when p_station_type='bar' then 'bar.update' else 'kitchen.update' end;
  if not private.user_has_location_permission(v_location,v_permission) then
    raise exception 'Not allowed to dispatch this station';
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
    raise exception 'Start preparation before dispatching the full ticket';
  end if;

  select coalesce(sum(greatest(oi.quantity-coalesce(oi.served_quantity,0),0)),0)
  into v_units
  from public.order_items oi
  join public.kitchen_stations s on s.id=oi.station_id
  where oi.order_id=p_order_id
    and oi.round_id=p_round_id
    and s.station_type=p_station_type
    and oi.status in ('preparing','ready');

  update public.order_items oi
  set status='served',
      served_quantity=oi.quantity,
      updated_at=now()
  from public.kitchen_stations s
  where oi.station_id=s.id
    and oi.order_id=p_order_id
    and oi.round_id=p_round_id
    and s.station_type=p_station_type
    and oi.status in ('preparing','ready');

  get diagnostics v_lines = row_count;

  if v_lines=0 then
    raise exception 'No prepared items are pending dispatch for this ticket';
  end if;

  select exists (
    select 1
    from public.order_items
    where order_id=p_order_id
      and status not in ('served','cancelled')
  ) into v_remaining;

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

  return jsonb_build_object(
    'orderId',p_order_id,
    'roundId',p_round_id,
    'station',p_station_type,
    'dispatchedLines',v_lines,
    'dispatchedUnits',v_units,
    'orderHasPendingItems',v_remaining
  );
end;
$function$;
