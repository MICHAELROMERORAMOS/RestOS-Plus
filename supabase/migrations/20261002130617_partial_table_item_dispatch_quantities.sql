alter table public.order_items
  add column if not exists served_quantity numeric(12,3) not null default 0;

update public.order_items
set served_quantity=quantity
where status='served'
  and served_quantity<>quantity;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='public.order_items'::regclass
      and conname='order_items_served_quantity_check'
  ) then
    alter table public.order_items
      add constraint order_items_served_quantity_check
      check (served_quantity >= 0 and served_quantity <= quantity);
  end if;
end;
$migration$;

do $migration$
declare
  v_oid oid;
  v_definition text;
  v_old text := '''quantity'',oi.quantity,' || chr(10) || '                ''unit_price''';
  v_new text := '''quantity'',oi.quantity,''served_quantity'',oi.served_quantity,' || chr(10) || '                ''unit_price''';
begin
  select p.oid
  into v_oid
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private'
    and p.proname='load_operational_orders_by_ids'
    and pg_get_function_identity_arguments(p.oid)='p_restaurant_id uuid, p_location_id uuid, p_order_ids uuid[]'
  limit 1;

  if v_oid is null then
    raise exception 'private.load_operational_orders_by_ids(uuid,uuid,uuid[]) not found';
  end if;

  v_definition := pg_get_functiondef(v_oid);

  if position(v_old in v_definition)=0 then
    raise exception 'Expected order item quantity serialization was not found';
  end if;

  v_definition := replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$migration$;

create or replace function private.mark_order_item_served_quantity(
  p_order_id uuid,
  p_item_id uuid,
  p_quantity numeric
)
returns jsonb
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
  v_item_quantity numeric;
  v_served_quantity numeric;
  v_remaining_quantity numeric;
  v_next_served numeric;
  v_remaining_order boolean;
  v_payment_status text;
  v_next_status text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Dispatch quantity must be greater than zero'; end if;

  select
    o.location_id,
    o.service_mode,
    oi.status,
    oi.quantity,
    oi.served_quantity,
    s.station_type
  into
    v_location,
    v_service_mode,
    v_item_status,
    v_item_quantity,
    v_served_quantity,
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

  if v_item_status not in ('preparing','ready') then
    raise exception 'Only items in preparation or ready can be dispatched';
  end if;

  v_remaining_quantity := greatest(v_item_quantity-coalesce(v_served_quantity,0),0);

  if v_remaining_quantity<=0 then
    raise exception 'This item has already been fully dispatched';
  end if;

  if p_quantity>v_remaining_quantity then
    raise exception 'Dispatch quantity exceeds pending quantity';
  end if;

  v_next_served := least(v_item_quantity,coalesce(v_served_quantity,0)+p_quantity);
  v_next_status := case
    when v_next_served>=v_item_quantity then 'served'
    else v_item_status
  end;

  update public.order_items
  set served_quantity=v_next_served,
      status=v_next_status,
      updated_at=now()
  where id=p_item_id
    and order_id=p_order_id;

  select exists (
    select 1
    from public.order_items
    where order_id=p_order_id
      and status not in ('served','cancelled')
  ) into v_remaining_order;

  select payment_status
  into v_payment_status
  from public.orders
  where id=p_order_id;

  if not v_remaining_order then
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
    'itemId',p_item_id,
    'dispatchedQuantity',p_quantity,
    'servedQuantity',v_next_served,
    'remainingQuantity',greatest(v_item_quantity-v_next_served,0),
    'status',v_next_status
  );
end;
$function$;

create or replace function public.mark_order_item_served_quantity(
  p_order_id uuid,
  p_item_id uuid,
  p_quantity numeric
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.mark_order_item_served_quantity(p_order_id,p_item_id,p_quantity);
$function$;

revoke all on function private.mark_order_item_served_quantity(uuid,uuid,numeric) from public, anon;
grant execute on function private.mark_order_item_served_quantity(uuid,uuid,numeric) to authenticated;
revoke all on function public.mark_order_item_served_quantity(uuid,uuid,numeric) from public, anon;
grant execute on function public.mark_order_item_served_quantity(uuid,uuid,numeric) to authenticated;

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
  set status='served',
      served_quantity=quantity,
      updated_at=now()
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

create or replace function private.mark_round_served(
  p_order_id uuid,
  p_round_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_service_mode text;
  v_payment_status text;
  v_remaining boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select location_id, service_mode, payment_status
  into v_location, v_service_mode, v_payment_status
  from public.orders
  where id=p_order_id
  for update;

  if v_location is null then raise exception 'Order not found'; end if;

  if not (
    private.user_has_location_permission(v_location,'orders.update')
    or private.user_has_location_permission(v_location,'orders.create')
  ) then
    raise exception 'Not allowed to serve this order';
  end if;

  update public.order_items
  set status='served',
      served_quantity=quantity,
      updated_at=now()
  where order_id=p_order_id
    and round_id=p_round_id
    and status='ready';

  if v_service_mode<>'table' then
    return;
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
end;
$function$;
