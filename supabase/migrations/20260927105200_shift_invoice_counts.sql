create or replace function private.shift_payload(p_shift_id uuid,p_as_of timestamptz default now())
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

  v_end:=case when v_shift.status='closed' then v_shift.closed_at else p_as_of end;

  if v_shift.status='closed' then
    v_sales:=v_shift.sales_total;
    v_payment_count:=v_shift.payment_count;
    v_cash:=v_shift.cash_total;
    v_card:=v_shift.card_total;
    v_transfer:=v_shift.transfer_total;
    v_other:=v_shift.other_total;
    v_refunds:=v_shift.refund_total;
    v_refund_count:=v_shift.refund_count;
    v_cash_refunds:=v_shift.cash_refund_total;
    v_card_refunds:=v_shift.card_refund_total;
    v_transfer_refunds:=v_shift.transfer_refund_total;
    v_other_refunds:=v_shift.other_refund_total;
    v_invoice_count:=v_shift.invoice_count;
    v_completed_orders:=v_shift.completed_order_count;
    v_blockers:=jsonb_build_object(
      'can_close',true,'pending_kitchen_bar_items',0,'unpaid_orders',0,'active_orders',0,
      'occupied_tables',0,'table_order_sessions',0,'quick_orders',0,'delivery_orders',0,'refund_due_orders',0
    );
  else
    select
      coalesce(sum(p.amount),0),count(*)::integer,
      coalesce(sum(p.amount) filter(where p.method='cash'),0),
      coalesce(sum(p.amount) filter(where p.method='card'),0),
      coalesce(sum(p.amount) filter(where p.method in ('transfer','bank','nequi')),0),
      coalesce(sum(p.amount) filter(where p.method not in ('cash','card','transfer','bank','nequi') or p.method is null),0)
    into v_sales,v_payment_count,v_cash,v_card,v_transfer,v_other
    from public.payments p
    where p.restaurant_id=v_shift.restaurant_id
      and p.location_id=v_shift.location_id
      and p.status='completed'
      and p.paid_at>=v_shift.opened_at and p.paid_at<v_end;

    select
      coalesce(sum(r.amount),0),count(*)::integer,
      coalesce(sum(r.amount) filter(where r.method='cash'),0),
      coalesce(sum(r.amount) filter(where r.method='card'),0),
      coalesce(sum(r.amount) filter(where r.method in ('transfer','nequi')),0),
      coalesce(sum(r.amount) filter(where r.method not in ('cash','card','transfer','nequi') or r.method is null),0)
    into v_refunds,v_refund_count,v_cash_refunds,v_card_refunds,v_transfer_refunds,v_other_refunds
    from public.order_refunds r
    where r.restaurant_id=v_shift.restaurant_id
      and r.location_id=v_shift.location_id
      and r.status='completed'
      and r.processed_at>=v_shift.opened_at and r.processed_at<v_end;

    select count(*)::integer into v_invoice_count
    from public.sales_invoices si
    where si.restaurant_id=v_shift.restaurant_id
      and si.location_id=v_shift.location_id
      and si.issued_at>=v_shift.opened_at and si.issued_at<v_end;

    select count(*)::integer into v_completed_orders
    from public.orders o
    where o.restaurant_id=v_shift.restaurant_id
      and o.location_id=v_shift.location_id
      and o.status='closed'
      and o.closed_at>=v_shift.opened_at and o.closed_at<v_end;

    v_blockers:=private.shift_blockers(v_shift.location_id);
  end if;

  select coalesce(nullif(btrim(p.full_name),''),nullif(btrim(p.username::text),''),split_part(p.email::text,'@',1))
  into v_opened_by_name from public.profiles p where p.id=v_shift.opened_by;
  select coalesce(nullif(btrim(p.full_name),''),nullif(btrim(p.username::text),''),split_part(p.email::text,'@',1))
  into v_closed_by_name from public.profiles p where p.id=v_shift.closed_by;

  return jsonb_build_object(
    'id',v_shift.id,'shift_number',v_shift.shift_number,'status',v_shift.status,
    'opened_at',v_shift.opened_at,'opened_by_name',coalesce(v_opened_by_name,'Inicio automático'),
    'closed_at',v_shift.closed_at,'closed_by_name',v_closed_by_name,'close_note',v_shift.close_note,
    'sales_total',v_sales,'refund_total',v_refunds,'net_sales_total',v_sales-v_refunds,
    'payment_count',v_payment_count,'refund_count',v_refund_count,
    'cash_total',v_cash,'cash_refund_total',v_cash_refunds,
    'card_total',v_card,'card_refund_total',v_card_refunds,
    'transfer_total',v_transfer,'transfer_refund_total',v_transfer_refunds,
    'other_total',v_other,'other_refund_total',v_other_refunds,
    'invoice_count',v_invoice_count,'completed_order_count',v_completed_orders,'blockers',v_blockers
  );
