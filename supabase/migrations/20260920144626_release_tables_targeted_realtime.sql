-- Release finalized tables atomically and refresh only affected orders in Realtime.

CREATE OR REPLACE FUNCTION private.advance_station_round(p_order_id uuid, p_round_id uuid, p_station_type text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
  v_permission text;
  v_next text;
  v_pending boolean;
  v_payment_status text;
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

  select payment_status into v_payment_status
  from public.orders
  where id=p_order_id;

  if not v_pending then
    if v_payment_status='paid' then
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
$function$
;

CREATE OR REPLACE FUNCTION private.load_operational_orders_by_ids(p_restaurant_id uuid, p_location_id uuid, p_order_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payload jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then raise exception 'Invalid restaurant/location'; end if;

  select jsonb_build_object(
    'orders',
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id',o.id,'order_number',o.order_number,'restaurant_id',o.restaurant_id,
        'location_id',o.location_id,'customer_id',o.customer_id,
        'service_mode',o.service_mode,'payment_timing',o.payment_timing,
        'customer_name',o.customer_name,'pager_number',o.pager_number,
        'status',o.status,'payment_status',o.payment_status,
        'subtotal',o.subtotal,'tax_total',o.tax_total,'total',o.total,
        'paid_total',o.paid_total,'refund_due',o.refund_due,'notes',o.notes,
        'delivery_details',o.delivery_details,'delivery_status',o.delivery_status,
        'invoice_issued_at',o.invoice_issued_at,'invoice_number',o.invoice_number,
        'invoice_voided_at',o.invoice_voided_at,
        'fiscal_correction_required',o.fiscal_correction_required,
        'account_void_reason',o.account_void_reason,
        'account_voided_at',o.account_voided_at,
        'account_void_audit_id',o.account_void_audit_id,
        'account_void_scope',o.account_void_scope,
        'opened_at',o.opened_at,'closed_at',o.closed_at,
        'table_ids',coalesce((
          select jsonb_agg(otl.table_id order by otl.is_primary desc,otl.linked_at)
          from public.order_table_links otl
          where otl.order_id=o.id
            and (
              otl.unlinked_at is null
              or (
                not exists (
                  select 1
                  from public.order_table_links active_link
                  where active_link.order_id=o.id
                    and active_link.unlinked_at is null
                )
                and otl.unlinked_at=(
                  select max(last_link.unlinked_at)
                  from public.order_table_links last_link
                  where last_link.order_id=o.id
                )
              )
            )
        ),'[]'::jsonb),
        'rounds',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',r.id,'round_number',r.round_number,'status',r.status,
            'notes',r.notes,'created_at',r.created_at,'sent_at',r.sent_at,
            'items',coalesce((
              select jsonb_agg(jsonb_build_object(
                'id',oi.id,'product_id',oi.product_id,'station_id',oi.station_id,
                'station_type',coalesce(ks.station_type,'other'),
                'product_name',oi.product_name,'sku',oi.sku,'quantity',oi.quantity,
                'unit_price',oi.unit_price,'tax_rate',oi.tax_rate,'line_total',oi.line_total,
                'note',oi.note,'status',oi.status,'cancel_reason',oi.cancel_reason,
                'cancelled_at',oi.cancelled_at,'created_at',oi.created_at
              ) order by oi.created_at,oi.id)
              from public.order_items oi
              left join public.kitchen_stations ks on ks.id=oi.station_id
              where oi.round_id=r.id
            ),'[]'::jsonb)
          ) order by r.round_number)
          from public.order_rounds r where r.order_id=o.id
        ),'[]'::jsonb),
        'payments',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',p.id,'payment_number',p.payment_number,'method',p.method,
            'amount',p.amount,'status',p.status,'reference',p.reference,'paid_at',p.paid_at,
            'item_allocations',coalesce((
              select jsonb_agg(jsonb_build_object(
                'line_id',pa.order_item_id,
                'quantity',coalesce(pa.quantity,case when oi.unit_price>0 then pa.amount/oi.unit_price else null end),
                'unit_price',coalesce(pa.unit_price,oi.unit_price),
                'name',coalesce(pa.item_name,oi.product_name),
                'amount',pa.amount,
                'source_order_id',oi.order_id,
                'source_order_number',(select source_order.order_number from public.orders source_order where source_order.id=oi.order_id)
              ))
              from public.payment_allocations pa
              join public.order_items oi on oi.id=pa.order_item_id
              where pa.payment_id=p.id
            ),'[]'::jsonb)
          ) order by p.paid_at,p.id)
          from public.payments p
          where p.order_id=o.id and p.status in ('completed','refunded')
        ),'[]'::jsonb)
      ) order by o.opened_at,o.order_number),'[]'::jsonb)
  )
  into v_payload
  from public.orders o
  where o.restaurant_id=p_restaurant_id and o.location_id=p_location_id and o.id = any(coalesce(p_order_ids,array[]::uuid[]));

  return coalesce(v_payload,jsonb_build_object('orders','[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION private.load_operational_state(p_restaurant_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payload jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then raise exception 'Invalid restaurant/location'; end if;

  select jsonb_build_object(
    'orders',
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id',o.id,'order_number',o.order_number,'restaurant_id',o.restaurant_id,
        'location_id',o.location_id,'customer_id',o.customer_id,
        'service_mode',o.service_mode,'payment_timing',o.payment_timing,
        'customer_name',o.customer_name,'pager_number',o.pager_number,
        'status',o.status,'payment_status',o.payment_status,
        'subtotal',o.subtotal,'tax_total',o.tax_total,'total',o.total,
        'paid_total',o.paid_total,'refund_due',o.refund_due,'notes',o.notes,
        'delivery_details',o.delivery_details,'delivery_status',o.delivery_status,
        'invoice_issued_at',o.invoice_issued_at,'invoice_number',o.invoice_number,
        'invoice_voided_at',o.invoice_voided_at,
        'fiscal_correction_required',o.fiscal_correction_required,
        'account_void_reason',o.account_void_reason,
        'account_voided_at',o.account_voided_at,
        'account_void_audit_id',o.account_void_audit_id,
        'account_void_scope',o.account_void_scope,
        'opened_at',o.opened_at,'closed_at',o.closed_at,
        'table_ids',coalesce((
          select jsonb_agg(otl.table_id order by otl.is_primary desc,otl.linked_at)
          from public.order_table_links otl
          where otl.order_id=o.id
            and (
              otl.unlinked_at is null
              or (
                not exists (
                  select 1
                  from public.order_table_links active_link
                  where active_link.order_id=o.id
                    and active_link.unlinked_at is null
                )
                and otl.unlinked_at=(
                  select max(last_link.unlinked_at)
                  from public.order_table_links last_link
                  where last_link.order_id=o.id
                )
              )
            )
        ),'[]'::jsonb),
        'rounds',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',r.id,'round_number',r.round_number,'status',r.status,
            'notes',r.notes,'created_at',r.created_at,'sent_at',r.sent_at,
            'items',coalesce((
              select jsonb_agg(jsonb_build_object(
                'id',oi.id,'product_id',oi.product_id,'station_id',oi.station_id,
                'station_type',coalesce(ks.station_type,'other'),
                'product_name',oi.product_name,'sku',oi.sku,'quantity',oi.quantity,
                'unit_price',oi.unit_price,'tax_rate',oi.tax_rate,'line_total',oi.line_total,
                'note',oi.note,'status',oi.status,'cancel_reason',oi.cancel_reason,
                'cancelled_at',oi.cancelled_at,'created_at',oi.created_at
              ) order by oi.created_at,oi.id)
              from public.order_items oi
              left join public.kitchen_stations ks on ks.id=oi.station_id
              where oi.round_id=r.id
            ),'[]'::jsonb)
          ) order by r.round_number)
          from public.order_rounds r where r.order_id=o.id
        ),'[]'::jsonb),
        'payments',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',p.id,'payment_number',p.payment_number,'method',p.method,
            'amount',p.amount,'status',p.status,'reference',p.reference,'paid_at',p.paid_at,
            'item_allocations',coalesce((
              select jsonb_agg(jsonb_build_object(
                'line_id',pa.order_item_id,
                'quantity',coalesce(pa.quantity,case when oi.unit_price>0 then pa.amount/oi.unit_price else null end),
                'unit_price',coalesce(pa.unit_price,oi.unit_price),
                'name',coalesce(pa.item_name,oi.product_name),
                'amount',pa.amount,
                'source_order_id',oi.order_id,
                'source_order_number',(select source_order.order_number from public.orders source_order where source_order.id=oi.order_id)
              ))
              from public.payment_allocations pa
              join public.order_items oi on oi.id=pa.order_item_id
              where pa.payment_id=p.id
            ),'[]'::jsonb)
          ) order by p.paid_at,p.id)
          from public.payments p
          where p.order_id=o.id and p.status in ('completed','refunded')
        ),'[]'::jsonb)
      ) order by o.opened_at,o.order_number),'[]'::jsonb)
  )
  into v_payload
  from public.orders o
  where o.restaurant_id=p_restaurant_id and o.location_id=p_location_id;

  return coalesce(v_payload,jsonb_build_object('orders','[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION private.record_order_payments(p_allocations jsonb, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  if p_method not in ('cash','card','bank','voucher','other') then
    raise exception 'Invalid payment method';
  end if;

  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations)=0 then
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

    if v_applied <= 0.005 then continue; end if;

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

        if not exists (
          select 1
          from public.orders x
          where x.id=v_item.order_id
            and x.restaurant_id=v_order.restaurant_id
            and x.location_id=v_order.location_id
        ) then
          raise exception 'Item allocation belongs to another account';
        end if;

        v_qty := greatest(0,coalesce((v_item_alloc->>'quantity')::numeric,0));
        v_item_amount := round((v_qty * v_item.unit_price)::numeric,2);

        if v_qty <= 0 or v_item_amount <= 0 then continue; end if;

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

    v_total_applied := v_total_applied + v_applied;

    perform private.recalculate_order_financials(v_order.id);

    select exists (
      select 1
      from public.order_items
      where order_id=v_order.id
        and status in ('sent','preparing')
    ) into v_pending;

    select * into v_order from public.orders where id=v_order.id;

    if v_order.payment_status='paid' and not v_pending then
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user)
      where id=v_order.id;

      perform private.release_order_tables(v_order.id);

    elsif v_order.payment_status<>'paid' and not v_pending then
      update public.orders
      set status='awaiting_payment'
      where id=v_order.id;
    else
      update public.orders
      set status='open'
      where id=v_order.id;
    end if;
  end loop;

  return jsonb_build_object('applied',v_total_applied);
