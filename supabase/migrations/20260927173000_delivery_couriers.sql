create table if not exists public.delivery_couriers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  phone text not null,
  address text not null,
  company text not null,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_couriers_name_not_blank check (length(btrim(name)) > 0),
  constraint delivery_couriers_phone_not_blank check (length(btrim(phone)) > 0),
  constraint delivery_couriers_address_not_blank check (length(btrim(address)) > 0),
  constraint delivery_couriers_company_not_blank check (length(btrim(company)) > 0)
);

create index if not exists delivery_couriers_restaurant_active_name_idx
  on public.delivery_couriers(restaurant_id, active, name);

alter table public.delivery_couriers enable row level security;

create or replace function private.list_delivery_couriers(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_is_restaurant_member(p_restaurant_id) then
    raise exception 'Not allowed to view delivery couriers';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'phone', c.phone,
        'address', c.address,
        'company', c.company
      )
      order by lower(c.name), c.created_at
    ),
    '[]'::jsonb
  )
  into v_result
  from public.delivery_couriers c
  where c.restaurant_id = p_restaurant_id
    and c.active = true;

  return v_result;
end;
$function$;

create or replace function public.list_delivery_couriers(p_restaurant_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select private.list_delivery_couriers(p_restaurant_id);
$function$;

revoke all on function public.list_delivery_couriers(uuid) from public, anon;
grant execute on function public.list_delivery_couriers(uuid) to authenticated;
revoke all on function private.list_delivery_couriers(uuid) from public, anon;
grant execute on function private.list_delivery_couriers(uuid) to authenticated;

create or replace function private.save_delivery_courier(
  p_restaurant_id uuid,
  p_name text,
  p_phone text,
  p_address text,
  p_company text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_phone_key text := regexp_replace(coalesce(p_phone, ''), '[^0-9]+', '', 'g');
  v_address text := btrim(coalesce(p_address, ''));
  v_company text := btrim(coalesce(p_company, ''));
  v_courier public.delivery_couriers%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id, 'payments.create') then
    raise exception 'Not allowed to manage delivery couriers';
  end if;

  if v_name = '' then raise exception 'Courier name is required'; end if;
  if length(v_phone_key) < 5 then raise exception 'Courier phone is invalid'; end if;
  if v_address = '' then raise exception 'Courier address is required'; end if;
  if v_company = '' then raise exception 'Courier company is required'; end if;

  select * into v_courier
  from public.delivery_couriers c
  where c.restaurant_id = p_restaurant_id
    and regexp_replace(c.phone, '[^0-9]+', '', 'g') = v_phone_key
  order by c.active desc, c.updated_at desc
  limit 1
  for update;

  if found then
    update public.delivery_couriers
    set name = v_name,
        phone = v_phone,
        address = v_address,
        company = v_company,
        active = true,
        updated_at = now()
    where id = v_courier.id
    returning * into v_courier;
  else
    insert into public.delivery_couriers(
      restaurant_id, name, phone, address, company, created_by
    )
    values(
      p_restaurant_id, v_name, v_phone, v_address, v_company, v_user
    )
    returning * into v_courier;
  end if;

  return jsonb_build_object(
    'id', v_courier.id,
    'name', v_courier.name,
    'phone', v_courier.phone,
    'address', v_courier.address,
    'company', v_courier.company
  );
end;
$function$;

create or replace function public.save_delivery_courier(
  p_restaurant_id uuid,
  p_name text,
  p_phone text,
  p_address text,
  p_company text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.save_delivery_courier(
    p_restaurant_id, p_name, p_phone, p_address, p_company
  );
$function$;

revoke all on function public.save_delivery_courier(uuid,text,text,text,text) from public, anon;
grant execute on function public.save_delivery_courier(uuid,text,text,text,text) to authenticated;
revoke all on function private.save_delivery_courier(uuid,text,text,text,text) from public, anon;
grant execute on function private.save_delivery_courier(uuid,text,text,text,text) to authenticated;

create or replace function private.assign_delivery_courier(
  p_order_id uuid,
  p_courier_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_courier public.delivery_couriers%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and service_mode = 'delivery'
    and status in ('draft', 'open', 'awaiting_payment')
  for update;

  if not found then raise exception 'Delivery order not found'; end if;

  if not private.user_has_location_permission(v_order.location_id, 'payments.create') then
    raise exception 'Not allowed to assign delivery courier';
  end if;

  select * into v_courier
  from public.delivery_couriers
  where id = p_courier_id
    and restaurant_id = v_order.restaurant_id
    and active = true;

  if not found then raise exception 'Delivery courier not found'; end if;

  update public.orders
  set delivery_details = coalesce(delivery_details, '{}'::jsonb) || jsonb_build_object(
        'courierId', v_courier.id,
        'courierName', v_courier.name,
        'courierPhone', v_courier.phone,
        'courierAddress', v_courier.address,
        'courierCompany', v_courier.company,
        'courierAssignedAt', now()
      )
  where id = v_order.id;

  return jsonb_build_object(
    'id', v_courier.id,
    'name', v_courier.name,
    'phone', v_courier.phone,
    'address', v_courier.address,
    'company', v_courier.company
  );
end;
$function$;

create or replace function public.assign_delivery_courier(
  p_order_id uuid,
  p_courier_id uuid
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.assign_delivery_courier(p_order_id, p_courier_id);
$function$;

revoke all on function public.assign_delivery_courier(uuid,uuid) from public, anon;
grant execute on function public.assign_delivery_courier(uuid,uuid) to authenticated;
revoke all on function private.assign_delivery_courier(uuid,uuid) from public, anon;
grant execute on function private.assign_delivery_courier(uuid,uuid) to authenticated;
