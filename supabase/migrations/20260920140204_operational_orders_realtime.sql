-- RestOS+ operational order synchronization
-- Supabase is the canonical source for orders, rounds/items and payments.

alter table public.orders
  add column if not exists paid_total numeric(14,2) not null default 0,
  add column if not exists refund_due numeric(14,2) not null default 0,
  add column if not exists delivery_details jsonb,
  add column if not exists delivery_status text,
  add column if not exists invoice_issued_at timestamptz,
  add column if not exists invoice_number text,
  add column if not exists invoice_voided_at timestamptz,
  add column if not exists fiscal_correction_required boolean not null default false,
  add column if not exists account_void_reason text,
  add column if not exists account_voided_at timestamptz,
  add column if not exists account_void_audit_id uuid,
  add column if not exists account_void_scope text;

alter table public.payment_allocations
  add column if not exists quantity numeric(12,3),
  add column if not exists unit_price numeric(14,2),
  add column if not exists item_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='orders_refund_due_nonnegative' and conrelid='public.orders'::regclass) then
    alter table public.orders add constraint orders_refund_due_nonnegative check (refund_due >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='orders_paid_total_nonnegative' and conrelid='public.orders'::regclass) then
    alter table public.orders add constraint orders_paid_total_nonnegative check (paid_total >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='orders_delivery_status_check' and conrelid='public.orders'::regclass) then
    alter table public.orders add constraint orders_delivery_status_check
      check (delivery_status is null or delivery_status in ('pending','sent','preparing','ready','out_for_delivery','delivered','cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname='orders_account_void_scope_check' and conrelid='public.orders'::regclass) then
    alter table public.orders add constraint orders_account_void_scope_check
      check (account_void_scope is null or account_void_scope in ('partial','paid'));
  end if;
end $$;

create index if not exists orders_location_status_opened_idx on public.orders(location_id,status,opened_at desc);
create index if not exists orders_restaurant_opened_idx on public.orders(restaurant_id,opened_at desc);
create index if not exists order_table_links_table_active_idx on public.order_table_links(table_id,order_id) where unlinked_at is null;
create unique index if not exists order_table_links_active_order_table_uq on public.order_table_links(order_id,table_id) where unlinked_at is null;
create index if not exists order_rounds_order_idx on public.order_rounds(order_id,round_number);
create index if not exists order_items_order_status_idx on public.order_items(order_id,status);
create index if not exists order_items_round_station_status_idx on public.order_items(round_id,station_id,status);
create index if not exists payments_order_status_idx on public.payments(order_id,status,paid_at desc);

alter table public.orders enable row level security;
alter table public.order_table_links enable row level security;
alter table public.order_rounds enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

revoke all on public.orders from anon, authenticated;
revoke all on public.order_table_links from anon, authenticated;
revoke all on public.order_rounds from anon, authenticated;
revoke all on public.order_items from anon, authenticated;
revoke all on public.payments from anon, authenticated;
revoke all on public.payment_allocations from anon, authenticated;

grant select on public.orders to authenticated;
grant select on public.order_table_links to authenticated;
grant select on public.order_rounds to authenticated;
grant select on public.order_items to authenticated;
grant select on public.payments to authenticated;
grant select on public.payment_allocations to authenticated;


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
    select 1 from public.order_items
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

CREATE OR REPLACE FUNCTION private.can_read_operational_location(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    private.user_has_location_permission(p_location_id,'orders.view')
    or private.user_has_location_permission(p_location_id,'orders.create')
    or private.user_has_location_permission(p_location_id,'kitchen.view')
    or private.user_has_location_permission(p_location_id,'bar.view')
    or private.user_has_location_permission(p_location_id,'payments.view')
    or private.user_has_location_permission(p_location_id,'payments.create');
$function$
;

CREATE OR REPLACE FUNCTION private.create_delivery_order(p_restaurant_id uuid, p_location_id uuid, p_customer_id uuid, p_customer_name text, p_delivery_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'orders.create') then
    raise exception 'Not allowed to create orders';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  insert into public.orders(
    restaurant_id,location_id,customer_id,service_mode,payment_timing,
    customer_name,status,payment_status,delivery_details,delivery_status,opened_by
  )
  values(
    p_restaurant_id,p_location_id,p_customer_id,'delivery','postpaid',
    nullif(btrim(coalesce(p_customer_name,'')),''),
    'draft','unpaid',p_delivery_details,'pending',v_user
  )
  returning * into v_order;

  return jsonb_build_object(
    'id',v_order.id,
    'order_number',v_order.order_number
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.join_order_table(p_order_id uuid, p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
begin
  select location_id into v_location
  from public.orders
  where id=p_order_id
    and status in ('draft','open','awaiting_payment')
  for update;

  if v_location is null then raise exception 'Open order not found'; end if;

  if not private.user_has_location_permission(v_location,'orders.update') then
    raise exception 'Not allowed to join tables';
  end if;

  perform 1 from public.dining_tables
  where id=p_table_id and location_id=v_location and active=true
  for update;
  if not found then raise exception 'Table is unavailable'; end if;

  if exists (
    select 1
    from public.order_table_links l
    join public.orders o on o.id=l.order_id
    where l.table_id=p_table_id
      and l.unlinked_at is null
      and o.id<>p_order_id
      and o.status in ('draft','open','awaiting_payment')
  ) then
    raise exception 'Table is occupied';
  end if;

  if not exists (
    select 1 from public.order_table_links
    where order_id=p_order_id
      and table_id=p_table_id
      and unlinked_at is null
  ) then
    insert into public.order_table_links(order_id,table_id,is_primary,linked_by)
    values(p_order_id,p_table_id,false,v_user);
  end if;
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
          where otl.order_id=o.id and otl.unlinked_at is null
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
                'amount',pa.amount,'source_order_id',oi.order_id
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

CREATE OR REPLACE FUNCTION private.mark_round_served(p_order_id uuid, p_round_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_location uuid;
begin
  select location_id into v_location
  from public.orders
  where id=p_order_id;

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
end;
$function$
;

CREATE OR REPLACE FUNCTION private.recalculate_order_financials(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_subtotal numeric(14,2);
  v_tax numeric(14,2);
  v_paid numeric(14,2);
  v_total numeric(14,2);
begin
  select
    coalesce(sum(oi.line_total),0),
    coalesce(sum((oi.line_total * oi.tax_rate) / 100.0),0)
  into v_subtotal,v_tax
  from public.order_items oi
  where oi.order_id=p_order_id
    and oi.status <> 'cancelled';

  v_total := v_subtotal;

  select coalesce(sum(p.amount),0)
  into v_paid
  from public.payments p
  where p.order_id=p_order_id
    and p.status='completed';

  update public.orders
  set subtotal=v_subtotal,
      tax_total=v_tax,
      total=v_total,
      paid_total=v_paid,
      payment_status=case
        when v_paid <= 0.005 then 'unpaid'
        when v_paid + 0.005 >= v_total and v_total > 0 then 'paid'
        else 'partial'
      end
  where id=p_order_id;
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

  for v_allocation in select value from jsonb_array_elements(p_allocations)
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
      select 1 from public.order_items
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

CREATE OR REPLACE FUNCTION private.send_order_round(p_order_id uuid, p_restaurant_id uuid, p_location_id uuid, p_service_mode text, p_payment_timing text, p_table_ids uuid[], p_customer_id uuid, p_customer_name text, p_delivery_details jsonb, p_pager_number text, p_items jsonb, p_prepaid boolean, p_payment_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_round public.order_rounds%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_station_id uuid;
  v_qty numeric(12,3);
  v_line_total numeric(14,2);
  v_round_total numeric(14,2) := 0;
  v_round_number integer;
  v_table uuid;
  v_conflict uuid;
  v_payment_method text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'orders.create') then
    raise exception 'Not allowed to create orders';
  end if;

  if p_service_mode not in ('table','counter','takeaway','delivery','kiosk') then
    raise exception 'Invalid service mode';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Add at least one product';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  if p_order_id is not null then
    select * into v_order
    from public.orders
    where id=p_order_id
      and restaurant_id=p_restaurant_id
      and location_id=p_location_id
      and status in ('draft','open','awaiting_payment')
    for update;

    if not found then raise exception 'Order is not open'; end if;
  elsif p_service_mode='table' and coalesce(array_length(p_table_ids,1),0)>0 then
    select o.* into v_order
    from public.orders o
    join public.order_table_links l
      on l.order_id=o.id
     and l.unlinked_at is null
    where l.table_id=p_table_ids[1]
      and o.restaurant_id=p_restaurant_id
      and o.location_id=p_location_id
      and o.status in ('draft','open','awaiting_payment')
    order by o.opened_at desc
    limit 1
    for update of o;
  end if;

  if v_order.id is null then
    insert into public.orders(
      restaurant_id,location_id,customer_id,service_mode,payment_timing,
      customer_name,pager_number,status,payment_status,delivery_details,
      delivery_status,opened_by
    )
    values(
      p_restaurant_id,p_location_id,p_customer_id,p_service_mode,
      case when p_prepaid then 'prepaid' else coalesce(nullif(p_payment_timing,''),'postpaid') end,
      nullif(btrim(coalesce(p_customer_name,'')),''),
      nullif(btrim(coalesce(p_pager_number,'')),''),
      'open','unpaid',
      case when p_service_mode='delivery' then p_delivery_details else null end,
      case when p_service_mode='delivery' then 'pending' else null end,
      v_user
    )
    returning * into v_order;
  else
    update public.orders
    set customer_id=coalesce(p_customer_id,customer_id),
        customer_name=coalesce(nullif(btrim(coalesce(p_customer_name,'')),''),customer_name),
        pager_number=coalesce(nullif(btrim(coalesce(p_pager_number,'')),''),pager_number),
        delivery_details=case
          when service_mode='delivery' then coalesce(p_delivery_details,delivery_details)
          else delivery_details
        end,
        status='open'
    where id=v_order.id
    returning * into v_order;
  end if;

  if p_service_mode='table' then
    if coalesce(array_length(p_table_ids,1),0)=0 then
      raise exception 'Select at least one table';
    end if;

    foreach v_table in array p_table_ids
    loop
      perform 1
      from public.dining_tables t
      where t.id=v_table
        and t.location_id=p_location_id
        and t.active=true
      for update;

      if not found then raise exception 'Invalid table'; end if;

      select o.id into v_conflict
      from public.order_table_links l
      join public.orders o on o.id=l.order_id
      where l.table_id=v_table
        and l.unlinked_at is null
        and o.id<>v_order.id
        and o.status in ('draft','open','awaiting_payment')
      limit 1;

      if v_conflict is not null then
        raise exception 'Table is already occupied';
      end if;

      insert into public.order_table_links(order_id,table_id,is_primary,linked_by)
      select v_order.id,v_table,
             not exists (
               select 1 from public.order_table_links x
               where x.order_id=v_order.id and x.unlinked_at is null
             ),
             v_user
      where not exists (
        select 1 from public.order_table_links x
        where x.order_id=v_order.id
          and x.table_id=v_table
          and x.unlinked_at is null
      );
    end loop;
  end if;

  select coalesce(max(r.round_number),0)+1
  into v_round_number
  from public.order_rounds r
  where r.order_id=v_order.id;

  insert into public.order_rounds(
    order_id,round_number,status,created_by,sent_by,sent_at
  )
  values(v_order.id,v_round_number,'sent',v_user,v_user,now())
  returning * into v_round;

  for v_item in
    select value from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric,0);
    if v_qty <= 0 then raise exception 'Invalid product quantity'; end if;

    select p.* into v_product
    from public.products p
    where p.id=(v_item->>'productId')::uuid
      and p.restaurant_id=p_restaurant_id
      and p.active=true;

    if not found then raise exception 'Product is unavailable'; end if;

    select r.station_id into v_station_id
    from public.product_station_routes r
    join public.kitchen_stations s on s.id=r.station_id
    where r.product_id=v_product.id
      and r.location_id=p_location_id
      and s.location_id=p_location_id
      and s.active=true
    limit 1;

    if v_station_id is null then
      raise exception 'Product has no preparation station';
    end if;

    v_line_total := round((v_product.base_price * v_qty)::numeric,2);
    v_round_total := v_round_total + v_line_total;

    insert into public.order_items(
      order_id,round_id,product_id,station_id,product_name,sku,
      quantity,unit_price,tax_rate,line_total,note,status,created_by
    )
    values(
      v_order.id,v_round.id,v_product.id,v_station_id,v_product.name,v_product.sku,
      v_qty,v_product.base_price,v_product.tax_rate,v_line_total,
      nullif(btrim(coalesce(v_item->>'note','')),''),
      'sent',v_user
    );
  end loop;

  perform private.recalculate_order_financials(v_order.id);

  if p_prepaid then
    v_payment_method := case
      when p_payment_method in ('cash','card','bank','voucher','other') then p_payment_method
      else 'card'
    end;

    insert into public.payments(
      restaurant_id,location_id,order_id,method,amount,status,received_by
    )
    values(
      p_restaurant_id,p_location_id,v_order.id,v_payment_method,v_round_total,
      'completed',v_user
    );

    perform private.recalculate_order_financials(v_order.id);
  end if;

  if p_service_mode='delivery' then
    update public.orders
    set delivery_status='sent'
    where id=v_order.id;
  end if;

  select * into v_order from public.orders where id=v_order.id;

  return jsonb_build_object(
    'order_id',v_order.id,
    'order_number',v_order.order_number,
    'round_id',v_round.id,
    'round_number',v_round.round_number
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.transfer_order_table(p_order_id uuid, p_from_table_id uuid, p_to_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_location uuid;
begin
  select location_id into v_location
  from public.orders
  where id=p_order_id
    and status in ('draft','open','awaiting_payment')
  for update;

  if v_location is null then raise exception 'Open order not found'; end if;

  if not private.user_has_location_permission(v_location,'orders.update') then
    raise exception 'Not allowed to transfer this order';
  end if;

  perform 1 from public.dining_tables
  where id=p_to_table_id and location_id=v_location and active=true
  for update;
  if not found then raise exception 'Destination table is unavailable'; end if;

  if exists (
    select 1
    from public.order_table_links l
    join public.orders o on o.id=l.order_id
    where l.table_id=p_to_table_id
      and l.unlinked_at is null
      and o.id<>p_order_id
      and o.status in ('draft','open','awaiting_payment')
  ) then
    raise exception 'Destination table is occupied';
  end if;

  update public.order_table_links
  set unlinked_at=now()
  where order_id=p_order_id
    and table_id=p_from_table_id
    and unlinked_at is null;

  insert into public.order_table_links(order_id,table_id,is_primary,linked_by)
  values(p_order_id,p_to_table_id,true,v_user);

  update public.order_table_links
  set is_primary=false
  where order_id=p_order_id
    and table_id<>p_to_table_id
    and unlinked_at is null;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.user_has_location_permission(p_location_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.locations l
      join public.memberships m
        on m.restaurant_id = l.restaurant_id
       and m.user_id = (select auth.uid())
       and m.status = 'active'
      join public.role_permissions rp
        on rp.role_id = m.role_id
       and rp.permission_code = p_permission
      where l.id = p_location_id
        and l.active = true
        and (
          m.all_locations
          or exists (
            select 1
            from public.membership_locations ml
            where ml.membership_id = m.id
              and ml.location_id = l.id
          )
        )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.advance_station_round(p_order_id uuid, p_round_id uuid, p_station_type text)
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.advance_station_round(p_order_id,p_round_id,p_station_type);
$function$
;

CREATE OR REPLACE FUNCTION public.create_delivery_order(p_restaurant_id uuid, p_location_id uuid, p_customer_id uuid, p_customer_name text, p_delivery_details jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.create_delivery_order(
    p_restaurant_id,p_location_id,p_customer_id,p_customer_name,p_delivery_details
  );
$function$
;

CREATE OR REPLACE FUNCTION public.join_order_table(p_order_id uuid, p_table_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.join_order_table(p_order_id,p_table_id);
$function$
;

CREATE OR REPLACE FUNCTION public.load_operational_state(p_restaurant_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.load_operational_state(p_restaurant_id,p_location_id);
$function$
;

CREATE OR REPLACE FUNCTION public.mark_round_served(p_order_id uuid, p_round_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.mark_round_served(p_order_id,p_round_id);
$function$
;

CREATE OR REPLACE FUNCTION public.record_order_payments(p_allocations jsonb, p_method text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.record_order_payments(p_allocations,p_method);
$function$
;

CREATE OR REPLACE FUNCTION public.send_order_round(p_order_id uuid, p_restaurant_id uuid, p_location_id uuid, p_service_mode text, p_payment_timing text, p_table_ids uuid[], p_customer_id uuid, p_customer_name text, p_delivery_details jsonb, p_pager_number text, p_items jsonb, p_prepaid boolean, p_payment_method text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.send_order_round(
    p_order_id,p_restaurant_id,p_location_id,p_service_mode,p_payment_timing,
    p_table_ids,p_customer_id,p_customer_name,p_delivery_details,p_pager_number,
    p_items,p_prepaid,p_payment_method
  );
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_order_table(p_order_id uuid, p_from_table_id uuid, p_to_table_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.transfer_order_table(p_order_id,p_from_table_id,p_to_table_id);
$function$
;


drop policy if exists orders_operational_select on public.orders;
create policy orders_operational_select on public.orders for select to authenticated using (
  private.user_has_location_permission(location_id,'orders.view')
  or private.user_has_location_permission(location_id,'orders.create')
  or private.user_has_location_permission(location_id,'kitchen.view')
  or private.user_has_location_permission(location_id,'bar.view')
  or private.user_has_location_permission(location_id,'payments.view')
  or private.user_has_location_permission(location_id,'payments.create')
);

drop policy if exists order_table_links_operational_select on public.order_table_links;
create policy order_table_links_operational_select on public.order_table_links for select to authenticated using (
  exists (select 1 from public.orders o where o.id=order_table_links.order_id and (
    private.user_has_location_permission(o.location_id,'orders.view')
    or private.user_has_location_permission(o.location_id,'orders.create')
    or private.user_has_location_permission(o.location_id,'kitchen.view')
    or private.user_has_location_permission(o.location_id,'bar.view')
    or private.user_has_location_permission(o.location_id,'payments.view')
    or private.user_has_location_permission(o.location_id,'payments.create')
  ))
);

drop policy if exists order_rounds_operational_select on public.order_rounds;
create policy order_rounds_operational_select on public.order_rounds for select to authenticated using (
  exists (select 1 from public.orders o where o.id=order_rounds.order_id and (
    private.user_has_location_permission(o.location_id,'orders.view')
    or private.user_has_location_permission(o.location_id,'orders.create')
    or private.user_has_location_permission(o.location_id,'kitchen.view')
    or private.user_has_location_permission(o.location_id,'bar.view')
    or private.user_has_location_permission(o.location_id,'payments.view')
    or private.user_has_location_permission(o.location_id,'payments.create')
  ))
);

drop policy if exists order_items_operational_select on public.order_items;
create policy order_items_operational_select on public.order_items for select to authenticated using (
  exists (select 1 from public.orders o where o.id=order_items.order_id and (
    private.user_has_location_permission(o.location_id,'orders.view')
    or private.user_has_location_permission(o.location_id,'orders.create')
    or private.user_has_location_permission(o.location_id,'kitchen.view')
    or private.user_has_location_permission(o.location_id,'bar.view')
    or private.user_has_location_permission(o.location_id,'payments.view')
    or private.user_has_location_permission(o.location_id,'payments.create')
  ))
);

drop policy if exists payments_operational_select on public.payments;
create policy payments_operational_select on public.payments for select to authenticated using (
  exists (select 1 from public.orders o where o.id=payments.order_id and (
    private.user_has_location_permission(o.location_id,'orders.view')
    or private.user_has_location_permission(o.location_id,'orders.create')
    or private.user_has_location_permission(o.location_id,'payments.view')
    or private.user_has_location_permission(o.location_id,'payments.create')
  ))
);

drop policy if exists payment_allocations_operational_select on public.payment_allocations;
create policy payment_allocations_operational_select on public.payment_allocations for select to authenticated using (
  exists (select 1 from public.payments p join public.orders o on o.id=p.order_id
    where p.id=payment_allocations.payment_id and (
      private.user_has_location_permission(o.location_id,'orders.view')
      or private.user_has_location_permission(o.location_id,'orders.create')
      or private.user_has_location_permission(o.location_id,'payments.view')
      or private.user_has_location_permission(o.location_id,'payments.create')
    )
  )
);



revoke all on function private.user_has_location_permission(uuid,text) from public,anon;
grant execute on function private.user_has_location_permission(uuid,text) to authenticated;
revoke all on function private.recalculate_order_financials(uuid) from public,anon,authenticated;
revoke all on function private.can_read_operational_location(uuid) from public,anon;
grant execute on function private.can_read_operational_location(uuid) to authenticated;

revoke all on function private.load_operational_state(uuid,uuid) from public,anon;
grant execute on function private.load_operational_state(uuid,uuid) to authenticated;
revoke all on function public.load_operational_state(uuid,uuid) from public,anon;
grant execute on function public.load_operational_state(uuid,uuid) to authenticated;

revoke all on function private.create_delivery_order(uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function private.create_delivery_order(uuid,uuid,uuid,text,jsonb) to authenticated;
revoke all on function public.create_delivery_order(uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.create_delivery_order(uuid,uuid,uuid,text,jsonb) to authenticated;

revoke all on function private.send_order_round(uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text) from public,anon;
grant execute on function private.send_order_round(uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text) to authenticated;
revoke all on function public.send_order_round(uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text) from public,anon;
grant execute on function public.send_order_round(uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text) to authenticated;

revoke all on function private.advance_station_round(uuid,uuid,text) from public,anon;
grant execute on function private.advance_station_round(uuid,uuid,text) to authenticated;
revoke all on function public.advance_station_round(uuid,uuid,text) from public,anon;
grant execute on function public.advance_station_round(uuid,uuid,text) to authenticated;

revoke all on function private.mark_round_served(uuid,uuid) from public,anon;
grant execute on function private.mark_round_served(uuid,uuid) to authenticated;
revoke all on function public.mark_round_served(uuid,uuid) from public,anon;
grant execute on function public.mark_round_served(uuid,uuid) to authenticated;

revoke all on function private.transfer_order_table(uuid,uuid,uuid) from public,anon;
grant execute on function private.transfer_order_table(uuid,uuid,uuid) to authenticated;
revoke all on function public.transfer_order_table(uuid,uuid,uuid) from public,anon;
grant execute on function public.transfer_order_table(uuid,uuid,uuid) to authenticated;

revoke all on function private.join_order_table(uuid,uuid) from public,anon;
grant execute on function private.join_order_table(uuid,uuid) to authenticated;
revoke all on function public.join_order_table(uuid,uuid) from public,anon;
grant execute on function public.join_order_table(uuid,uuid) to authenticated;

revoke all on function private.record_order_payments(jsonb,text) from public,anon;
grant execute on function private.record_order_payments(jsonb,text) to authenticated;
revoke all on function public.record_order_payments(jsonb,text) from public,anon;
grant execute on function public.record_order_payments(jsonb,text) to authenticated;



do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='orders') then alter publication supabase_realtime add table public.orders; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='order_table_links') then alter publication supabase_realtime add table public.order_table_links; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='order_rounds') then alter publication supabase_realtime add table public.order_rounds; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='order_items') then alter publication supabase_realtime add table public.order_items; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='payments') then alter publication supabase_realtime add table public.payments; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='payment_allocations') then alter publication supabase_realtime add table public.payment_allocations; end if;
end $$;