end;
$function$
;

CREATE OR REPLACE FUNCTION private.release_order_tables(p_order_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.order_table_links
  set unlinked_at=coalesce(unlinked_at,now())
  where order_id=p_order_id
    and unlinked_at is null;
$function$
;

CREATE OR REPLACE FUNCTION public.load_operational_orders_by_ids(p_restaurant_id uuid, p_location_id uuid, p_order_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.load_operational_orders_by_ids(
    p_restaurant_id,
    p_location_id,
    p_order_ids
  );
$function$
;


revoke all on function private.release_order_tables(uuid) from public,anon,authenticated;

revoke all on function private.load_operational_orders_by_ids(uuid,uuid,uuid[]) from public,anon;
grant execute on function private.load_operational_orders_by_ids(uuid,uuid,uuid[]) to authenticated;

revoke all on function public.load_operational_orders_by_ids(uuid,uuid,uuid[]) from public,anon;
grant execute on function public.load_operational_orders_by_ids(uuid,uuid,uuid[]) to authenticated;

revoke all on function private.advance_station_round(uuid,uuid,text) from public,anon;
grant execute on function private.advance_station_round(uuid,uuid,text) to authenticated;

revoke all on function private.record_order_payments(jsonb,text) from public,anon;
grant execute on function private.record_order_payments(jsonb,text) to authenticated;

update public.order_table_links l
set unlinked_at=coalesce(o.closed_at,now())
from public.orders o
where o.id=l.order_id
  and l.unlinked_at is null
  and o.service_mode='table'
  and (
    o.status='closed'
    or (o.status='cancelled' and o.account_void_scope='paid')
  );
