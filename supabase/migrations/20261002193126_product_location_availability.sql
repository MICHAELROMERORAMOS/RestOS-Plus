create table if not exists public.product_locations (
  product_id uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  active boolean not null default true,
  price_override numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id),
  constraint product_locations_price_override_nonnegative
    check (price_override is null or price_override >= 0)
);

create index if not exists product_locations_restaurant_idx
  on public.product_locations (restaurant_id);

create index if not exists product_locations_location_active_idx
  on public.product_locations (location_id, active);

create or replace function private.validate_product_location_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_product_restaurant uuid;
  v_location_restaurant uuid;
begin
  select p.restaurant_id
  into v_product_restaurant
  from public.products p
  where p.id = new.product_id;

  if v_product_restaurant is null then
    raise exception 'Product not found';
  end if;

  select l.restaurant_id
  into v_location_restaurant
  from public.locations l
  where l.id = new.location_id;

  if v_location_restaurant is null then
    raise exception 'Location not found';
  end if;

  if new.restaurant_id <> v_product_restaurant
     or new.restaurant_id <> v_location_restaurant then
    raise exception 'Product and location must belong to the same restaurant';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists product_locations_validate_tenant
  on public.product_locations;

create trigger product_locations_validate_tenant
before insert or update on public.product_locations
for each row
execute function private.validate_product_location_tenant();

alter table public.product_locations enable row level security;

drop policy if exists product_locations_select_authorized on public.product_locations;
create policy product_locations_select_authorized
on public.product_locations
for select
to authenticated
using (
  (select private.user_has_location_permission(location_id, 'products.view'))
  or (select private.user_has_location_permission(location_id, 'products.manage'))
  or (select private.user_has_location_permission(location_id, 'orders.create'))
);

drop policy if exists product_locations_insert_authorized on public.product_locations;
create policy product_locations_insert_authorized
on public.product_locations
for insert
to authenticated
with check (
  (select private.user_has_location_permission(location_id, 'products.manage'))
);

drop policy if exists product_locations_update_authorized on public.product_locations;
create policy product_locations_update_authorized
on public.product_locations
for update
to authenticated
using (
  (select private.user_has_location_permission(location_id, 'products.manage'))
)
with check (
  (select private.user_has_location_permission(location_id, 'products.manage'))
);

drop policy if exists product_locations_delete_authorized on public.product_locations;
create policy product_locations_delete_authorized
on public.product_locations
for delete
to authenticated
using (
  (select private.user_has_location_permission(location_id, 'products.manage'))
);

insert into public.product_locations (
  product_id,
  location_id,
  restaurant_id,
  active,
  price_override
)
select
  p.id,
  l.id,
  p.restaurant_id,
  true,
  null
from public.products p
join public.locations l
  on l.restaurant_id = p.restaurant_id
where l.active = true
on conflict (product_id, location_id) do nothing;

create or replace function private.save_product_location_configuration(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_locations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_entry jsonb;
  v_location_id uuid;
  v_active boolean;
  v_price_override numeric;
  v_count integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.products p
    where p.id = p_product_id
      and p.restaurant_id = p_restaurant_id
  ) then
    raise exception 'Product not found or not authorized';
  end if;

  if p_locations is null then
    p_locations := '[]'::jsonb;
  end if;

  if jsonb_typeof(p_locations) <> 'array' then
    raise exception 'Invalid product location configuration';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_locations) e
    group by e->>'locationId'
    having count(*) > 1
  ) then
    raise exception 'Duplicate product location configuration';
  end if;

  for v_entry in
    select value from jsonb_array_elements(p_locations)
  loop
    begin
      v_location_id := nullif(v_entry->>'locationId', '')::uuid;
    exception when others then
      raise exception 'Invalid location identifier';
    end;

    if v_location_id is null then
      raise exception 'Location identifier is required';
    end if;

    if not exists (
      select 1
      from public.locations l
      where l.id = v_location_id
        and l.restaurant_id = p_restaurant_id
    ) then
      raise exception 'Location does not belong to this restaurant';
    end if;

    if not private.user_has_location_permission(v_location_id, 'products.manage') then
      raise exception 'Not allowed to manage products for one or more selected locations';
    end if;

    begin
      v_active := coalesce((v_entry->>'active')::boolean, false);
    exception when others then
      raise exception 'Invalid location active value';
    end;

    if nullif(btrim(coalesce(v_entry->>'priceOverride', '')), '') is null then
      v_price_override := null;
    else
      begin
        v_price_override := (v_entry->>'priceOverride')::numeric;
      exception when others then
        raise exception 'Invalid location price override';
      end;

      if v_price_override < 0 then
        raise exception 'Location price override cannot be negative';
      end if;
    end if;

    insert into public.product_locations (
      product_id,
      location_id,
      restaurant_id,
      active,
      price_override
    )
    values (
      p_product_id,
      v_location_id,
      p_restaurant_id,
      v_active,
      v_price_override
    )
    on conflict (product_id, location_id)
    do update set
      active = excluded.active,
      price_override = excluded.price_override,
      updated_at = now();

    v_count := v_count + 1;
  end loop;

  update public.product_locations pl
  set
    active = false,
    price_override = null,
    updated_at = now()
  where pl.product_id = p_product_id
    and pl.restaurant_id = p_restaurant_id
    and private.user_has_location_permission(pl.location_id, 'products.manage')
    and not exists (
      select 1
      from jsonb_array_elements(p_locations) e
      where nullif(e->>'locationId', '')::uuid = pl.location_id
    );

  insert into public.audit_logs(
    restaurant_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  )
  values(
    p_restaurant_id,
    v_actor,
    'product',
    p_product_id,
    'locations_update',
    jsonb_build_object('locations', p_locations)
  );

  return jsonb_build_object(
    'productId', p_product_id,
    'configuredLocations', v_count
  );
