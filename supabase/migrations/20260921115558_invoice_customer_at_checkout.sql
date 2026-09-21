-- Optional customer details captured at checkout and frozen on the invoice.
alter table public.customers
  add column if not exists document_type text,
  add column if not exists document_number text,
  add column if not exists document_number_normalized text;

create unique index if not exists customers_restaurant_document_uq
  on public.customers (restaurant_id, document_type, document_number_normalized)
  where document_type is not null
    and document_number_normalized is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_document_type_check'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_document_type_check
      check (
        document_type is null
        or document_type in ('CC', 'NIT', 'CE', 'TI', 'PA', 'PPT', 'OTHER')
      );
  end if;

end;
$$;

-- Identification data is isolated from operational orders so kitchen/bar
-- roles cannot read billing documents through the orders Data API.
create table if not exists public.order_invoice_customers (
  order_id uuid primary key references public.orders(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_invoice_customers_restaurant_idx
  on public.order_invoice_customers (restaurant_id);

create index if not exists order_invoice_customers_customer_idx
  on public.order_invoice_customers (customer_id);

create index if not exists order_invoice_customers_created_by_idx
  on public.order_invoice_customers (created_by);

alter table public.order_invoice_customers enable row level security;

drop policy if exists "invoice customers visible to billing roles"
  on public.order_invoice_customers;

create policy "invoice customers visible to billing roles"
on public.order_invoice_customers
for select
to authenticated
using (
  private.user_has_restaurant_permission(restaurant_id, 'reports.view')
  or exists (
    select 1
    from public.orders o
    where o.id = order_invoice_customers.order_id
      and (
        private.user_has_location_permission(o.location_id, 'payments.view')
        or private.user_has_location_permission(o.location_id, 'payments.create')
      )
  )
);

revoke all on table public.order_invoice_customers from public, anon, authenticated;
grant select on table public.order_invoice_customers to authenticated;
grant select, insert, update, delete on table public.order_invoice_customers to service_role;

-- Enrich the existing operational payload without duplicating its large query.
-- The underlying orders SELECT policy continues to determine which rows are visible.
create or replace function private.attach_invoice_customers(p_payload jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_set(
    coalesce(p_payload, '{}'::jsonb),
    '{orders}',
    coalesce(
      (
        select jsonb_agg(
          entry.value || jsonb_build_object('invoice_customer', oic.snapshot)
          order by entry.ordinality
        )
        from jsonb_array_elements(coalesce(p_payload->'orders', '[]'::jsonb))
          with ordinality as entry(value, ordinality)
        left join public.orders o on o.id = (entry.value->>'id')::uuid
        left join public.order_invoice_customers oic on oic.order_id = o.id
      ),
      '[]'::jsonb
    ),
    true
  );
$$;

revoke all on function private.attach_invoice_customers(jsonb) from public, anon;
grant execute on function private.attach_invoice_customers(jsonb) to authenticated, service_role;

create or replace function public.load_operational_state(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.attach_invoice_customers(
    private.load_operational_state(p_restaurant_id, p_location_id)
  );
$$;

create or replace function public.load_operational_orders_by_ids(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.attach_invoice_customers(
    private.load_operational_orders_by_ids(
      p_restaurant_id,
      p_location_id,
      p_order_ids
    )
  );
$$;

create or replace function public.load_operational_history(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_service_mode text default null,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.attach_invoice_customers(
    private.load_operational_history(
      p_restaurant_id,
      p_location_id,
      p_service_mode,
      p_before,
      p_limit
    )
  );
$$;

revoke all on function public.load_operational_state(uuid, uuid) from public, anon;
revoke all on function public.load_operational_orders_by_ids(uuid, uuid, uuid[]) from public, anon;
revoke all on function public.load_operational_history(uuid, uuid, text, timestamptz, integer) from public, anon;
grant execute on function public.load_operational_state(uuid, uuid) to authenticated, service_role;
grant execute on function public.load_operational_orders_by_ids(uuid, uuid, uuid[]) to authenticated, service_role;
grant execute on function public.load_operational_history(uuid, uuid, text, timestamptz, integer) to authenticated, service_role;

-- Save/clear the optional billing customer and register the payment in one
-- transaction. Existing two-argument payment calls remain compatible.
create or replace function private.record_order_payments_with_customer(
  p_allocations jsonb,
  p_method text,
  p_invoice_customer jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_requested_ids uuid[];
  v_order_ids uuid[];
  v_restaurant_count integer;
  v_restaurant_id uuid;
  v_requested boolean;
  v_customer_id uuid;
  v_customer public.customers%rowtype;
  v_name text;
  v_document_type text;
  v_document_number text;
  v_document_normalized text;
  v_phone text;
  v_phone_normalized text;
  v_email text;
  v_address text;
  v_neighborhood text;
  v_city text;
  v_snapshot jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'No payment allocations';
  end if;

  select coalesce(
    array_agg(distinct (allocation.value->>'orderId')::uuid),
    '{}'::uuid[]
  )
  into v_requested_ids
  from jsonb_array_elements(p_allocations) as allocation(value)
  where nullif(allocation.value->>'orderId', '') is not null;

  select
    coalesce(array_agg(distinct o.id), '{}'::uuid[]),
    count(distinct o.restaurant_id)::integer
  into v_order_ids, v_restaurant_count
  from public.orders o
  where o.id = any(v_requested_ids)
    and o.status in ('draft', 'open', 'awaiting_payment');

  if cardinality(v_order_ids) = 0 then
    return private.record_order_payments(p_allocations, p_method);
  end if;

  if v_restaurant_count <> 1 then
    raise exception 'All payments must belong to the same restaurant';
  end if;

  if exists (
    select 1
    from public.orders o
    where o.id = any(v_order_ids)
      and not private.user_has_location_permission(o.location_id, 'payments.create')
  ) then
    raise exception 'Not allowed to register payment';
  end if;

  select o.restaurant_id
  into v_restaurant_id
  from public.orders o
  where o.id = any(v_order_ids)
  limit 1;

  -- NULL means an older client did not send this feature; preserve prior data.
  if p_invoice_customer is null then
    return private.record_order_payments(p_allocations, p_method);
  end if;

  if jsonb_typeof(p_invoice_customer) <> 'object' then
    raise exception 'Invalid invoice customer';
  end if;

  v_requested := coalesce((p_invoice_customer->>'requested')::boolean, false);

  if not v_requested then
    delete from public.order_invoice_customers
    where order_id = any(v_order_ids);

    update public.orders
    set customer_id = case when service_mode = 'delivery' then customer_id else null end,
        customer_name = case when service_mode = 'delivery' then customer_name else null end,
        updated_at = now()
    where id = any(v_order_ids);

    return private.record_order_payments(p_allocations, p_method);
  end if;

  v_name := btrim(coalesce(p_invoice_customer->>'fullName', ''));
  v_document_type := upper(btrim(coalesce(p_invoice_customer->>'documentType', '')));
  v_document_number := btrim(coalesce(p_invoice_customer->>'documentNumber', ''));
  v_document_normalized := upper(regexp_replace(v_document_number, '[^A-Za-z0-9]', '', 'g'));
  v_phone := nullif(btrim(coalesce(p_invoice_customer->>'phone', '')), '');
  v_phone_normalized := private.normalize_customer_phone(v_phone);
  v_email := nullif(lower(btrim(coalesce(p_invoice_customer->>'email', ''))), '');
  v_address := nullif(btrim(coalesce(p_invoice_customer->>'address', '')), '');
  v_neighborhood := nullif(btrim(coalesce(p_invoice_customer->>'neighborhood', '')), '');
  v_city := nullif(btrim(coalesce(p_invoice_customer->>'city', '')), '');

  if char_length(v_name) < 2 or char_length(v_name) > 160 then
    raise exception 'Invoice customer name must contain between 2 and 160 characters';
  end if;

  if v_document_type not in ('CC', 'NIT', 'CE', 'TI', 'PA', 'PPT', 'OTHER') then
    raise exception 'Invalid customer document type';
  end if;

  if char_length(v_document_normalized) < 3 or char_length(v_document_normalized) > 30 then
    raise exception 'Customer document must contain between 3 and 30 letters or numbers';
  end if;

  if v_phone_normalized is not null and char_length(v_phone_normalized) < 7 then
    raise exception 'Customer phone is too short';
  end if;

  if v_email is not null
     and (char_length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then
    raise exception 'Invalid customer email';
  end if;

  if nullif(p_invoice_customer->>'id', '') is not null then
    begin
      v_customer_id := (p_invoice_customer->>'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid customer identifier';
    end;

    select *
    into v_customer
    from public.customers c
    where c.id = v_customer_id
      and c.restaurant_id = v_restaurant_id
    for update;

    if not found then
      raise exception 'Customer does not belong to this restaurant';
    end if;
  else
    select *
    into v_customer
    from public.customers c
    where c.restaurant_id = v_restaurant_id
      and c.document_type = v_document_type
      and c.document_number_normalized = v_document_normalized
    limit 1
    for update;

    if not found and v_phone_normalized is not null then
      select *
      into v_customer
      from public.customers c
      where c.restaurant_id = v_restaurant_id
        and c.phone_normalized = v_phone_normalized
      limit 1
      for update;
    end if;
  end if;

  begin
    if v_customer.id is null then
      insert into public.customers (
        restaurant_id,
        full_name,
        document_type,
        document_number,
        document_number_normalized,
        email,
        phone,
        phone_normalized,
        address,
        neighborhood,
        city,
        active,
        created_by
      )
      values (
        v_restaurant_id,
        v_name,
        v_document_type,
        v_document_number,
        v_document_normalized,
        v_email,
        v_phone,
        v_phone_normalized,
        v_address,
        v_neighborhood,
        v_city,
        true,
        v_actor
      )
      returning * into v_customer;
    else
      update public.customers
      set full_name = v_name,
          document_type = v_document_type,
          document_number = v_document_number,
          document_number_normalized = v_document_normalized,
          email = coalesce(v_email, email),
          phone = coalesce(v_phone, phone),
          phone_normalized = coalesce(v_phone_normalized, phone_normalized),
          address = coalesce(v_address, address),
          neighborhood = coalesce(v_neighborhood, neighborhood),
          city = coalesce(v_city, city),
          active = true,
          updated_at = now()
      where id = v_customer.id
      returning * into v_customer;
    end if;
  exception when unique_violation then
    raise exception 'Customer document or phone is already assigned to another customer';
  end;

  v_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'id', v_customer.id,
    'name', v_customer.full_name,
    'documentType', v_customer.document_type,
    'documentNumber', v_customer.document_number,
    'email', v_customer.email,
    'phone', v_customer.phone,
    'address', v_customer.address,
    'neighborhood', v_customer.neighborhood,
    'city', v_customer.city
  ));

  update public.orders
  set customer_id = v_customer.id,
      customer_name = v_customer.full_name,
      updated_at = now()
  where id = any(v_order_ids);

  insert into public.order_invoice_customers (
    order_id,
    restaurant_id,
    customer_id,
    snapshot,
    created_by
  )
  select
    order_id,
    v_restaurant_id,
    v_customer.id,
    v_snapshot,
    v_actor
  from unnest(v_order_ids) as selected(order_id)
  on conflict (order_id)
  do update set
    customer_id = excluded.customer_id,
    snapshot = excluded.snapshot,
    updated_at = now();

  return private.record_order_payments(p_allocations, p_method);
end;
$$;

create or replace function public.record_order_payments(
  p_allocations jsonb,
  p_method text,
  p_invoice_customer jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.record_order_payments_with_customer(
    p_allocations,
    p_method,
    p_invoice_customer
  );
$$;

revoke all on function private.record_order_payments_with_customer(jsonb, text, jsonb) from public, anon;
grant execute on function private.record_order_payments_with_customer(jsonb, text, jsonb) to authenticated, service_role;
revoke all on function public.record_order_payments(jsonb, text, jsonb) from public, anon;
grant execute on function public.record_order_payments(jsonb, text, jsonb) to authenticated, service_role;

create or replace function public.list_paid_invoices(
  p_restaurant_id uuid,
  p_from date default null,
  p_to date default null,
  p_voided boolean default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.uid()) is null
     or not private.user_has_restaurant_permission(p_restaurant_id, 'reports.view') then
    raise exception 'No autorizado';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'invoiceNumber', q.invoice_number,
        'issuedAt', q.invoice_issued_at,
        'orderNumber', q.order_number,
        'subtotal', q.subtotal,
        'taxTotal', q.tax_total,
        'total', q.total,
        'paidTotal', q.paid_total,
        'voided', q.voided,
        'status', case when q.voided then 'voided' else 'valid' end,
        'serviceMode', q.service_mode,
        'serviceLabel', q.service_label,
        'tableIds', q.table_ids,
        'tables', q.tables,
        'customer', q.customer,
        'billingCustomer', q.billing_customer,
        'delivery', q.delivery,
        'items', q.items
      )
      order by q.invoice_issued_at desc
    ),
    '[]'::jsonb
  ) into result
  from (
    select
      o.id,
      o.invoice_number,
      o.invoice_issued_at,
      o.order_number,
      o.subtotal,
      o.tax_total,
      o.total,
      o.paid_total,
      (o.invoice_voided_at is not null) as voided,
      case when o.service_mode = 'counter' then 'quick' else o.service_mode end as service_mode,
      case
        when o.service_mode = 'table' then 'Mesa'
        when o.service_mode = 'counter' then 'Servicio rápido'
        when o.service_mode = 'delivery' then 'Domicilio'
        else coalesce(o.service_mode, 'Pedido')
      end as service_label,
      coalesce(
        (
          select jsonb_agg(to_jsonb(otl.table_id) order by otl.linked_at)
          from public.order_table_links otl
          where otl.order_id = o.id
        ),
        '[]'::jsonb
      ) as table_ids,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', dt.id,
              'code', dt.code,
              'name', coalesce(nullif(dt.name, ''), dt.code)
            ) order by otl.linked_at
          )
          from public.order_table_links otl
          join public.dining_tables dt on dt.id = otl.table_id
          where otl.order_id = o.id
        ),
        '[]'::jsonb
      ) as tables,
      case
        when o.customer_id is not null or o.customer_name is not null then jsonb_build_object(
          'id', o.customer_id,
          'name', coalesce(nullif(o.customer_name, ''), c.full_name),
          'phone', c.phone,
          'email', c.email
        )
        else null
      end as customer,
      oic.snapshot as billing_customer,
      o.delivery_details as delivery,
      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'name', i.product_name,
              'quantity', i.quantity,
              'unitPrice', i.unit_price,
              'taxRate', i.tax_rate,
              'amount', i.line_total
            ) order by i.created_at
          ),
          '[]'::jsonb
        )
        from public.order_items i
        where i.order_id = o.id
      ) as items
    from public.orders o
    left join public.order_invoice_customers oic on oic.order_id = o.id
    left join public.customers c on c.id = o.customer_id
    where o.restaurant_id = p_restaurant_id
      and o.payment_status = 'paid'
      and o.invoice_number is not null
      and (p_from is null or o.invoice_issued_at::date >= p_from)
      and (p_to is null or o.invoice_issued_at::date <= p_to)
      and (p_voided is null or (o.invoice_voided_at is not null) = p_voided)
  ) q;

  return result;
end;
$$;

revoke all on function public.list_paid_invoices(uuid, date, date, boolean) from public, anon;
grant execute on function public.list_paid_invoices(uuid, date, date, boolean) to authenticated, service_role;
