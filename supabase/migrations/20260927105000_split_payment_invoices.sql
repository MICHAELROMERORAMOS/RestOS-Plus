alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in ('cash','card','transfer','nequi','bank','voucher','other'));

alter table public.order_refunds drop constraint if exists order_refunds_method_check;
alter table public.order_refunds
  add constraint order_refunds_method_check
  check (method in ('cash','card','transfer','nequi','other'));

create table if not exists public.sales_invoices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  invoice_number text not null unique,
  issued_at timestamptz not null default now(),
  billing_customer jsonb,
  subtotal numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  status text not null default 'valid' check (status in ('valid','voided')),
  legacy_order_invoice boolean not null default false,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.sales_invoices(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  item_name text not null,
  quantity numeric(12,3) not null default 1,
  unit_price numeric(14,2) not null default 0,
  tax_rate numeric(8,4) not null default 0,
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sales_invoice_payments (
  invoice_id uuid not null references public.sales_invoices(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  primary key(invoice_id,payment_id),
  unique(payment_id)
);

create index if not exists sales_invoices_restaurant_issued_idx on public.sales_invoices(restaurant_id,issued_at desc);
create index if not exists sales_invoices_location_issued_idx on public.sales_invoices(location_id,issued_at desc);
create index if not exists sales_invoices_order_idx on public.sales_invoices(order_id,issued_at);
create index if not exists sales_invoice_items_invoice_idx on public.sales_invoice_items(invoice_id);
create index if not exists sales_invoice_items_order_item_idx on public.sales_invoice_items(order_item_id) where order_item_id is not null;

alter table public.sales_invoices enable row level security;
alter table public.sales_invoice_items enable row level security;
alter table public.sales_invoice_payments enable row level security;

revoke all on public.sales_invoices from anon,authenticated;
revoke all on public.sales_invoice_items from anon,authenticated;
revoke all on public.sales_invoice_payments from anon,authenticated;

insert into public.sales_invoices(
  restaurant_id,location_id,order_id,invoice_number,issued_at,billing_customer,
  subtotal,tax_total,total,status,legacy_order_invoice,voided_at,created_by
)
select
  o.restaurant_id,o.location_id,o.id,o.invoice_number,
  coalesce(o.invoice_issued_at,o.closed_at,o.updated_at,now()),
  oic.snapshot,o.subtotal,o.tax_total,o.total,
  case when o.invoice_voided_at is null then 'valid' else 'voided' end,
  true,o.invoice_voided_at,o.closed_by
from public.orders o
left join public.order_invoice_customers oic on oic.order_id=o.id
where o.invoice_number is not null
  and not exists(select 1 from public.sales_invoices si where si.invoice_number=o.invoice_number);

insert into public.sales_invoice_items(invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount)
select si.id,oi.id,oi.product_name,oi.quantity,oi.unit_price,oi.tax_rate,oi.line_total
from public.sales_invoices si
join public.order_items oi on oi.order_id=si.order_id
where si.legacy_order_invoice=true
  and not exists(
    select 1 from public.sales_invoice_items sii
    where sii.invoice_id=si.id and sii.order_item_id=oi.id
  );

insert into public.sales_invoice_payments(invoice_id,payment_id)
select si.id,p.id
from public.sales_invoices si
join public.payments p on p.order_id=si.order_id
where si.legacy_order_invoice=true
  and p.status in ('completed','refunded')
  and not exists(select 1 from public.sales_invoice_payments sip where sip.payment_id=p.id);

create or replace function private.issue_payment_invoice(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_invoice_id uuid;
  v_invoice_number text;
  v_customer jsonb;
  v_existing jsonb;
  v_itemized boolean;
  v_pending_amount numeric(14,2);
  v_subtotal numeric(14,2);
  v_tax numeric(14,2);
begin
  select * into v_payment from public.payments where id=p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;

  select * into v_order from public.orders where id=v_payment.order_id for update;

  select jsonb_build_object(
    'id',si.id,'invoiceNumber',si.invoice_number,'issuedAt',si.issued_at,
    'orderId',si.order_id,'total',si.total
  )
  into v_existing
  from public.sales_invoice_payments sip
  join public.sales_invoices si on si.id=sip.invoice_id
  where sip.payment_id=v_payment.id;

  if v_existing is not null then return v_existing; end if;

  select oic.snapshot into v_customer
  from public.order_invoice_customers oic
  where oic.order_id=v_order.id;

  v_invoice_number := 'FAC-' || lpad(nextval('private.invoice_number_seq'::regclass)::text,6,'0');

  insert into public.sales_invoices(
    restaurant_id,location_id,order_id,invoice_number,issued_at,billing_customer,
    subtotal,tax_total,total,status,legacy_order_invoice,created_by
  )
  values(
    v_order.restaurant_id,v_order.location_id,v_order.id,v_invoice_number,now(),v_customer,
    v_payment.amount,0,v_payment.amount,'valid',false,v_payment.received_by
  )
  returning id into v_invoice_id;

  insert into public.sales_invoice_payments(invoice_id,payment_id)
  values(v_invoice_id,v_payment.id);

  select exists(select 1 from public.payment_allocations pa where pa.payment_id=v_payment.id)
  into v_itemized;

  if v_itemized then
    insert into public.sales_invoice_items(invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount)
    select
      v_invoice_id,pa.order_item_id,coalesce(pa.item_name,oi.product_name),
      coalesce(pa.quantity,case when oi.unit_price>0 then pa.amount/oi.unit_price else 1 end),
      coalesce(pa.unit_price,oi.unit_price),coalesce(oi.tax_rate,0),pa.amount
    from public.payment_allocations pa
    join public.order_items oi on oi.id=pa.order_item_id
    where pa.payment_id=v_payment.id;
  else
    with invoiced as (
      select sii.order_item_id,coalesce(sum(sii.quantity) filter(where si.status='valid'),0) qty
      from public.sales_invoice_items sii
      join public.sales_invoices si on si.id=sii.invoice_id
      where si.order_id=v_order.id and sii.order_item_id is not null
      group by sii.order_item_id
    ), pending as (
      select oi.id,oi.product_name,greatest(oi.quantity-coalesce(inv.qty,0),0) qty,oi.unit_price,oi.tax_rate
      from public.order_items oi
      left join invoiced inv on inv.order_item_id=oi.id
      where oi.order_id=v_order.id and oi.status<>'cancelled'
        and greatest(oi.quantity-coalesce(inv.qty,0),0)>0
    )
    select coalesce(sum(round((qty*unit_price)::numeric,2)),0)
    into v_pending_amount from pending;

    if abs(v_pending_amount-v_payment.amount)<=0.01 and v_pending_amount>0 then
      insert into public.sales_invoice_items(invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount)
      with invoiced as (
        select sii.order_item_id,coalesce(sum(sii.quantity) filter(where si.status='valid'),0) qty
        from public.sales_invoice_items sii
        join public.sales_invoices si on si.id=sii.invoice_id
        where si.order_id=v_order.id and sii.order_item_id is not null
        group by sii.order_item_id
      )
      select
        v_invoice_id,oi.id,oi.product_name,greatest(oi.quantity-coalesce(inv.qty,0),0),
        oi.unit_price,oi.tax_rate,
        round((greatest(oi.quantity-coalesce(inv.qty,0),0)*oi.unit_price)::numeric,2)
      from public.order_items oi
      left join invoiced inv on inv.order_item_id=oi.id
      where oi.order_id=v_order.id and oi.status<>'cancelled'
        and greatest(oi.quantity-coalesce(inv.qty,0),0)>0;

      insert into public.payment_allocations(payment_id,order_item_id,amount,quantity,unit_price,item_name)
      select v_payment.id,sii.order_item_id,sii.amount,sii.quantity,sii.unit_price,sii.item_name
      from public.sales_invoice_items sii
      where sii.invoice_id=v_invoice_id and sii.order_item_id is not null
      on conflict(payment_id,order_item_id) do update
      set amount=excluded.amount,quantity=excluded.quantity,unit_price=excluded.unit_price,item_name=excluded.item_name;
    else
      insert into public.sales_invoice_items(invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount)
      values(v_invoice_id,null,'Abono a cuenta',1,v_payment.amount,0,v_payment.amount);
    end if;
  end if;

  select coalesce(sum(sii.amount),0),coalesce(sum((sii.amount*sii.tax_rate)/100.0),0)
  into v_subtotal,v_tax
  from public.sales_invoice_items sii where sii.invoice_id=v_invoice_id;

  update public.sales_invoices
  set subtotal=v_subtotal,tax_total=round(v_tax,2),total=v_payment.amount
  where id=v_invoice_id;

  update public.orders
  set invoice_number=coalesce(invoice_number,v_invoice_number),
      invoice_issued_at=coalesce(invoice_issued_at,now())
  where id=v_order.id;

  return jsonb_build_object(
    'id',v_invoice_id,'invoiceNumber',v_invoice_number,'issuedAt',now(),
    'orderId',v_order.id,'orderNumber',v_order.order_number,'total',v_payment.amount
  );
end;
$function$;

create or replace function public.list_paid_invoices(
  p_restaurant_id uuid,p_from date default null,p_to date default null,p_voided boolean default null
)
returns jsonb
language plpgsql
set search_path=''
as $function$
declare result jsonb;
begin
  if (select auth.uid()) is null
     or not private.user_has_restaurant_permission(p_restaurant_id,'reports.view') then
    raise exception 'No autorizado';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',q.id,'invoiceNumber',q.invoice_number,'issuedAt',q.issued_at,
      'orderNumber',q.order_number,'subtotal',q.subtotal,'taxTotal',q.tax_total,
      'total',q.total,'paidTotal',q.total,'voided',q.voided,
      'status',case when q.voided then 'voided' else 'valid' end,
      'serviceMode',q.service_mode,'serviceLabel',q.service_label,
      'tableIds',q.table_ids,'tables',q.tables,'customer',q.customer,
      'billingCustomer',q.billing_customer,'delivery',q.delivery,
      'items',q.items,'payments',q.payments
    ) order by q.issued_at desc
  ),'[]'::jsonb)
  into result
  from (
    select
      si.id,si.invoice_number,si.issued_at,o.order_number,si.subtotal,si.tax_total,si.total,
      si.status='voided' voided,
      case when o.service_mode='counter' then 'quick' else o.service_mode end service_mode,
      case when o.service_mode='table' then 'Mesa'
           when o.service_mode='counter' then 'Servicio rápido'
           when o.service_mode='delivery' then 'Domicilio'
           else coalesce(o.service_mode,'Pedido') end service_label,
      coalesce((select jsonb_agg(to_jsonb(otl.table_id) order by otl.linked_at)
                from public.order_table_links otl where otl.order_id=o.id),'[]'::jsonb) table_ids,
      coalesce((select jsonb_agg(jsonb_build_object(
                  'id',dt.id,'code',dt.code,'name',coalesce(nullif(dt.name,''),dt.code)
                ) order by otl.linked_at)
                from public.order_table_links otl
                join public.dining_tables dt on dt.id=otl.table_id
                where otl.order_id=o.id),'[]'::jsonb) tables,
      case when o.customer_id is not null or o.customer_name is not null then
        jsonb_build_object('id',o.customer_id,'name',coalesce(nullif(o.customer_name,''),c.full_name),
                           'phone',c.phone,'email',c.email)
      else null end customer,
      si.billing_customer,o.delivery_details delivery,
      coalesce((select jsonb_agg(jsonb_build_object(
                  'name',sii.item_name,'quantity',sii.quantity,'unitPrice',sii.unit_price,
                  'taxRate',sii.tax_rate,'amount',sii.amount
                ) order by sii.created_at)
                from public.sales_invoice_items sii where sii.invoice_id=si.id),'[]'::jsonb) items,
      coalesce((select jsonb_agg(jsonb_build_object(
                  'id',p.id,'method',p.method,'amount',p.amount,'paidAt',p.paid_at,'reference',p.reference
                ) order by p.paid_at)
                from public.sales_invoice_payments sip
                join public.payments p on p.id=sip.payment_id
                where sip.invoice_id=si.id),'[]'::jsonb) payments
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
$function$;
