create table if not exists public.order_refunds (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('cash','card','transfer','other')),
  reference text,
  note text,
  status text not null default 'completed' check (status in ('completed','reversed')),
  processed_by uuid references public.profiles(id) on delete set null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists order_refunds_location_processed_idx
  on public.order_refunds(location_id,processed_at desc);
create index if not exists order_refunds_order_idx
  on public.order_refunds(order_id);
create index if not exists order_refunds_processed_by_idx
  on public.order_refunds(processed_by);

alter table public.order_refunds enable row level security;

revoke all on table public.order_refunds from anon;
revoke insert,update,delete on table public.order_refunds from authenticated;
grant select on table public.order_refunds to authenticated;

drop policy if exists order_refunds_read_location on public.order_refunds;
create policy order_refunds_read_location
on public.order_refunds
for select
to authenticated
using (private.can_read_operational_location(location_id));

create or replace function private.process_order_refund(
  p_order_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_amount numeric(14,2) := round(coalesce(p_amount,0),2);
  v_method text := lower(btrim(coalesce(p_method,'')));
  v_refund_id uuid;
  v_remaining numeric(14,2);
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;

  if not private.user_has_location_permission(v_order.location_id,'payments.create') then
    raise exception 'Not allowed to process refunds';
  end if;

  if coalesce(v_order.refund_due,0) <= 0.005 then
    raise exception 'This order has no pending refund';
  end if;

  if v_order.account_voided_at is null and v_order.invoice_voided_at is null then
    raise exception 'Refund is only allowed for a voided account or invoice';
  end if;

  if v_amount <= 0 then raise exception 'Refund amount must be greater than zero'; end if;
  if v_amount > coalesce(v_order.refund_due,0) + 0.005 then
    raise exception 'Refund amount exceeds pending refund';
  end if;

  if v_method not in ('cash','card','transfer','other') then
    raise exception 'Invalid refund method';
  end if;

  insert into public.order_refunds(
    restaurant_id,location_id,order_id,amount,method,reference,note,processed_by
  )
  values(
    v_order.restaurant_id,v_order.location_id,v_order.id,v_amount,v_method,
    nullif(btrim(coalesce(p_reference,'')),''),
    nullif(btrim(coalesce(p_note,'')),''),
    v_user
  )
  returning id into v_refund_id;

  v_remaining := greatest(coalesce(v_order.refund_due,0)-v_amount,0);

  update public.orders
  set refund_due=v_remaining,
      updated_at=now()
  where id=v_order.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_order.restaurant_id,
    v_user,
    'order_refund',
    v_refund_id,
    'refund_processed',
    jsonb_build_object(
      'orderId',v_order.id,
      'orderNumber',v_order.order_number,
      'invoiceNumber',v_order.invoice_number,
      'amount',v_amount,
      'method',v_method,
      'reference',nullif(btrim(coalesce(p_reference,'')),''),
      'remainingRefund',v_remaining
    )
  );

  return jsonb_build_object(
    'ok',true,
    'refund_id',v_refund_id,
    'order_id',v_order.id,
    'order_number',v_order.order_number,
    'invoice_number',v_order.invoice_number,
    'amount',v_amount,
    'remaining_refund',v_remaining
  );
end;
$function$;

