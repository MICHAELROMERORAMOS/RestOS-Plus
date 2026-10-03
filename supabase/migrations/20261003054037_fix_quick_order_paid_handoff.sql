create or replace function private.record_order_payments(
  p_allocations jsonb,
  p_method text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_allocation jsonb;
  v_item_alloc jsonb;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_requested numeric(14,2);
  v_balance numeric(14,2);
  v_applied numeric(14,2);
  v_total_applied numeric(14,2) := 0;
  v_item public.order_items%rowtype;
  v_qty numeric(12,3);
  v_item_amount numeric(14,2);
  v_pending boolean;
  v_unserved boolean;
  v_invoice jsonb;
  v_invoices jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  if p_method not in ('cash','card','transfer','nequi','bank','voucher','other') then
    raise exception 'Invalid payment method';
  end if;

  if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 then
    raise exception 'No payment allocations';
  end if;

  for v_allocation in
    select value from jsonb_array_elements(p_allocations)
  loop
    select * into v_order
    from public.orders
    where id=(v_allocation->>'orderId')::uuid
      and status in ('draft','open','awaiting_payment')
    for update;

    if not found then continue; end if;

    if not private.user_has_location_permission(v_order.location_id,'payments.create') then
      raise exception 'Not allowed to register payment';
    end if;

    perform private.recalculate_order_financials(v_order.id);
    select * into v_order from public.orders where id=v_order.id;

    v_requested := coalesce((v_allocation->>'amount')::numeric,0);
    v_balance := greatest(0,v_order.total-v_order.paid_total);
    v_applied := least(v_requested,v_balance);

    if v_applied<=0.005 then continue; end if;

    insert into public.payments(
      restaurant_id,location_id,order_id,method,amount,status,received_by
    )
    values(
      v_order.restaurant_id,v_order.location_id,v_order.id,p_method,
      v_applied,'completed',v_user
    )
    returning * into v_payment;

    if jsonb_typeof(v_allocation->'itemAllocations')='array' then
      for v_item_alloc in
        select value from jsonb_array_elements(v_allocation->'itemAllocations')
      loop
        select * into v_item
        from public.order_items
        where id=(v_item_alloc->>'lineId')::uuid
          and status<>'cancelled';

        if not found then continue; end if;

        if v_item.order_id<>v_order.id then
          continue;
        end if;

        v_qty := greatest(0,coalesce((v_item_alloc->>'quantity')::numeric,0));
        v_item_amount := round((v_qty*v_item.unit_price)::numeric,2);

        if v_qty<=0 or v_item_amount<=0 then continue; end if;

        if v_item_amount>v_applied+0.01 then
          raise exception 'Item allocation exceeds payment amount';
        end if;

        insert into public.payment_allocations(
          payment_id,order_item_id,amount,quantity,unit_price,item_name
        )
        values(
          v_payment.id,v_item.id,v_item_amount,v_qty,v_item.unit_price,v_item.product_name
        )
        on conflict(payment_id,order_item_id)
        do update set
          amount=excluded.amount,
          quantity=excluded.quantity,
          unit_price=excluded.unit_price,
          item_name=excluded.item_name;
      end loop;
    end if;

    v_invoice := private.issue_payment_invoice(v_payment.id);
    v_invoices := v_invoices || jsonb_build_array(v_invoice);

    v_total_applied := v_total_applied+v_applied;

    perform private.recalculate_order_financials(v_order.id);

    select exists(
      select 1
      from public.order_items
      where order_id=v_order.id
        and status in ('sent','preparing')
    ) into v_pending;

    select exists(
      select 1
      from public.order_items
      where order_id=v_order.id
        and status not in ('served','cancelled')
    ) into v_unserved;

    select * into v_order from public.orders where id=v_order.id;

    if v_order.payment_status='paid'
       and not v_pending
       and (v_order.service_mode='delivery' or not v_unserved) then
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user)
      where id=v_order.id;
      perform private.release_order_tables(v_order.id);
    elsif v_order.payment_status<>'paid' and not v_pending then
      update public.orders set status='awaiting_payment' where id=v_order.id;
    else
      update public.orders set status='open' where id=v_order.id;
    end if;
  end loop;

  return jsonb_build_object(
    'applied',v_total_applied,
    'invoices',v_invoices
  );
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

  -- Delivery orders keep their existing lifecycle after kitchen handoff.
  if v_service_mode='delivery' then
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

      if v_service_mode='table' then
        perform private.release_order_tables(p_order_id);
      end if;
    else
      update public.orders
      set status='awaiting_payment'
      where id=p_order_id
        and status<>'cancelled';
    end if;
  end if;
end;
$function$;
