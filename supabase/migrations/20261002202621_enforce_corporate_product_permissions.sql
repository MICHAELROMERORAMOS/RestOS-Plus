-- Granular corporate product permissions now back the exposed RLS surface.
drop policy if exists products_insert_authorized on public.products;
create policy products_insert_authorized
on public.products for insert to authenticated
with check (
  (select private.user_has_restaurant_permission(products.restaurant_id,'products.catalog.manage'))
);

drop policy if exists products_update_authorized on public.products;
create policy products_update_authorized
on public.products for update to authenticated
using (
  (select private.user_has_restaurant_permission(products.restaurant_id,'products.catalog.manage'))
)
with check (
  (select private.user_has_restaurant_permission(products.restaurant_id,'products.catalog.manage'))
);

drop policy if exists menu_categories_insert_authorized on public.menu_categories;
create policy menu_categories_insert_authorized
on public.menu_categories for insert to authenticated
with check (
  (select private.user_has_restaurant_permission(menu_categories.restaurant_id,'products.catalog.manage'))
);

drop policy if exists menu_categories_update_authorized on public.menu_categories;
create policy menu_categories_update_authorized
on public.menu_categories for update to authenticated
using (
  (select private.user_has_restaurant_permission(menu_categories.restaurant_id,'products.catalog.manage'))
)
with check (
  (select private.user_has_restaurant_permission(menu_categories.restaurant_id,'products.catalog.manage'))
);

drop policy if exists product_locations_insert_authorized on public.product_locations;
create policy product_locations_insert_authorized
on public.product_locations for insert to authenticated
with check (
  (select private.user_has_restaurant_permission(product_locations.restaurant_id,'products.branch.assign'))
);

drop policy if exists product_locations_update_authorized on public.product_locations;
create policy product_locations_update_authorized
on public.product_locations for update to authenticated
using (
  (select private.user_has_restaurant_permission(product_locations.restaurant_id,'products.branch.assign'))
)
with check (
  (select private.user_has_restaurant_permission(product_locations.restaurant_id,'products.branch.assign'))
);

drop policy if exists product_locations_delete_authorized on public.product_locations;
create policy product_locations_delete_authorized
on public.product_locations for delete to authenticated
using (
  (select private.user_has_restaurant_permission(product_locations.restaurant_id,'products.branch.assign'))
);

drop policy if exists product_station_routes_insert_authorized on public.product_station_routes;
create policy product_station_routes_insert_authorized
on public.product_station_routes for insert to authenticated
with check (
  (select private.user_has_location_permission(product_station_routes.location_id,'products.branch.assign'))
);

drop policy if exists product_station_routes_update_authorized on public.product_station_routes;
create policy product_station_routes_update_authorized
on public.product_station_routes for update to authenticated
using (
  (select private.user_has_location_permission(product_station_routes.location_id,'products.branch.assign'))
)
with check (
  (select private.user_has_location_permission(product_station_routes.location_id,'products.branch.assign'))
);

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
set search_path=''
as $function$
declare
  v_result jsonb;
  v_product_id uuid;
  v_location_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'products.catalog.manage') then
    raise exception 'Not allowed to manage the company product catalog';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'products.branch.assign') then
    raise exception 'Not allowed to assign products to branches';
  end if;

  v_result := private.save_menu_product_configured_with_allergens(
    p_product_id,p_restaurant_id,p_location_id,p_category_id,p_name,p_description,
    p_base_price,p_tax_rate,p_sku,p_station_type,p_direct_inventory,p_inventory_unit,
    p_inventory_average_cost,p_inventory_min_stock,p_inventory_max_stock,
    p_inventory_opening_stock,p_active,p_allergens
  );

  v_product_id := nullif(v_result->>'productId','')::uuid;
  if v_product_id is null then
    raise exception 'Product save did not return an identifier';
  end if;

  v_location_result := private.save_product_location_configuration(
    v_product_id,p_restaurant_id,p_locations,p_station_type
  );

  return v_result || jsonb_build_object('locations',v_location_result);
end;
$function$;
