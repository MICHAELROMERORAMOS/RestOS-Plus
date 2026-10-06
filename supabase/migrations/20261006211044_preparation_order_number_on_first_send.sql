alter table public.orders
  add column if not exists preparation_order_number bigint;

with first_sent as (
  select
    o.id,
    o.location_id,
    min(r.sent_at) as first_sent_at
  from public.orders o
  join public.order_rounds r on r.order_id=o.id
  where r.sent_at is not null
  group by o.id,o.location_id
),
ranked as (
  select
    id,
    location_id,
    row_number() over (
      partition by location_id
      order by first_sent_at,id
    )::bigint as sent_number
  from first_sent
)
update public.orders o
set preparation_order_number=ranked.sent_number
from ranked
where o.id=ranked.id
  and o.preparation_order_number is null;

create unique index if not exists orders_location_preparation_number_uidx
  on public.orders(location_id,preparation_order_number)
  where preparation_order_number is not null;

create table if not exists private.location_preparation_order_counters (
  location_id uuid primary key references public.locations(id) on delete cascade,
  last_number bigint not null default 0 check (last_number >= 0),
  updated_at timestamptz not null default now()
);

insert into private.location_preparation_order_counters(location_id,last_number,updated_at)
select
  location_id,
  max(preparation_order_number),
  now()
from public.orders
where preparation_order_number is not null
group by location_id
on conflict(location_id) do update
set last_number=greatest(
      private.location_preparation_order_counters.last_number,
      excluded.last_number
    ),
    updated_at=now();

