create or replace function private.create_quick_order(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id, 'orders.create') then
    raise exception 'Not allowed to create orders';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then raise exception 'Invalid restaurant/location'; end if;

  insert into public.orders(
    restaurant_id,location_id,service_mode,payment_timing,status,payment_status,opened_by
  )
  values(p_restaurant_id,p_location_id,'counter','postpaid','draft','unpaid',v_user)
  returning * into v_order;

  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number);
end;
$function$;

create or replace function public.create_quick_order(p_restaurant_id uuid,p_location_id uuid)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.create_quick_order(p_restaurant_id,p_location_id);
$function$;

revoke all on function public.create_quick_order(uuid,uuid) from public, anon;
grant execute on function public.create_quick_order(uuid,uuid) to authenticated;
revoke all on function private.create_quick_order(uuid,uuid) from public, anon;
grant execute on function private.create_quick_order(uuid,uuid) to authenticated;

create or replace function private.update_quick_order_identity(
  p_order_id uuid,
  p_pager_number text,
  p_customer_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_pager text := nullif(btrim(coalesce(p_pager_number,'')),'');
  v_customer text := nullif(btrim(coalesce(p_customer_name,'')),'');
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_pager is not null and v_customer is not null then
    raise exception 'Use pager number or customer name, not both';
  end if;

  select * into v_order
  from public.orders
  where id=p_order_id
    and service_mode='counter'
    and status in ('draft','open','awaiting_payment')
  for update;

  if not found then raise exception 'Quick order not found'; end if;

  if v_order.opened_by<>v_user
     and not private.user_has_location_permission(v_order.location_id,'orders.update') then
    raise exception 'Not allowed to update this order';
  end if;

  update public.orders
  set pager_number=v_pager,
      customer_name=v_customer
  where id=p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'order_number',v_order.order_number,
    'pager_number',v_order.pager_number,
    'customer_name',v_order.customer_name
  );
end;
$function$;

create or replace function public.update_quick_order_identity(
  p_order_id uuid,
  p_pager_number text,
  p_customer_name text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.update_quick_order_identity(p_order_id,p_pager_number,p_customer_name);
$function$;

revoke all on function public.update_quick_order_identity(uuid,text,text) from public, anon;
grant execute on function public.update_quick_order_identity(uuid,text,text) to authenticated;
revoke all on function private.update_quick_order_identity(uuid,text,text) from public, anon;
grant execute on function private.update_quick_order_identity(uuid,text,text) to authenticated;

create or replace function private.release_empty_quick_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_order
  from public.orders
  where id=p_order_id
    and service_mode='counter'
    and status in ('draft','open','awaiting_payment')
  for update;

  if not found then return false; end if;

  if exists (
    select 1 from public.order_items oi
    where oi.order_id=p_order_id and oi.status<>'cancelled'
  ) then
    raise exception 'Quick order already has sent products';
  end if;

  if v_order.opened_by<>v_user
     and not private.user_has_location_permission(v_order.location_id,'tables.manage') then
    raise exception 'Not allowed to release this quick order';
  end if;

  update public.orders
  set status='cancelled',
      closed_at=coalesce(closed_at,now()),
      closed_by=coalesce(closed_by,v_user)
  where id=p_order_id;

  return found;
end;
$function$;

create or replace function public.release_empty_quick_order(p_order_id uuid)
returns boolean
language sql
set search_path = ''
as $function$
  select private.release_empty_quick_order(p_order_id);
$function$;

revoke all on function public.release_empty_quick_order(uuid) from public, anon;
grant execute on function public.release_empty_quick_order(uuid) to authenticated;
revoke all on function private.release_empty_quick_order(uuid) from public, anon;
grant execute on function private.release_empty_quick_order(uuid) to authenticated;
