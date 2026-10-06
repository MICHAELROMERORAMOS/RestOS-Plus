alter table public.restaurant_settings
  add column if not exists allow_individual_item_ready boolean not null default true;

create or replace function private.mark_order_item_ready(
  p_order_id uuid,
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_restaurant uuid;
  v_service_mode text;
  v_payment_status text;
  v_item_status text;
  v_station_type text;
  v_permission text;
  v_allow_individual boolean;
  v_pending boolean;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  select
    o.location_id,
    l.restaurant_id,
    o.service_mode,
    o.payment_status,
    oi.status,
    s.station_type,
    coalesce(rs.allow_individual_item_ready,true)
  into
    v_location,
    v_restaurant,
    v_service_mode,
    v_payment_status,
    v_item_status,
    v_station_type,
    v_allow_individual
  from public.order_items oi
  join public.orders o on o.id=oi.order_id
  join public.locations l on l.id=o.location_id
  join public.kitchen_stations s on s.id=oi.station_id
  left join public.restaurant_settings rs on rs.restaurant_id=l.restaurant_id
  where oi.id=p_item_id
    and oi.order_id=p_order_id
  for update of oi,o;

  if v_location is null then raise exception 'Order item not found'; end if;
  if not v_allow_individual then raise exception 'Individual item readiness is disabled'; end if;

  v_permission := case when v_station_type='bar' then 'bar.update' else 'kitchen.update' end;
  if not private.user_has_location_permission(v_location,v_permission) then
    raise exception 'Not allowed to update this station';
  end if;

  if v_item_status='ready' then
    return jsonb_build_object('ok',true,'itemId',p_item_id,'status','ready','alreadyReady',true);
  end if;

  if v_item_status<>'preparing' then
    raise exception 'Only items in preparation can be marked ready';
  end if;

  update public.order_items
  set status='ready',updated_at=now()
  where id=p_item_id and order_id=p_order_id and status='preparing';

  select exists (
    select 1 from public.order_items
    where order_id=p_order_id and status in ('sent','preparing')
  ) into v_pending;

  if not v_pending then
    if v_service_mode='table' then
      if v_payment_status='paid' then
        update public.orders
        set status='open',closed_at=null,closed_by=null
        where id=p_order_id and status<>'cancelled';
      else
        update public.orders
        set status='awaiting_payment'
        where id=p_order_id and status<>'cancelled';
      end if;
    elsif v_payment_status='paid' then
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user)
      where id=p_order_id and status<>'cancelled';

      perform private.release_order_tables(p_order_id);
    else
      update public.orders
      set status='awaiting_payment'
      where id=p_order_id and status<>'cancelled';
    end if;

    if v_service_mode='delivery' then
      update public.orders set delivery_status='ready' where id=p_order_id;
    end if;
  elsif v_service_mode='delivery' then
    update public.orders set delivery_status='preparing' where id=p_order_id;
  end if;

  return jsonb_build_object(
    'ok',true,
    'itemId',p_item_id,
    'status','ready',
    'orderHasPendingPreparation',v_pending
  );
end;
$function$;

create or replace function public.mark_order_item_ready(
  p_order_id uuid,
  p_item_id uuid
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.mark_order_item_ready(p_order_id,p_item_id);
$function$;

revoke all on function private.mark_order_item_ready(uuid,uuid) from public,anon;
revoke all on function public.mark_order_item_ready(uuid,uuid) from public,anon;
grant execute on function private.mark_order_item_ready(uuid,uuid) to authenticated;
grant execute on function public.mark_order_item_ready(uuid,uuid) to authenticated;