CREATE OR REPLACE FUNCTION private.ensure_preparation_order_number(p_order_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_location_id uuid;
  v_existing bigint;
  v_next bigint;
begin
  select o.location_id,o.preparation_order_number
  into v_location_id,v_existing
  from public.orders o
  where o.id=p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_existing is not null then
    return v_existing;
  end if;

  insert into private.location_preparation_order_counters(location_id,last_number,updated_at)
  values(v_location_id,1,now())
  on conflict(location_id) do update
  set last_number=private.location_preparation_order_counters.last_number+1,
      updated_at=now()
  returning last_number into v_next;

  update public.orders
  set preparation_order_number=v_next,
      updated_at=now()
  where id=p_order_id;

  return v_next;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.attach_preparation_order_numbers(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_orders jsonb;
begin
  select coalesce(
    jsonb_agg(
      entry.order_json
      || jsonb_build_object(
        'preparation_order_number',
        o.preparation_order_number
      )
      order by entry.ord
    ),
    '[]'::jsonb
  )
  into v_orders
  from jsonb_array_elements(coalesce(p_payload->'orders','[]'::jsonb))
       with ordinality as entry(order_json,ord)
  left join public.orders o
    on o.id=nullif(entry.order_json->>'id','')::uuid;

  return jsonb_set(
    coalesce(p_payload,'{}'::jsonb),
    '{orders}',
    coalesce(v_orders,'[]'::jsonb),
    true
  );
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

  perform private.ensure_preparation_order_number(v_order.id);

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

CREATE OR REPLACE FUNCTION public.load_operational_orders_by_ids(p_restaurant_id uuid, p_location_id uuid, p_order_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select private.attach_invoice_customers(
    private.attach_preparation_order_numbers(
      private.load_operational_orders_by_ids(
        p_restaurant_id,
        p_location_id,
        p_order_ids
      )
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.load_operational_state(p_restaurant_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select private.attach_invoice_customers(
    private.attach_preparation_order_numbers(
      private.load_operational_state(p_restaurant_id,p_location_id)
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.load_operational_history(p_restaurant_id uuid, p_location_id uuid, p_service_mode text DEFAULT NULL::text, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select private.attach_invoice_customers(
    private.attach_preparation_order_numbers(
      private.load_operational_history(
        p_restaurant_id,
        p_location_id,
        p_service_mode,
        p_before,
        p_limit
      )
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION private.get_invoice_previews(p_order_ids uuid[], p_user_id uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then return '[]'::jsonb; end if;

  if exists (
    select 1
    from public.orders o
    join public.locations l on l.id = o.location_id and l.active = true
    where o.id = any(p_order_ids)
      and not exists (
        select 1
        from public.memberships m
        join public.role_permissions rp
          on rp.role_id = m.role_id and rp.permission_code = 'payments.create'
        where m.user_id = p_user_id
          and m.restaurant_id = o.restaurant_id
          and m.status = 'active'
          and (
            m.all_locations
            or exists (
              select 1 from public.membership_locations ml
              where ml.membership_id = m.id and ml.location_id = o.location_id
            )
          )
      )
  ) then raise exception 'No tienes permiso para consultar estas facturas'; end if;

  select coalesce(jsonb_agg(invoice_data order by invoice_data->>'invoiceNumber'), '[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object(
      'orderId', o.id, 'orderNumber', coalesce(o.preparation_order_number,o.order_number),
      'invoiceNumber', o.invoice_number, 'issuedAt', o.invoice_issued_at,
      'restaurantName', r.name, 'locationName', l.name,
      'tableLabel', (
        select string_agg(coalesce(t.name, t.code), ' + ' order by otl.is_primary desc, t.name)
        from public.order_table_links otl join public.dining_tables t on t.id = otl.table_id
        where otl.order_id = o.id and otl.unlinked_at is null
      ),
      'customerName', o.customer_name, 'serviceMode', o.service_mode,
      'subtotal', o.subtotal, 'discountTotal', o.discount_total,
      'taxTotal', o.tax_total, 'total', o.total, 'paidTotal', o.paid_total,
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', i.id, 'name', i.product_name, 'quantity', i.quantity,
          'unitPrice', i.unit_price, 'taxRate', i.tax_rate, 'amount', i.line_total
        ) order by i.created_at), '[]'::jsonb)
        from public.order_items i where i.order_id = o.id and i.status <> 'cancelled'
      ),
      'payments', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'number', p.payment_number, 'method', p.method,
          'amount', p.amount, 'paidAt', p.paid_at
        ) order by p.paid_at), '[]'::jsonb)
        from public.payments p where p.order_id = o.id and p.status = 'completed'
      )
    ) as invoice_data
    from public.orders o
    join public.restaurants r on r.id = o.restaurant_id
    join public.locations l on l.id = o.location_id
    where o.id = any(p_order_ids)
      and o.payment_status = 'paid'
      and o.invoice_number is not null
      and o.invoice_voided_at is null
  ) invoices;
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.get_invoice_previews_v2(p_order_ids uuid[], p_user_id uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_user_id is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.memberships m join public.orders o on o.restaurant_id=m.restaurant_id where o.id=any(p_order_ids) and m.user_id=p_user_id and m.status='active') then raise exception 'No tienes permiso para consultar estas facturas'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('orderId',q.id,'orderNumber',q.order_number,'invoiceNumber',q.invoice_number,'issuedAt',q.invoice_issued_at,'restaurantName',q.restaurant_name,'locationName',q.location_name,'tableLabel',q.table_label,'customerName',q.customer_name,'serviceMode',q.service_mode,'subtotal',q.subtotal,'discountTotal',q.discount_total,'taxTotal',q.tax_total,'total',q.total,'paidTotal',q.paid_total,'items',q.items,'payments',q.payments) order by q.invoice_issued_at desc),'[]'::jsonb) into result
 from (select o.id,coalesce(o.preparation_order_number,o.order_number) order_number,o.invoice_number,o.invoice_issued_at,r.name restaurant_name,l.name location_name,o.customer_name,o.service_mode,o.subtotal,o.discount_total,o.tax_total,o.total,o.paid_total,
 (select string_agg(coalesce(t.name,t.code),' + ' order by otl.is_primary desc,t.name) from public.order_table_links otl join public.dining_tables t on t.id=otl.table_id where otl.order_id=o.id and otl.unlinked_at is null) table_label,
 (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.product_name,'quantity',i.quantity,'unitPrice',i.unit_price,'taxRate',i.tax_rate,'amount',i.line_total) order by i.created_at),'[]'::jsonb) from public.order_items i where i.order_id=o.id and i.status<>'cancelled') items,
 (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',p.payment_number,'method',p.method,'amount',p.amount,'paidAt',p.paid_at) order by p.paid_at),'[]'::jsonb) from public.payments p where p.order_id=o.id and p.status='completed') payments
 from public.orders o join public.restaurants r on r.id=o.restaurant_id join public.locations l on l.id=o.location_id where o.id=any(p_order_ids) and o.payment_status='paid' and o.invoice_number is not null and o.invoice_voided_at is null) q;
 return result;
