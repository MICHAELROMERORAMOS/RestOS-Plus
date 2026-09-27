alter table public.locations
  add column if not exists invoice_prefix text,
  add column if not exists next_invoice_number bigint not null default 1;

create or replace function private.normalize_invoice_prefix(p_value text)
returns text
language sql
immutable
set search_path=''
as $function$
  select left(regexp_replace(upper(coalesce(p_value,'')),'[^A-Z0-9]+','','g'),12);
$function$;

create or replace function private.assign_location_invoice_prefix()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_base text;
  v_candidate text;
  v_suffix integer := 1;
begin
  if nullif(btrim(coalesce(new.invoice_prefix,'')),'') is not null then
    new.invoice_prefix := private.normalize_invoice_prefix(new.invoice_prefix);
  else
    v_base := private.normalize_invoice_prefix(coalesce(nullif(new.code,''),new.name));
    if v_base='' then v_base:='BRANCH'; end if;
    v_candidate:=v_base;

    while exists (
      select 1
      from public.locations l
      where l.restaurant_id=new.restaurant_id
        and l.id is distinct from new.id
        and l.invoice_prefix=v_candidate
    ) loop
      v_suffix:=v_suffix+1;
      v_candidate:=left(v_base,greatest(1,12-length(v_suffix::text)))||v_suffix::text;
    end loop;

    new.invoice_prefix:=v_candidate;
  end if;

  if new.invoice_prefix='' then raise exception 'Invoice prefix cannot be empty'; end if;
  return new;
end;
$function$;

drop trigger if exists locations_assign_invoice_prefix on public.locations;
create trigger locations_assign_invoice_prefix
before insert or update of invoice_prefix on public.locations
for each row
execute function private.assign_location_invoice_prefix();

update public.locations
set invoice_prefix=null
where invoice_prefix is null or btrim(invoice_prefix)='';

alter table public.locations alter column invoice_prefix set not null;

create unique index if not exists locations_restaurant_invoice_prefix_key
  on public.locations(restaurant_id,invoice_prefix);

alter table public.locations drop constraint if exists locations_next_invoice_number_check;
alter table public.locations
  add constraint locations_next_invoice_number_check
  check (next_invoice_number>=1);

create or replace function private.allocate_branch_invoice_number(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_prefix text;
  v_next bigint;
begin
  select l.invoice_prefix,l.next_invoice_number
  into v_prefix,v_next
  from public.locations l
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
    and l.active=true
  for update;

  if not found then raise exception 'Invalid restaurant/location'; end if;

  update public.locations
  set next_invoice_number=v_next+1
  where id=p_location_id;

  return 'FAC-'||v_prefix||'-'||lpad(v_next::text,6,'0');
end;
$function$;

alter table public.sales_invoices
  drop constraint if exists sales_invoices_invoice_number_key;

alter table public.sales_invoices
  add constraint sales_invoices_restaurant_invoice_number_key
  unique (restaurant_id,invoice_number);

drop trigger if exists orders_assign_invoice_number on public.orders;

create or replace function private.assign_invoice_number()
returns trigger
language plpgsql
set search_path=''
as $function$
begin
  return new;
end;
$function$;

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
  select * into v_payment
  from public.payments
  where id=p_payment_id
  for update;

  if not found then raise exception 'Payment not found'; end if;

  select * into v_order
  from public.orders
  where id=v_payment.order_id
  for update;

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

  v_invoice_number:=private.allocate_branch_invoice_number(
    v_order.restaurant_id,
    v_order.location_id
  );

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

  select exists(
    select 1 from public.payment_allocations pa where pa.payment_id=v_payment.id
  ) into v_itemized;

  if v_itemized then
    insert into public.sales_invoice_items(
      invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount
    )
    select
      v_invoice_id,pa.order_item_id,coalesce(pa.item_name,oi.product_name),
      coalesce(pa.quantity,case when oi.unit_price>0 then pa.amount/oi.unit_price else 1 end),
      coalesce(pa.unit_price,oi.unit_price),coalesce(oi.tax_rate,0),pa.amount
    from public.payment_allocations pa
    join public.order_items oi on oi.id=pa.order_item_id
    where pa.payment_id=v_payment.id;
  else
    with invoiced as (
      select sii.order_item_id,
             coalesce(sum(sii.quantity) filter(where si.status='valid'),0) qty
      from public.sales_invoice_items sii
      join public.sales_invoices si on si.id=sii.invoice_id
      where si.order_id=v_order.id and sii.order_item_id is not null
      group by sii.order_item_id
    ), pending as (
      select oi.id,oi.product_name,
             greatest(oi.quantity-coalesce(inv.qty,0),0) qty,
             oi.unit_price,oi.tax_rate
      from public.order_items oi
      left join invoiced inv on inv.order_item_id=oi.id
      where oi.order_id=v_order.id
        and oi.status<>'cancelled'
        and greatest(oi.quantity-coalesce(inv.qty,0),0)>0
    )
    select coalesce(sum(round((qty*unit_price)::numeric,2)),0)
    into v_pending_amount
    from pending;

    if abs(v_pending_amount-v_payment.amount)<=0.01 and v_pending_amount>0 then
      insert into public.sales_invoice_items(
        invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount
      )
      with invoiced as (
        select sii.order_item_id,
               coalesce(sum(sii.quantity) filter(where si.status='valid'),0) qty
        from public.sales_invoice_items sii
        join public.sales_invoices si on si.id=sii.invoice_id
        where si.order_id=v_order.id and sii.order_item_id is not null
        group by sii.order_item_id
      )
      select
        v_invoice_id,oi.id,oi.product_name,
        greatest(oi.quantity-coalesce(inv.qty,0),0),
        oi.unit_price,oi.tax_rate,
        round((greatest(oi.quantity-coalesce(inv.qty,0),0)*oi.unit_price)::numeric,2)
      from public.order_items oi
      left join invoiced inv on inv.order_item_id=oi.id
      where oi.order_id=v_order.id
        and oi.status<>'cancelled'
        and greatest(oi.quantity-coalesce(inv.qty,0),0)>0;

      insert into public.payment_allocations(
        payment_id,order_item_id,amount,quantity,unit_price,item_name
      )
      select v_payment.id,sii.order_item_id,sii.amount,sii.quantity,sii.unit_price,sii.item_name
      from public.sales_invoice_items sii
      where sii.invoice_id=v_invoice_id
        and sii.order_item_id is not null
      on conflict(payment_id,order_item_id) do update
      set amount=excluded.amount,
          quantity=excluded.quantity,
          unit_price=excluded.unit_price,
          item_name=excluded.item_name;
    else
      insert into public.sales_invoice_items(
        invoice_id,order_item_id,item_name,quantity,unit_price,tax_rate,amount
      )
      values(v_invoice_id,null,'Abono a cuenta',1,v_payment.amount,0,v_payment.amount);
    end if;
  end if;

  select
    coalesce(sum(sii.amount),0),
    coalesce(sum((sii.amount*sii.tax_rate)/100.0),0)
  into v_subtotal,v_tax
  from public.sales_invoice_items sii
  where sii.invoice_id=v_invoice_id;

  update public.sales_invoices
  set subtotal=v_subtotal,
      tax_total=round(v_tax,2),
      total=v_payment.amount
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

drop sequence if exists private.invoice_number_seq;