end;
$function$;

create or replace function private.save_menu_product_full_config(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_category_id uuid,
  p_name text,
  p_description text,
  p_base_price numeric,
  p_tax_rate numeric,
  p_sku text,
  p_station_type text,
  p_direct_inventory boolean,
  p_inventory_unit text,
  p_inventory_average_cost numeric,
  p_inventory_min_stock numeric,
  p_inventory_max_stock numeric,
  p_inventory_opening_stock numeric,
  p_active boolean,
  p_allergens jsonb,
  p_locations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_product_id uuid;
  v_location_result jsonb;
begin
  v_result := private.save_menu_product_configured_with_allergens(
    p_product_id,
    p_restaurant_id,
    p_location_id,
    p_category_id,
    p_name,
    p_description,
    p_base_price,
    p_tax_rate,
    p_sku,
    p_station_type,
    p_direct_inventory,
    p_inventory_unit,
    p_inventory_average_cost,
    p_inventory_min_stock,
    p_inventory_max_stock,
    p_inventory_opening_stock,
    p_active,
    p_allergens
  );

  v_product_id := nullif(v_result->>'productId', '')::uuid;

  if v_product_id is null then
    raise exception 'Product save did not return an identifier';
  end if;

  v_location_result := private.save_product_location_configuration(
    v_product_id,
    p_restaurant_id,
    p_locations
  );

  return v_result || jsonb_build_object(
    'locations', v_location_result
  );
end;
$function$;

create or replace function public.save_menu_product_full_config(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_category_id uuid,
  p_name text,
  p_description text,
  p_base_price numeric,
  p_tax_rate numeric,
  p_sku text,
  p_station_type text,
  p_direct_inventory boolean,
  p_inventory_unit text,
  p_inventory_average_cost numeric,
  p_inventory_min_stock numeric,
  p_inventory_max_stock numeric,
  p_inventory_opening_stock numeric,
  p_active boolean,
  p_allergens jsonb,
  p_locations jsonb
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.save_menu_product_full_config(
    p_product_id,
    p_restaurant_id,
    p_location_id,
    p_category_id,
    p_name,
    p_description,
    p_base_price,
    p_tax_rate,
    p_sku,
    p_station_type,
    p_direct_inventory,
    p_inventory_unit,
    p_inventory_average_cost,
    p_inventory_min_stock,
    p_inventory_max_stock,
    p_inventory_opening_stock,
    p_active,
    p_allergens,
    p_locations
  );
$function$;

revoke all on function private.save_product_location_configuration(uuid, uuid, jsonb)
  from public, anon;
grant execute on function private.save_product_location_configuration(uuid, uuid, jsonb)
  to authenticated;

revoke all on function private.save_menu_product_full_config(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, text, text, boolean,
  text, numeric, numeric, numeric, numeric, boolean, jsonb, jsonb
) from public, anon;
grant execute on function private.save_menu_product_full_config(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, text, text, boolean,
  text, numeric, numeric, numeric, numeric, boolean, jsonb, jsonb
) to authenticated;

revoke all on function public.save_menu_product_full_config(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, text, text, boolean,
  text, numeric, numeric, numeric, numeric, boolean, jsonb, jsonb
) from public, anon;
grant execute on function public.save_menu_product_full_config(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, text, text, boolean,
  text, numeric, numeric, numeric, numeric, boolean, jsonb, jsonb
) to authenticated;