end; $function$
;

CREATE OR REPLACE FUNCTION public.list_paid_invoices(p_restaurant_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_voided boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb;
begin
  if (select auth.uid()) is null
     or not private.user_has_restaurant_permission(p_restaurant_id,'reports.view') then
    raise exception 'No autorizado';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',q.id,
      'invoiceNumber',q.invoice_number,
      'issuedAt',q.issued_at,
      'orderNumber',q.order_number,
      'subtotal',q.subtotal,
      'taxTotal',q.tax_total,
      'total',q.total,
      'paidTotal',q.total,
      'voided',q.voided,
      'status',case when q.voided then 'voided' else 'valid' end,
      'serviceMode',q.service_mode,
      'serviceLabel',q.service_label,
      'tableIds',q.table_ids,
      'tables',q.tables,
      'customer',q.customer,
      'billingCustomer',q.billing_customer,
      'delivery',q.delivery,
      'items',q.items,
      'payments',q.payments
    )
    order by q.issued_at desc
  ),'[]'::jsonb)
  into result
  from (
    select
      si.id,
      si.invoice_number,
      si.issued_at,
      coalesce(o.preparation_order_number,o.order_number) order_number,
      si.subtotal,
      si.tax_total,
      si.total,
      si.status='voided' as voided,
      case when o.service_mode='counter' then 'quick' else o.service_mode end service_mode,
      case
        when o.service_mode='table' then 'Mesa'
        when o.service_mode='counter' then 'Servicio rápido'
        when o.service_mode='delivery' then 'Domicilio'
        else coalesce(o.service_mode,'Pedido')
      end service_label,
      coalesce((
        select jsonb_agg(to_jsonb(otl.table_id) order by otl.linked_at)
        from public.order_table_links otl where otl.order_id=o.id
      ),'[]'::jsonb) table_ids,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('id',dt.id,'code',dt.code,'name',coalesce(nullif(dt.name,''),dt.code))
          order by otl.linked_at
        )
        from public.order_table_links otl
        join public.dining_tables dt on dt.id=otl.table_id
        where otl.order_id=o.id
      ),'[]'::jsonb) tables,
      case
        when o.customer_id is not null or o.customer_name is not null then
          jsonb_build_object(
            'id',o.customer_id,
            'name',coalesce(nullif(o.customer_name,''),c.full_name),
            'phone',c.phone,
            'email',c.email
          )
        else null
      end customer,
      si.billing_customer,
      o.delivery_details delivery,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'name',sii.item_name,
            'quantity',sii.quantity,
            'unitPrice',sii.unit_price,
            'taxRate',sii.tax_rate,
            'amount',sii.amount
          )
          order by sii.created_at
        )
        from public.sales_invoice_items sii
        where sii.invoice_id=si.id
      ),'[]'::jsonb) items,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',p.id,
            'method',p.method,
            'amount',p.amount,
            'paidAt',p.paid_at,
            'reference',p.reference
          )
          order by p.paid_at
        )
        from public.sales_invoice_payments sip
        join public.payments p on p.id=sip.payment_id
        where sip.invoice_id=si.id
      ),'[]'::jsonb) payments
    from public.sales_invoices si
    join public.orders o on o.id=si.order_id
    left join public.customers c on c.id=o.customer_id
    where si.restaurant_id=p_restaurant_id
      and (p_from is null or si.issued_at::date>=p_from)
      and (p_to is null or si.issued_at::date<=p_to)
      and (p_voided is null or (si.status='voided')=p_voided)
  ) q;

  return result;
end;
$function$
;

revoke all on function private.ensure_preparation_order_number(uuid)
from public,anon,authenticated;

revoke all on function private.attach_preparation_order_numbers(jsonb)
from public,anon;

grant execute on function private.attach_preparation_order_numbers(jsonb)
to authenticated;