create or replace function public.process_order_refund(
  p_order_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_note text default null
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.process_order_refund(p_order_id,p_amount,p_method,p_reference,p_note);
$function$;

revoke all on function public.process_order_refund(uuid,numeric,text,text,text) from public,anon;
grant execute on function public.process_order_refund(uuid,numeric,text,text,text) to authenticated;
revoke all on function private.process_order_refund(uuid,numeric,text,text,text) from public,anon;
grant execute on function private.process_order_refund(uuid,numeric,text,text,text) to authenticated;

alter table public.operational_shifts
  add column if not exists refund_total numeric(14,2) not null default 0,
  add column if not exists refund_count integer not null default 0,
  add column if not exists cash_refund_total numeric(14,2) not null default 0,
  add column if not exists card_refund_total numeric(14,2) not null default 0,
  add column if not exists transfer_refund_total numeric(14,2) not null default 0,
  add column if not exists other_refund_total numeric(14,2) not null default 0;

create or replace function private.shift_payload(
  p_shift_id uuid,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_shift public.operational_shifts%rowtype;
  v_end timestamptz;
  v_sales numeric := 0;
  v_payment_count integer := 0;
  v_cash numeric := 0;
  v_card numeric := 0;
  v_transfer numeric := 0;
  v_other numeric := 0;
  v_refunds numeric := 0;
  v_refund_count integer := 0;
  v_cash_refunds numeric := 0;
  v_card_refunds numeric := 0;
  v_transfer_refunds numeric := 0;
  v_other_refunds numeric := 0;
  v_invoice_count integer := 0;
  v_completed_orders integer := 0;
  v_opened_by_name text;
  v_closed_by_name text;
  v_blockers jsonb;
begin
  select * into v_shift from public.operational_shifts where id=p_shift_id;
  if not found then raise exception 'Shift not found'; end if;

  v_end := case when v_shift.status='closed' then v_shift.closed_at else p_as_of end;

  if v_shift.status='closed' then
    v_sales := v_shift.sales_total;
    v_payment_count := v_shift.payment_count;
    v_cash := v_shift.cash_total;
    v_card := v_shift.card_total;
    v_transfer := v_shift.transfer_total;
    v_other := v_shift.other_total;
    v_refunds := v_shift.refund_total;
    v_refund_count := v_shift.refund_count;
    v_cash_refunds := v_shift.cash_refund_total;
    v_card_refunds := v_shift.card_refund_total;
    v_transfer_refunds := v_shift.transfer_refund_total;
    v_other_refunds := v_shift.other_refund_total;
    v_invoice_count := v_shift.invoice_count;
    v_completed_orders := v_shift.completed_order_count;
    v_blockers := jsonb_build_object(
      'can_close',true,
      'pending_kitchen_bar_items',0,
      'unpaid_orders',0,
      'active_orders',0,
      'occupied_tables',0,
      'table_order_sessions',0,
      'quick_orders',0,
      'delivery_orders',0,
      'refund_due_orders',0
    );
  else
    select
      coalesce(sum(p.amount),0),
      count(*)::integer,
      coalesce(sum(p.amount) filter (where p.method='cash'),0),
      coalesce(sum(p.amount) filter (where p.method='card'),0),
      coalesce(sum(p.amount) filter (where p.method='transfer'),0),
      coalesce(sum(p.amount) filter (where p.method not in ('cash','card','transfer') or p.method is null),0)
    into v_sales,v_payment_count,v_cash,v_card,v_transfer,v_other
    from public.payments p
    where p.restaurant_id=v_shift.restaurant_id
      and p.location_id=v_shift.location_id
      and p.status='completed'
      and p.paid_at>=v_shift.opened_at
      and p.paid_at<v_end;

    select
      coalesce(sum(r.amount),0),
      count(*)::integer,
      coalesce(sum(r.amount) filter (where r.method='cash'),0),
      coalesce(sum(r.amount) filter (where r.method='card'),0),
      coalesce(sum(r.amount) filter (where r.method='transfer'),0),
      coalesce(sum(r.amount) filter (where r.method='other'),0)
    into v_refunds,v_refund_count,v_cash_refunds,v_card_refunds,v_transfer_refunds,v_other_refunds
    from public.order_refunds r
    where r.restaurant_id=v_shift.restaurant_id
      and r.location_id=v_shift.location_id
      and r.status='completed'
      and r.processed_at>=v_shift.opened_at
      and r.processed_at<v_end;

    select count(*)::integer into v_invoice_count
    from public.orders o
    where o.restaurant_id=v_shift.restaurant_id
      and o.location_id=v_shift.location_id
      and o.invoice_number is not null
      and o.invoice_issued_at>=v_shift.opened_at
      and o.invoice_issued_at<v_end;

    select count(*)::integer into v_completed_orders
    from public.orders o
    where o.restaurant_id=v_shift.restaurant_id
      and o.location_id=v_shift.location_id
      and o.status='closed'
      and o.closed_at>=v_shift.opened_at
      and o.closed_at<v_end;

    v_blockers := private.shift_blockers(v_shift.location_id);
  end if;

  select coalesce(nullif(btrim(p.full_name),''),nullif(btrim(p.username::text),''),split_part(p.email::text,'@',1))
  into v_opened_by_name
  from public.profiles p where p.id=v_shift.opened_by;

  select coalesce(nullif(btrim(p.full_name),''),nullif(btrim(p.username::text),''),split_part(p.email::text,'@',1))
  into v_closed_by_name
  from public.profiles p where p.id=v_shift.closed_by;

  return jsonb_build_object(
    'id',v_shift.id,
    'shift_number',v_shift.shift_number,
    'status',v_shift.status,
    'opened_at',v_shift.opened_at,
    'opened_by_name',coalesce(v_opened_by_name,'Inicio automático'),
    'closed_at',v_shift.closed_at,
    'closed_by_name',v_closed_by_name,
    'close_note',v_shift.close_note,
    'sales_total',v_sales,
    'refund_total',v_refunds,
    'net_sales_total',v_sales-v_refunds,
    'payment_count',v_payment_count,
    'refund_count',v_refund_count,
    'cash_total',v_cash,
    'cash_refund_total',v_cash_refunds,
    'card_total',v_card,
    'card_refund_total',v_card_refunds,
    'transfer_total',v_transfer,
    'transfer_refund_total',v_transfer_refunds,
    'other_total',v_other,
    'other_refund_total',v_other_refunds,
    'invoice_count',v_invoice_count,
    'completed_order_count',v_completed_orders,
    'blockers',v_blockers
  );
end;
$function$;

create or replace function private.close_current_shift(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_shift public.operational_shifts%rowtype;
  v_closed_at timestamptz := clock_timestamp();
  v_blockers jsonb;
  v_sales numeric := 0;
  v_payment_count integer := 0;
  v_cash numeric := 0;
  v_card numeric := 0;
  v_transfer numeric := 0;
  v_other numeric := 0;
  v_refunds numeric := 0;
  v_refund_count integer := 0;
  v_cash_refunds numeric := 0;
  v_card_refunds numeric := 0;
  v_transfer_refunds numeric := 0;
  v_other_refunds numeric := 0;
  v_invoice_count integer := 0;
  v_completed_orders integer := 0;
  v_new_shift_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'shifts.close') then
    raise exception 'Not allowed to close shifts';
  end if;

  perform 1
  from public.locations l
  where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  for update;

  if not found then raise exception 'Invalid restaurant/location'; end if;

  select * into v_shift
  from public.operational_shifts s
  where s.location_id=p_location_id and s.status='open'
  order by s.opened_at desc
  limit 1
  for update;

  if not found then raise exception 'No open shift found'; end if;

  v_blockers := private.shift_blockers(p_location_id);
  if not coalesce((v_blockers->>'can_close')::boolean,false) then
    raise exception 'SHIFT_HAS_PENDING_OPERATIONS'
      using detail=v_blockers::text;
  end if;

  select
    coalesce(sum(p.amount),0),
    count(*)::integer,
    coalesce(sum(p.amount) filter (where p.method='cash'),0),
    coalesce(sum(p.amount) filter (where p.method='card'),0),
    coalesce(sum(p.amount) filter (where p.method='transfer'),0),
    coalesce(sum(p.amount) filter (where p.method not in ('cash','card','transfer') or p.method is null),0)
  into v_sales,v_payment_count,v_cash,v_card,v_transfer,v_other
  from public.payments p
  where p.restaurant_id=p_restaurant_id
    and p.location_id=p_location_id
    and p.status='completed'
    and p.paid_at>=v_shift.opened_at
    and p.paid_at<v_closed_at;

  select
    coalesce(sum(r.amount),0),
    count(*)::integer,
    coalesce(sum(r.amount) filter (where r.method='cash'),0),
    coalesce(sum(r.amount) filter (where r.method='card'),0),
    coalesce(sum(r.amount) filter (where r.method='transfer'),0),
    coalesce(sum(r.amount) filter (where r.method='other'),0)
  into v_refunds,v_refund_count,v_cash_refunds,v_card_refunds,v_transfer_refunds,v_other_refunds
  from public.order_refunds r
  where r.restaurant_id=p_restaurant_id
    and r.location_id=p_location_id
    and r.status='completed'
    and r.processed_at>=v_shift.opened_at
    and r.processed_at<v_closed_at;

  select count(*)::integer into v_invoice_count
  from public.orders o
  where o.restaurant_id=p_restaurant_id
    and o.location_id=p_location_id
    and o.invoice_number is not null
    and o.invoice_issued_at>=v_shift.opened_at
    and o.invoice_issued_at<v_closed_at;

  select count(*)::integer into v_completed_orders
  from public.orders o
  where o.restaurant_id=p_restaurant_id
    and o.location_id=p_location_id
    and o.status='closed'
    and o.closed_at>=v_shift.opened_at
    and o.closed_at<v_closed_at;

  update public.operational_shifts
  set
    status='closed',
    closed_at=v_closed_at,
    closed_by=v_user,
    close_note=nullif(btrim(coalesce(p_note,'')),''),
    sales_total=v_sales,
    payment_count=v_payment_count,
    cash_total=v_cash,
    card_total=v_card,
    transfer_total=v_transfer,
    other_total=v_other,
    refund_total=v_refunds,
    refund_count=v_refund_count,
    cash_refund_total=v_cash_refunds,
    card_refund_total=v_card_refunds,
    transfer_refund_total=v_transfer_refunds,
    other_refund_total=v_other_refunds,
    invoice_count=v_invoice_count,
    completed_order_count=v_completed_orders,
    updated_at=v_closed_at
  where id=v_shift.id;

  insert into public.operational_shifts(
    restaurant_id,location_id,shift_number,status,opened_at,opened_by
  )
  values(p_restaurant_id,p_location_id,v_shift.shift_number+1,'open',v_closed_at,v_user)
  returning id into v_new_shift_id;

  return jsonb_build_object(
    'closed_shift',private.shift_payload(v_shift.id,v_closed_at),
    'current_shift',private.shift_payload(v_new_shift_id,v_closed_at)
  );
end;
$function$;
