alter table public.restaurant_settings
  add column if not exists separate_kitchen_bar boolean not null default true;

alter table public.restaurant_settings
  alter column pager_enabled set default true;

update public.restaurant_settings
set pager_enabled=true
where pager_enabled=false;

alter table public.operational_shifts
  add column if not exists next_quick_turn integer not null default 1;

update public.operational_shifts s
set next_quick_turn=greatest(
  1,
  1 + (
    select count(*)::integer
    from public.orders o
    where o.location_id=s.location_id
      and o.service_mode='counter'
      and o.opened_at>=s.opened_at
      and (s.closed_at is null or o.opened_at<s.closed_at)
  )
)
where s.status='open';

create or replace function private.seed_default_operational_shift()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_timezone text;
  v_opened_at timestamptz;
  v_shift_number bigint;
begin
  if exists (
    select 1 from public.operational_shifts s
    where s.location_id=new.id and s.status='open'
  ) then
    return new;
  end if;

  select coalesce(nullif(btrim(r.timezone),''),'America/Bogota')
  into v_timezone
  from public.restaurants r
  where r.id=new.restaurant_id;

  v_opened_at := date_trunc('day',now() at time zone v_timezone) at time zone v_timezone;

  select coalesce(max(s.shift_number),0)+1
  into v_shift_number
  from public.operational_shifts s
  where s.location_id=new.id;

  insert into public.operational_shifts(
    restaurant_id,location_id,shift_number,status,opened_at,opened_by,next_quick_turn
  )
  values(
    new.restaurant_id,new.id,v_shift_number,'open',v_opened_at,null,1
  );

  return new;
end;
$function$;

drop trigger if exists trg_seed_default_operational_shift on public.locations;
create trigger trg_seed_default_operational_shift
after insert on public.locations
for each row
execute function private.seed_default_operational_shift();

do $$
declare
  v_location record;
  v_timezone text;
  v_opened_at timestamptz;
  v_shift_number bigint;
begin
  for v_location in
    select l.id,l.restaurant_id,r.timezone
    from public.locations l
    join public.restaurants r on r.id=l.restaurant_id
    where l.active=true
      and not exists (
        select 1 from public.operational_shifts s
        where s.location_id=l.id and s.status='open'
      )
  loop
    v_timezone := coalesce(nullif(btrim(v_location.timezone),''),'America/Bogota');
    v_opened_at := date_trunc('day',now() at time zone v_timezone) at time zone v_timezone;

    select coalesce(max(s.shift_number),0)+1
    into v_shift_number
    from public.operational_shifts s
    where s.location_id=v_location.id;

    insert into public.operational_shifts(
      restaurant_id,location_id,shift_number,status,opened_at,opened_by,next_quick_turn
    )
    values(
      v_location.restaurant_id,v_location.id,v_shift_number,'open',v_opened_at,null,1
    );
  end loop;
end
$$;

