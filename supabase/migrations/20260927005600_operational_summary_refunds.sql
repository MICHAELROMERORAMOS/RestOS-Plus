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
  v_refunds_shift numeric := 0;
  v_net_sales_shift numeric := 0;
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

  select coalesce(sum(r.amount),0)
  into v_refunds_shift
  from public.order_refunds r
  where r.restaurant_id=p_restaurant_id
    and r.location_id=p_location_id
    and r.status='completed'
    and r.processed_at>=v_shift_start
    and r.processed_at<now();

  v_net_sales_shift := v_sales_shift-v_refunds_shift;

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
    'refunds_shift',v_refunds_shift,
    'net_sales_shift',v_net_sales_shift,
    'shift_number',v_shift_number,
    'shift_opened_at',v_shift_start,
    'completed_orders_today',v_completed_today,
    'table_releases',v_table_releases
  );
end;
$function$;
