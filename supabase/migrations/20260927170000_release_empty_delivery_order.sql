create or replace function private.release_empty_delivery_order(p_order_id uuid)
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
    and service_mode='delivery'
    and status in ('draft','open','awaiting_payment')
  for update;

  if not found then return false; end if;

  if exists (
    select 1 from public.order_items oi
    where oi.order_id=p_order_id and oi.status<>'cancelled'
  ) then
    raise exception 'Delivery order already has sent products';
  end if;

  if v_order.opened_by<>v_user
     and not private.user_has_location_permission(v_order.location_id,'tables.manage') then
    raise exception 'Not allowed to release this delivery order';
  end if;

  update public.orders
  set status='cancelled',
      closed_at=coalesce(closed_at,now()),
      closed_by=coalesce(closed_by,v_user)
  where id=p_order_id;

  return found;
end;
$function$;

create or replace function public.release_empty_delivery_order(p_order_id uuid)
returns boolean
language sql
set search_path = ''
as $function$
  select private.release_empty_delivery_order(p_order_id);
$function$;

revoke all on function public.release_empty_delivery_order(uuid) from public, anon;
grant execute on function public.release_empty_delivery_order(uuid) to authenticated;
revoke all on function private.release_empty_delivery_order(uuid) from public, anon;
grant execute on function private.release_empty_delivery_order(uuid) to authenticated;
