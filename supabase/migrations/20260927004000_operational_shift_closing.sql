insert into public.permissions(code,module,description)
values
  ('shifts.view','shifts','Ver el turno operativo actual y cierres anteriores'),
  ('shifts.close','shifts','Cerrar el turno operativo y abrir el siguiente')
on conflict (code) do update
set module=excluded.module, description=excluded.description;

insert into public.role_permissions(role_id, permission_code)
select r.id, p.permission_code
from public.roles r
cross join (values ('shifts.view'),('shifts.close')) as p(permission_code)
where r.name in ('Owner / Super Admin','Manager / Supervisor','Cashier / Caja')
on conflict do nothing;

create table if not exists public.operational_shifts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  shift_number bigint not null,
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  opened_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  close_note text,
  sales_total numeric(14,2) not null default 0,
  payment_count integer not null default 0,
  cash_total numeric(14,2) not null default 0,
  card_total numeric(14,2) not null default 0,
  transfer_total numeric(14,2) not null default 0,
  other_total numeric(14,2) not null default 0,
  invoice_count integer not null default 0,
  completed_order_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(location_id, shift_number)
);

create unique index if not exists operational_shifts_one_open_per_location
  on public.operational_shifts(location_id)
  where status='open';

create index if not exists operational_shifts_restaurant_location_closed_idx
  on public.operational_shifts(restaurant_id,location_id,closed_at desc);

create index if not exists operational_shifts_opened_by_idx
  on public.operational_shifts(opened_by);

create index if not exists operational_shifts_closed_by_idx
  on public.operational_shifts(closed_by);

alter table public.operational_shifts enable row level security;

revoke all on table public.operational_shifts from anon;
revoke insert,update,delete on table public.operational_shifts from authenticated;
grant select on table public.operational_shifts to authenticated;

drop policy if exists operational_shifts_read_location on public.operational_shifts;
create policy operational_shifts_read_location
on public.operational_shifts
for select
to authenticated
using (private.can_read_operational_location(location_id));

insert into public.operational_shifts(
  restaurant_id,location_id,shift_number,status,opened_at,opened_by
)
select
  l.restaurant_id,
  l.id,
  1,
  'open',
  date_trunc(
    'day',
    now() at time zone coalesce(nullif(btrim(r.timezone),''),'America/Bogota')
  ) at time zone coalesce(nullif(btrim(r.timezone),''),'America/Bogota'),
  null
from public.locations l
join public.restaurants r on r.id=l.restaurant_id
where l.active=true
  and not exists (
    select 1 from public.operational_shifts s where s.location_id=l.id
  );

