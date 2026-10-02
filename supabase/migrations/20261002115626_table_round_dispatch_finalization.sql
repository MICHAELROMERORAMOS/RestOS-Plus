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
  set status='served'
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
