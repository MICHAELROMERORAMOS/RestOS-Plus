create or replace function private.finalize_order_after_item_void(
  p_order_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_order public.orders%rowtype;
  v_active_item_count integer := 0;
  v_pending_service boolean := false;
  v_released boolean := false;
  v_final_status text;
begin
  perform private.recalculate_order_financials(p_order_id);

  select *
  into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  select
    count(*) filter (where oi.status<>'cancelled'),
    exists (
      select 1
      from public.order_items pending
      where pending.order_id=p_order_id
        and pending.status not in ('served','cancelled')
    )
  into v_active_item_count,v_pending_service
  from public.order_items oi
  where oi.order_id=p_order_id;

  if v_active_item_count=0 then
    update public.orders
    set status='cancelled',
        closed_at=coalesce(closed_at,now()),
        closed_by=coalesce(closed_by,p_actor,opened_by),
        delivery_status=case
          when service_mode='delivery' then 'cancelled'
          else delivery_status
        end
    where id=p_order_id;

    if v_order.service_mode='table' then
      perform private.release_order_tables(p_order_id);
      v_released := true;
    end if;

    v_final_status := 'cancelled';

  elsif not v_pending_service
        and coalesce(v_order.total,0)<=0.005
        and coalesce(v_order.paid_total,0)<=0.005 then
    update public.orders
    set status='closed',
        closed_at=coalesce(closed_at,now()),
        closed_by=coalesce(closed_by,p_actor,opened_by)
    where id=p_order_id
      and status<>'cancelled';

    if v_order.service_mode='table' then
      perform private.release_order_tables(p_order_id);
      v_released := true;
    end if;

    v_final_status := 'closed';

  elsif v_order.service_mode='table' then
    update public.orders
    set status=case
          when v_pending_service then 'open'
          else 'awaiting_payment'
        end,
        closed_at=null,
        closed_by=null
    where id=p_order_id
      and status<>'cancelled';

    v_final_status := case
      when v_pending_service then 'open'
      else 'awaiting_payment'
    end;
  else
    v_final_status := v_order.status;
  end if;

  return jsonb_build_object(
    'orderId',p_order_id,
    'status',v_final_status,
    'activeItemCount',v_active_item_count,
    'pendingService',v_pending_service,
    'tableReleased',v_released
  );
end;
$function$;

revoke all on function private.finalize_order_after_item_void(uuid,uuid)
from public,anon,authenticated;

create or replace function private.review_kitchen_void_request(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_req public.kitchen_void_requests%rowtype;
  v_order_id uuid;
  v_item jsonb;
  v_line_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;

  select * into v_req
  from public.kitchen_void_requests
  where id=p_request_id
  for update;

  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    where m.user_id=v_user
      and m.restaurant_id=v_req.restaurant_id
      and m.status='active'
      and rp.permission_code='orders.void.review_unpaid'
  ) then
    raise exception 'Only Kitchen or an authorized administrator can review this request';
  end if;

  if p_decision='rejected' then
    update public.kitchen_void_requests
    set status='rejected',
        reviewed_by=v_user,
        reviewed_at=now(),
        review_note=nullif(btrim(coalesce(p_note,'')),'')
    where id=p_request_id;

    return 'rejected';
  end if;

  select id into v_order_id
  from public.orders
  where restaurant_id=v_req.restaurant_id
    and (order_number::text=v_req.order_ref or id::text=v_req.order_ref)
  limit 1
  for update;

  if v_order_id is null then raise exception 'Order not found'; end if;

  perform private.recalculate_order_financials(v_order_id);

  if exists (
    select 1
    from public.orders
    where id=v_order_id
      and paid_total > 0.005
  ) then
    raise exception 'La cuenta ya tiene pagos. Cocina no puede aprobar esta anulación.';
  end if;

  for v_item in select value from jsonb_array_elements(v_req.items)
  loop
    begin
      v_line_id := (v_item->>'lineId')::uuid;
    exception when others then
      v_line_id := null;
    end;

    if v_line_id is null then continue; end if;

    update public.order_items
    set status='cancelled',
        cancel_reason=v_req.reason,
        cancelled_by=v_user,
        cancelled_at=now()
    where id=v_line_id
      and order_id=v_order_id
      and status<>'cancelled';

    if found then
      insert into public.item_void_audit(
        restaurant_id,actor_user_id,order_ref,line_ref,item_name,amount,
        reason,was_paid,invoice_issued,method
      )
      select
        v_req.restaurant_id,v_user,v_req.order_ref,oi.id::text,oi.product_name,
        oi.line_total,v_req.reason,false,false,'kitchen_approved'
      from public.order_items oi
      where oi.id=v_line_id;
    end if;
  end loop;

  perform private.finalize_order_after_item_void(v_order_id,v_user);

  update public.kitchen_void_requests
  set status='applied',
      reviewed_by=v_user,
      reviewed_at=now(),
      review_note=nullif(btrim(coalesce(p_note,'')),''),
      applied_at=now()
  where id=p_request_id;

  return 'applied';
end;
$function$;

do $repair$
declare
  v_order record;
begin
  for v_order in
    select o.id,coalesce(o.opened_by,o.closed_by) as actor_id
    from public.orders o
    where o.status in ('draft','open','awaiting_payment')
      and coalesce(o.paid_total,0)<=0.005
      and not exists (
        select 1
        from public.order_items oi
        where oi.order_id=o.id
          and oi.status<>'cancelled'
      )
  loop
    perform private.finalize_order_after_item_void(v_order.id,v_order.actor_id);
  end loop;
end;
$repair$;