create or replace function private.shift_blockers(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_pending_items integer := 0;
  v_unpaid_orders integer := 0;
  v_active_orders integer := 0;
  v_occupied_tables integer := 0;
  v_table_sessions integer := 0;
  v_quick_orders integer := 0;
  v_delivery_orders integer := 0;
  v_refund_orders integer := 0;
begin
  select count(*)::integer
  into v_pending_items
  from public.order_items oi
  join public.orders o on o.id=oi.order_id
  where o.location_id=p_location_id
    and o.status not in ('cancelled','merged')
    and oi.status not in ('served','cancelled');

  select count(*)::integer
  into v_unpaid_orders
  from public.orders o
  where o.location_id=p_location_id
    and o.status not in ('closed','cancelled','merged')
    and greatest(coalesce(o.total,0)-coalesce(o.paid_total,0),0) > 0.005;

  select count(*)::integer
  into v_active_orders
  from public.orders o
  where o.location_id=p_location_id
    and o.status not in ('closed','cancelled','merged');

  select count(distinct otl.table_id)::integer
  into v_occupied_tables
  from public.order_table_links otl
  join public.orders o on o.id=otl.order_id
  where o.location_id=p_location_id
    and otl.unlinked_at is null
    and o.status not in ('closed','cancelled','merged');

  select count(*)::integer
  into v_table_sessions
  from public.table_order_sessions s
  where s.location_id=p_location_id
    and s.last_seen_at >= now()-interval '5 minutes';

  select count(*)::integer
  into v_quick_orders
  from public.orders o
  where o.location_id=p_location_id
    and o.service_mode='counter'
    and o.status not in ('closed','cancelled','merged');

  select count(*)::integer
  into v_delivery_orders
  from public.orders o
  where o.location_id=p_location_id
    and o.service_mode='delivery'
    and o.status not in ('closed','cancelled','merged');

  select count(*)::integer
  into v_refund_orders
  from public.orders o
  where o.location_id=p_location_id
    and coalesce(o.refund_due,0) > 0.005;

  return jsonb_build_object(
    'can_close',
      v_pending_items=0
      and v_unpaid_orders=0
      and v_active_orders=0
      and v_occupied_tables=0
      and v_table_sessions=0
      and v_quick_orders=0
      and v_delivery_orders=0
      and v_refund_orders=0,
    'pending_kitchen_bar_items',v_pending_items,
    'unpaid_orders',v_unpaid_orders,
    'active_orders',v_active_orders,
    'occupied_tables',v_occupied_tables,
    'table_order_sessions',v_table_sessions,
    'quick_orders',v_quick_orders,
    'delivery_orders',v_delivery_orders,
    'refund_due_orders',v_refund_orders
  );
end;
$function$;

create or replace function private.ensure_current_shift(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_shift_id uuid;
  v_next_number bigint;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'shifts.view') then
    raise exception 'Not allowed to view shifts';
  end if;

  perform 1
  from public.locations l
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
    and l.active=true
  for update;

  if not found then raise exception 'Invalid restaurant/location'; end if;

  select s.id into v_shift_id
  from public.operational_shifts s
  where s.location_id=p_location_id and s.status='open'
  order by s.opened_at desc
  limit 1
  for update;

  if v_shift_id is not null then return v_shift_id; end if;

  select coalesce(max(s.shift_number),0)+1
  into v_next_number
  from public.operational_shifts s
  where s.location_id=p_location_id;

  insert into public.operational_shifts(
    restaurant_id,location_id,shift_number,status,opened_at,opened_by
  )
  values(p_restaurant_id,p_location_id,v_next_number,'open',now(),v_user)
  returning id into v_shift_id;

  return v_shift_id;
end;
$function$;

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
  v_invoice_count integer := 0;
  v_completed_orders integer := 0;
  v_opened_by_name text;
  v_closed_by_name text;
  v_blockers jsonb;
begin
  select * into v_shift
  from public.operational_shifts
  where id=p_shift_id;

  if not found then raise exception 'Shift not found'; end if;

  v_end := case when v_shift.status='closed' then v_shift.closed_at else p_as_of end;

  if v_shift.status='closed' then
    v_sales := v_shift.sales_total;
    v_payment_count := v_shift.payment_count;
    v_cash := v_shift.cash_total;
    v_card := v_shift.card_total;
    v_transfer := v_shift.transfer_total;
    v_other := v_shift.other_total;
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

    select count(*)::integer
    into v_invoice_count
    from public.orders o
    where o.restaurant_id=v_shift.restaurant_id
      and o.location_id=v_shift.location_id
      and o.invoice_number is not null
      and o.invoice_issued_at>=v_shift.opened_at
      and o.invoice_issued_at<v_end;

    select count(*)::integer
    into v_completed_orders
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
  from public.profiles p
  where p.id=v_shift.opened_by;

  select coalesce(nullif(btrim(p.full_name),''),nullif(btrim(p.username::text),''),split_part(p.email::text,'@',1))
  into v_closed_by_name
  from public.profiles p
  where p.id=v_shift.closed_by;

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
    'payment_count',v_payment_count,
    'cash_total',v_cash,
    'card_total',v_card,
    'transfer_total',v_transfer,
    'other_total',v_other,
    'invoice_count',v_invoice_count,
    'completed_order_count',v_completed_orders,
    'blockers',v_blockers
  );
end;
$function$;