create or replace function private.allocate_quick_turn(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns integer
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_shift public.operational_shifts%rowtype;
  v_turn integer;
  v_timezone text;
  v_opened_at timestamptz;
  v_shift_number bigint;
begin
  perform 1
  from public.locations l
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
    and l.active=true
  for update;

  if not found then raise exception 'Invalid restaurant/location'; end if;

  select * into v_shift
  from public.operational_shifts s
  where s.location_id=p_location_id
    and s.status='open'
  order by s.opened_at desc
  limit 1
  for update;

  if not found then
    select coalesce(nullif(btrim(r.timezone),''),'America/Bogota')
    into v_timezone
    from public.restaurants r
    where r.id=p_restaurant_id;

    v_opened_at := date_trunc('day',now() at time zone v_timezone) at time zone v_timezone;

    select coalesce(max(s.shift_number),0)+1
    into v_shift_number
    from public.operational_shifts s
    where s.location_id=p_location_id;

    insert into public.operational_shifts(
      restaurant_id,location_id,shift_number,status,opened_at,opened_by,next_quick_turn
    )
    values(
      p_restaurant_id,p_location_id,v_shift_number,'open',v_opened_at,null,1
    )
    returning * into v_shift;
  end if;

  v_turn := greatest(coalesce(v_shift.next_quick_turn,1),1);

  update public.operational_shifts
  set next_quick_turn=v_turn+1,
      updated_at=now()
  where id=v_shift.id;

  return v_turn;
end;
$function$;

create or replace function private.assign_quick_turn()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_manual boolean;
begin
  if new.service_mode<>'counter' then
    return new;
  end if;

  select coalesce(rs.pager_enabled,true)
  into v_manual
  from public.restaurant_settings rs
  where rs.restaurant_id=new.restaurant_id;

  v_manual := coalesce(v_manual,true);

  if not v_manual and nullif(btrim(coalesce(new.pager_number,'')),'') is null then
    new.pager_number := private.allocate_quick_turn(new.restaurant_id,new.location_id)::text;
    new.customer_name := null;
  end if;

  return new;
end;
$function$;

drop trigger if exists orders_assign_quick_turn on public.orders;
create trigger orders_assign_quick_turn
before insert on public.orders
for each row
execute function private.assign_quick_turn();

create or replace function private.guard_automatic_quick_identity()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_manual boolean;
begin
  if old.service_mode<>'counter' then
    return new;
  end if;

  select coalesce(rs.pager_enabled,true)
  into v_manual
  from public.restaurant_settings rs
  where rs.restaurant_id=old.restaurant_id;

  v_manual := coalesce(v_manual,true);

  if not v_manual
     and (
       new.pager_number is distinct from old.pager_number
       or new.customer_name is distinct from old.customer_name
     ) then
    raise exception 'Automatic quick-service turn cannot be edited';
  end if;

  return new;
end;
$function$;

drop trigger if exists orders_guard_automatic_quick_identity on public.orders;
create trigger orders_guard_automatic_quick_identity
before update of pager_number,customer_name on public.orders
for each row
execute function private.guard_automatic_quick_identity();

create or replace function private.route_order_item_preparation_station()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_restaurant_id uuid;
  v_location_id uuid;
  v_split boolean;
  v_kitchen_station uuid;
begin
  select o.restaurant_id,o.location_id
  into v_restaurant_id,v_location_id
  from public.orders o
  where o.id=new.order_id;

  if v_restaurant_id is null then return new; end if;

  select coalesce(rs.separate_kitchen_bar,true)
  into v_split
  from public.restaurant_settings rs
  where rs.restaurant_id=v_restaurant_id;

  v_split := coalesce(v_split,true);

  if not v_split then
    select ks.id
    into v_kitchen_station
    from public.kitchen_stations ks
    where ks.location_id=v_location_id
      and ks.station_type='kitchen'
      and ks.active=true
    order by ks.display_order,ks.created_at
    limit 1;

    if v_kitchen_station is null then
      raise exception 'No active kitchen station for unified preparation';
    end if;

    new.station_id := v_kitchen_station;
  end if;

  return new;
end;
$function$;

drop trigger if exists order_items_route_preparation_station on public.order_items;
create trigger order_items_route_preparation_station
before insert on public.order_items
for each row
execute function private.route_order_item_preparation_station();

create or replace function private.create_quick_order(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_manual boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'orders.create') then
    raise exception 'Not allowed to create orders';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  select coalesce(rs.pager_enabled,true)
  into v_manual
  from public.restaurant_settings rs
  where rs.restaurant_id=p_restaurant_id;

  v_manual := coalesce(v_manual,true);

  insert into public.orders(
    restaurant_id,location_id,service_mode,payment_timing,status,payment_status,opened_by
  )
  values(
    p_restaurant_id,p_location_id,'counter','postpaid','draft','unpaid',v_user
  )
  returning * into v_order;

  return jsonb_build_object(
    'id',v_order.id,
    'order_number',v_order.order_number,
    'pager_number',v_order.pager_number,
    'identifier_mode',case when v_manual then 'manual' else 'turn' end
  );
end;
$function$;