end;
$function$;

create or replace function private.close_current_shift(
  p_restaurant_id uuid,p_location_id uuid,p_note text default null
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

  perform 1 from public.locations l
  where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  for update;
  if not found then raise exception 'Invalid restaurant/location'; end if;

  select * into v_shift
  from public.operational_shifts s
  where s.location_id=p_location_id and s.status='open'
  order by s.opened_at desc limit 1 for update;
  if not found then raise exception 'No open shift found'; end if;

  v_blockers:=private.shift_blockers(p_location_id);
  if not coalesce((v_blockers->>'can_close')::boolean,false) then
    raise exception 'SHIFT_HAS_PENDING_OPERATIONS' using detail=v_blockers::text;
  end if;

  select
    coalesce(sum(p.amount),0),count(*)::integer,
    coalesce(sum(p.amount) filter(where p.method='cash'),0),
    coalesce(sum(p.amount) filter(where p.method='card'),0),
    coalesce(sum(p.amount) filter(where p.method in ('transfer','bank','nequi')),0),
    coalesce(sum(p.amount) filter(where p.method not in ('cash','card','transfer','bank','nequi') or p.method is null),0)
  into v_sales,v_payment_count,v_cash,v_card,v_transfer,v_other
  from public.payments p
  where p.restaurant_id=p_restaurant_id and p.location_id=p_location_id
    and p.status='completed'
    and p.paid_at>=v_shift.opened_at and p.paid_at<v_closed_at;

  select
    coalesce(sum(r.amount),0),count(*)::integer,
    coalesce(sum(r.amount) filter(where r.method='cash'),0),
    coalesce(sum(r.amount) filter(where r.method='card'),0),
    coalesce(sum(r.amount) filter(where r.method in ('transfer','nequi')),0),
    coalesce(sum(r.amount) filter(where r.method not in ('cash','card','transfer','nequi') or r.method is null),0)
  into v_refunds,v_refund_count,v_cash_refunds,v_card_refunds,v_transfer_refunds,v_other_refunds
  from public.order_refunds r
  where r.restaurant_id=p_restaurant_id and r.location_id=p_location_id
    and r.status='completed'
    and r.processed_at>=v_shift.opened_at and r.processed_at<v_closed_at;

  select count(*)::integer into v_invoice_count
  from public.sales_invoices si
  where si.restaurant_id=p_restaurant_id and si.location_id=p_location_id
    and si.issued_at>=v_shift.opened_at and si.issued_at<v_closed_at;

  select count(*)::integer into v_completed_orders
  from public.orders o
  where o.restaurant_id=p_restaurant_id and o.location_id=p_location_id
    and o.status='closed'
    and o.closed_at>=v_shift.opened_at and o.closed_at<v_closed_at;

  update public.operational_shifts
  set status='closed',closed_at=v_closed_at,closed_by=v_user,
      close_note=nullif(btrim(coalesce(p_note,'')),''),
      sales_total=v_sales,payment_count=v_payment_count,
      cash_total=v_cash,card_total=v_card,transfer_total=v_transfer,other_total=v_other,
      refund_total=v_refunds,refund_count=v_refund_count,
      cash_refund_total=v_cash_refunds,card_refund_total=v_card_refunds,
      transfer_refund_total=v_transfer_refunds,other_refund_total=v_other_refunds,
      invoice_count=v_invoice_count,completed_order_count=v_completed_orders,
      updated_at=v_closed_at
  where id=v_shift.id;

  insert into public.operational_shifts(
    restaurant_id,location_id,shift_number,status,opened_at,opened_by,next_quick_turn
  )
  values(
    p_restaurant_id,p_location_id,v_shift.shift_number+1,'open',v_closed_at,v_user,1
  )
  returning id into v_new_shift_id;

  return jsonb_build_object(
    'closed_shift',private.shift_payload(v_shift.id,v_closed_at),
    'current_shift',private.shift_payload(v_new_shift_id,v_closed_at)
  );
end;
$function$;
