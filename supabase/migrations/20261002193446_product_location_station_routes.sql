create or replace function private.save_product_location_configuration(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_locations jsonb,
  p_station_type text
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
  v_station_id uuid;
  v_count integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Invalid station type';
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

    if v_active then
      select ks.id
      into v_station_id
      from public.kitchen_stations ks
      where ks.location_id = v_location_id
        and ks.station_type = p_station_type
        and ks.active = true
      order by ks.display_order, ks.created_at
      limit 1;

      if v_station_id is null then
        raise exception 'No active preparation station of type % in selected location', p_station_type;
      end if;

      insert into public.product_station_routes(product_id, location_id, station_id)
      values(p_product_id, v_location_id, v_station_id)
      on conflict(product_id, location_id)
      do update set station_id = excluded.station_id;
    end if;

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
    jsonb_build_object(
      'locations', p_locations,
      'stationType', p_station_type
    )
  );

  return jsonb_build_object(
    'productId', p_product_id,
    'configuredLocations', v_count,
    'stationType', p_station_type
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
    p_locations,
    p_station_type
  );

  return v_result || jsonb_build_object(
    'locations', v_location_result
  );
end;
$function$;

revoke all on function private.save_product_location_configuration(uuid, uuid, jsonb, text)
  from public, anon;
grant execute on function private.save_product_location_configuration(uuid, uuid, jsonb, text)
  to authenticated;

drop function if exists private.save_product_location_configuration(uuid, uuid, jsonb);