create or replace function private.get_current_shift(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_shift_id uuid;
begin
  v_shift_id := private.ensure_current_shift(p_restaurant_id,p_location_id);
  return private.shift_payload(v_shift_id,now());
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
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
    and l.active=true
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
    invoice_count=v_invoice_count,
    completed_order_count=v_completed_orders,
    updated_at=v_closed_at
  where id=v_shift.id;

  insert into public.operational_shifts(
    restaurant_id,location_id,shift_number,status,opened_at,opened_by
  )
  values(
    p_restaurant_id,p_location_id,v_shift.shift_number+1,'open',v_closed_at,v_user
  )
  returning id into v_new_shift_id;

  return jsonb_build_object(
    'closed_shift',private.shift_payload(v_shift.id,v_closed_at),
    'current_shift',private.shift_payload(v_new_shift_id,v_closed_at)
  );
end;
$function$;

create or replace function private.load_shift_history(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'shifts.view') then
    raise exception 'Not allowed to view shifts';
  end if;

  select coalesce(
    jsonb_agg(private.shift_payload(x.id,x.closed_at) order by x.closed_at desc),
    '[]'::jsonb
  )
  into v_result
  from (
    select s.id,s.closed_at
    from public.operational_shifts s
    where s.restaurant_id=p_restaurant_id
      and s.location_id=p_location_id
      and s.status='closed'
    order by s.closed_at desc
    limit greatest(1,least(coalesce(p_limit,20),100))
  ) x;

  return v_result;
end;
$function$;

create or replace function public.get_current_shift(p_restaurant_id uuid,p_location_id uuid)
returns jsonb
language sql
set search_path=''
as $function$
  select private.get_current_shift(p_restaurant_id,p_location_id);
$function$;

create or replace function public.close_current_shift(
  p_restaurant_id uuid,p_location_id uuid,p_note text default null
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.close_current_shift(p_restaurant_id,p_location_id,p_note);
$function$;

create or replace function public.load_shift_history(
  p_restaurant_id uuid,p_location_id uuid,p_limit integer default 20
)
returns jsonb
language sql
stable
set search_path=''
as $function$
  select private.load_shift_history(p_restaurant_id,p_location_id,p_limit);
$function$;

revoke all on function public.get_current_shift(uuid,uuid) from public,anon;
revoke all on function public.close_current_shift(uuid,uuid,text) from public,anon;
revoke all on function public.load_shift_history(uuid,uuid,integer) from public,anon;
grant execute on function public.get_current_shift(uuid,uuid) to authenticated;
grant execute on function public.close_current_shift(uuid,uuid,text) to authenticated;
grant execute on function public.load_shift_history(uuid,uuid,integer) to authenticated;

grant execute on function private.get_current_shift(uuid,uuid) to authenticated;
grant execute on function private.close_current_shift(uuid,uuid,text) to authenticated;
grant execute on function private.load_shift_history(uuid,uuid,integer) to authenticated;
grant execute on function private.ensure_current_shift(uuid,uuid) to authenticated;

create or replace function private.load_operational_summary(p_restaurant_id uuid, p_location_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $function$
declare
  v_timezone text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_shift_start timestamptz;
  v_shift_number bigint;
  v_sales_today numeric := 0;
  v_sales_shift numeric := 0;
  v_completed_today integer := 0;
  v_table_releases jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;

  select coalesce(nullif(btrim(r.timezone),''),'America/Bogota')
  into v_timezone
  from public.locations l
  join public.restaurants r on r.id=l.restaurant_id
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
    and l.active=true;

  if v_timezone is null then raise exception 'Invalid restaurant/location'; end if;

  v_day_start := date_trunc('day',now() at time zone v_timezone) at time zone v_timezone;
  v_day_end := (date_trunc('day',now() at time zone v_timezone)+interval '1 day') at time zone v_timezone;

  select s.opened_at,s.shift_number
  into v_shift_start,v_shift_number
  from public.operational_shifts s
  where s.restaurant_id=p_restaurant_id
    and s.location_id=p_location_id
    and s.status='open'
  order by s.opened_at desc
  limit 1;

  v_shift_start := coalesce(v_shift_start,v_day_start);

  select coalesce(sum(p.amount),0)
  into v_sales_today
  from public.payments p
  where p.restaurant_id=p_restaurant_id
    and p.location_id=p_location_id
    and p.status='completed'
    and p.paid_at>=v_day_start
    and p.paid_at<v_day_end;

  select coalesce(sum(p.amount),0)
  into v_sales_shift
  from public.payments p
  where p.restaurant_id=p_restaurant_id
    and p.location_id=p_location_id
    and p.status='completed'
    and p.paid_at>=v_shift_start
    and p.paid_at<now();

  select count(*)::integer
  into v_completed_today
  from public.orders o
  where o.restaurant_id=p_restaurant_id
    and o.location_id=p_location_id
    and o.status='closed'
    and o.closed_at>=v_day_start
    and o.closed_at<v_day_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('table_id',released.table_id,'released_at',released.released_at)
      order by released.table_id
    ),
    '[]'::jsonb
  )
  into v_table_releases
  from (
    select otl.table_id,max(coalesce(otl.unlinked_at,o.closed_at)) as released_at
    from public.order_table_links otl
    join public.orders o on o.id=otl.order_id
    where o.restaurant_id=p_restaurant_id
      and o.location_id=p_location_id
      and (otl.unlinked_at is not null or o.closed_at is not null)
    group by otl.table_id
  ) released;

  return jsonb_build_object(
    'sales_today',v_sales_today,
    'sales_shift',v_sales_shift,
    'shift_number',v_shift_number,
    'shift_opened_at',v_shift_start,
    'completed_orders_today',v_completed_today,
    'table_releases',v_table_releases
  );
end;
$function$;
