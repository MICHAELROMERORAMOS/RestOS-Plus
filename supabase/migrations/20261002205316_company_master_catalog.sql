alter table public.products
  add column if not exists preparation_station_type text not null default 'kitchen';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='public.products'::regclass
      and conname='products_preparation_station_type_check'
  ) then
    alter table public.products
      add constraint products_preparation_station_type_check
      check (preparation_station_type in ('kitchen','bar','dessert','coffee','other'));
  end if;
end $$;

with inferred as (
  select distinct on (psr.product_id)
    psr.product_id,
    ks.station_type
  from public.product_station_routes psr
  join public.kitchen_stations ks on ks.id=psr.station_id
  where ks.active=true
  order by psr.product_id, psr.location_id
)
update public.products p
set preparation_station_type=i.station_type,
    updated_at=now()
from inferred i
where i.product_id=p.id
  and p.preparation_station_type is distinct from i.station_type;

create or replace function private.save_product_location_configuration(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_locations jsonb,
  p_station_type text
)
returns jsonb
language plpgsql
security definer
set search_path=''
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

  if not private.user_has_restaurant_permission(p_restaurant_id,'products.branch.assign') then
    raise exception 'Not allowed to assign products to branches';
  end if;

  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Invalid station type';
  end if;

  if not exists (
    select 1 from public.products p
    where p.id=p_product_id and p.restaurant_id=p_restaurant_id
  ) then
    raise exception 'Product not found or not authorized';
  end if;

  p_locations := coalesce(p_locations,'[]'::jsonb);
  if jsonb_typeof(p_locations)<>'array' then
    raise exception 'Invalid product location configuration';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_locations) e
    group by e->>'locationId'
    having count(*)>1
  ) then
    raise exception 'Duplicate product location configuration';
  end if;

  for v_entry in select value from jsonb_array_elements(p_locations)
  loop
    begin
      v_location_id := nullif(v_entry->>'locationId','')::uuid;
    exception when others then
      raise exception 'Invalid location identifier';
    end;

    if v_location_id is null then
      raise exception 'Location identifier is required';
    end if;

    if not exists (
      select 1 from public.locations l
      where l.id=v_location_id
        and l.restaurant_id=p_restaurant_id
        and l.active=true
    ) then
      raise exception 'Location does not belong to this company or is inactive';
    end if;

    begin
      v_active := coalesce((v_entry->>'active')::boolean,false);
    exception when others then
      raise exception 'Invalid location active value';
    end;

    if nullif(btrim(coalesce(v_entry->>'priceOverride','')),'') is null then
      v_price_override := null;
    else
      begin
        v_price_override := (v_entry->>'priceOverride')::numeric;
      exception when others then
        raise exception 'Invalid location price override';
      end;
      if v_price_override<0 then
        raise exception 'Location price override cannot be negative';
      end if;
    end if;

    insert into public.product_locations(
      product_id,location_id,restaurant_id,active,price_override
    )
    values(
      p_product_id,v_location_id,p_restaurant_id,v_active,v_price_override
    )
    on conflict(product_id,location_id)
    do update set
      active=excluded.active,
      price_override=excluded.price_override,
      updated_at=now();

    if v_active then
      select ks.id into v_station_id
      from public.kitchen_stations ks
      where ks.location_id=v_location_id
        and ks.station_type=p_station_type
        and ks.active=true
      order by ks.display_order,ks.created_at
      limit 1;

      if v_station_id is null then
        raise exception 'No active preparation station of type % in branch %',p_station_type,v_location_id;
      end if;

      insert into public.product_station_routes(product_id,location_id,station_id)
      values(p_product_id,v_location_id,v_station_id)
      on conflict(product_id,location_id)
      do update set station_id=excluded.station_id;
    end if;

    v_count := v_count+1;
  end loop;

  update public.product_locations pl
  set active=false,
      price_override=null,
      updated_at=now()
  where pl.product_id=p_product_id
    and pl.restaurant_id=p_restaurant_id
    and not exists (
      select 1 from jsonb_array_elements(p_locations) e
      where nullif(e->>'locationId','')::uuid=pl.location_id
    );

  update public.products
  set preparation_station_type=p_station_type,
      updated_at=now()
  where id=p_product_id
    and restaurant_id=p_restaurant_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product',p_product_id,'locations_update',
    jsonb_build_object('locations',p_locations,'stationType',p_station_type)
  );

  return jsonb_build_object(
    'productId',p_product_id,
    'configuredLocations',v_count,
    'stationType',p_station_type
  );
end;
$function$;

create or replace function private.save_company_catalog_product(
  p_product_id uuid,
  p_restaurant_id uuid,
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
  v_actor uuid := (select auth.uid());
  v_product public.products%rowtype;
  v_product_id uuid;
  v_inventory_item_id uuid;
  v_existing_direct_item_id uuid;
  v_existing_mode text;
  v_has_recipe boolean := false;
  v_name text := btrim(coalesce(p_name,''));
  v_sku text := nullif(upper(btrim(coalesce(p_sku,''))),'');
  v_unit text := lower(btrim(coalesce(p_inventory_unit,'unidad')));
  v_cost numeric := coalesce(p_inventory_average_cost,0);
  v_min numeric := coalesce(p_inventory_min_stock,0);
  v_entry jsonb;
  v_allergen_id uuid;
  v_level text;
  v_subtype_text text;
  v_subtype_id uuid;
  v_location_result jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'company.control.view')
     or not private.user_has_restaurant_permission(p_restaurant_id,'products.catalog.manage') then
    raise exception 'Not allowed to manage the company catalog';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'products.branch.assign') then
    raise exception 'Not allowed to assign products to branches';
  end if;

  if char_length(v_name)<1 or char_length(v_name)>160 then
    raise exception 'Product name is required';
  end if;
  if coalesce(p_base_price,0)<0 or coalesce(p_tax_rate,0)<0 then
    raise exception 'Product price or tax cannot be negative';
  end if;
  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Invalid station type';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.menu_categories mc
    where mc.id=p_category_id
      and mc.restaurant_id=p_restaurant_id
      and mc.active=true
  ) then
    raise exception 'Invalid category for this company';
  end if;

  if p_direct_inventory then
    if not private.user_has_restaurant_permission(p_restaurant_id,'inventory.manage') then
      raise exception 'Inventory management permission is required for direct-stock products';
    end if;
    if v_unit not in ('unidad','g','kg','ml','l','porcion') then
      raise exception 'Invalid inventory unit';
    end if;
    if v_cost<0 or v_min<0 then
      raise exception 'Inventory values cannot be negative';
    end if;
    if p_inventory_max_stock is not null and p_inventory_max_stock<v_min then
      raise exception 'Maximum stock cannot be lower than minimum stock';
    end if;
  end if;

  if p_product_id is not null then
    select * into v_product
    from public.products p
    where p.id=p_product_id and p.restaurant_id=p_restaurant_id
    for update;

    if not found then raise exception 'Product not found or not authorized'; end if;

    v_product_id := v_product.id;
    v_existing_direct_item_id := v_product.direct_inventory_item_id;
    v_existing_mode := v_product.inventory_mode;
  end if;

  if p_direct_inventory then
    v_inventory_item_id := v_existing_direct_item_id;
    if v_inventory_item_id is null then
      insert into public.inventory_items(
        restaurant_id,sku,name,unit,average_cost,min_stock,max_stock,active
      )
      values(
        p_restaurant_id,v_sku,v_name,v_unit,v_cost,v_min,p_inventory_max_stock,true
      )
      returning id into v_inventory_item_id;
    else
      update public.inventory_items
      set sku=v_sku,
          name=v_name,
          unit=v_unit,
          average_cost=v_cost,
          min_stock=v_min,
          max_stock=p_inventory_max_stock,
          active=true,
          updated_at=now()
      where id=v_inventory_item_id and restaurant_id=p_restaurant_id;
      if not found then raise exception 'Direct inventory item not found'; end if;
    end if;
  end if;

  if v_product_id is null then
    insert into public.products(
      restaurant_id,category_id,sku,name,description,base_price,tax_rate,
      track_inventory,inventory_mode,direct_inventory_item_id,active,
      preparation_station_type
    )
    values(
      p_restaurant_id,p_category_id,v_sku,v_name,
      nullif(btrim(coalesce(p_description,'')),''),
      coalesce(p_base_price,0),coalesce(p_tax_rate,0),
      coalesce(p_direct_inventory,false),
      case when p_direct_inventory then 'direct' else 'none' end,
      case when p_direct_inventory then v_inventory_item_id else null end,
      coalesce(p_active,true),
      p_station_type
    )
    returning id into v_product_id;
  else
    select exists(
      select 1 from public.product_recipes pr
      where pr.product_id=v_product_id
    ) into v_has_recipe;

    update public.products
    set category_id=p_category_id,
        sku=v_sku,
        name=v_name,
        description=nullif(btrim(coalesce(p_description,'')),''),
        base_price=coalesce(p_base_price,0),
        tax_rate=coalesce(p_tax_rate,0),
        track_inventory=case
          when p_direct_inventory then true
          when v_existing_mode='direct' then false
          else v_has_recipe
        end,
        inventory_mode=case
          when p_direct_inventory then 'direct'
          when v_existing_mode='direct' then 'none'
          when v_has_recipe then 'recipe'
          else 'none'
        end,
        direct_inventory_item_id=case
          when p_direct_inventory then v_inventory_item_id
          else direct_inventory_item_id
        end,
        active=coalesce(p_active,true),
        preparation_station_type=p_station_type,
        updated_at=now()
    where id=v_product_id;
  end if;

  if p_direct_inventory then
    delete from public.product_recipes where product_id=v_product_id;
    insert into public.product_recipes(product_id,inventory_item_id,quantity_required)
    values(v_product_id,v_inventory_item_id,1)
    on conflict(product_id,inventory_item_id)
    do update set quantity_required=1;
  elsif v_existing_mode='direct' then
    delete from public.product_recipes where product_id=v_product_id;
  end if;

  p_allergens := coalesce(p_allergens,'[]'::jsonb);
  if jsonb_typeof(p_allergens)<>'array' then
    raise exception 'Invalid allergen configuration';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_allergens) e
    group by e->>'allergenId'
    having count(*)>1
  ) then
    raise exception 'Duplicate allergen configuration';
  end if;

  delete from public.product_allergen_subtypes where product_id=v_product_id;
  delete from public.product_allergens where product_id=v_product_id;

  for v_entry in select value from jsonb_array_elements(p_allergens)
  loop
    begin
      v_allergen_id := nullif(v_entry->>'allergenId','')::uuid;
    exception when others then
      raise exception 'Invalid allergen identifier';
    end;

    v_level := lower(btrim(coalesce(v_entry->>'level','')));
    if v_level not in ('contains','may_contain') then
      raise exception 'Invalid allergen exposure level';
    end if;

    if not exists (
      select 1 from public.allergen_groups ag
      where ag.id=v_allergen_id and ag.active=true
    ) then
      raise exception 'Allergen not found';
    end if;

    insert into public.product_allergens(
      product_id,allergen_id,exposure_level,updated_by,updated_at
    )
    values(v_product_id,v_allergen_id,v_level,v_actor,now());

    if v_entry ? 'subtypeIds' then
      if jsonb_typeof(v_entry->'subtypeIds')<>'array' then
        raise exception 'Invalid allergen subtype configuration';
      end if;

      for v_subtype_text in
        select value from jsonb_array_elements_text(v_entry->'subtypeIds')
      loop
        begin
          v_subtype_id := nullif(v_subtype_text,'')::uuid;
        exception when others then
          raise exception 'Invalid allergen subtype identifier';
        end;

        if not exists (
          select 1 from public.allergen_subtypes st
          where st.id=v_subtype_id
            and st.allergen_id=v_allergen_id
            and st.active=true
        ) then
          raise exception 'Allergen subtype does not belong to selected allergen';
        end if;

        insert into public.product_allergen_subtypes(
          product_id,subtype_id,exposure_level
        )
        values(v_product_id,v_subtype_id,v_level);
      end loop;
    end if;
  end loop;

  v_location_result := private.save_product_location_configuration(
    v_product_id,p_restaurant_id,p_locations,p_station_type
  );

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product',v_product_id,
    case when p_product_id is null then 'catalog.create' else 'catalog.update' end,
    jsonb_build_object(
      'name',v_name,
      'stationType',p_station_type,
      'active',coalesce(p_active,true),
      'directInventory',coalesce(p_direct_inventory,false),
      'locations',p_locations
    )
  );

  return jsonb_build_object(
    'productId',v_product_id,
    'inventoryMode',case
      when p_direct_inventory then 'direct'
      when v_existing_mode='direct' then 'none'
      when v_has_recipe then 'recipe'
      else 'none'
    end,
    'inventoryItemId',case when p_direct_inventory then v_inventory_item_id else null end,
    'locations',v_location_result
  );
exception
  when unique_violation then
    raise exception 'Product or inventory SKU is already in use';
end;
$function$;

create or replace function public.save_company_catalog_product(
  p_product_id uuid,
  p_restaurant_id uuid,
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
  p_active boolean,
  p_allergens jsonb,
  p_locations jsonb
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.save_company_catalog_product(
    p_product_id,p_restaurant_id,p_category_id,p_name,p_description,
    p_base_price,p_tax_rate,p_sku,p_station_type,p_direct_inventory,
    p_inventory_unit,p_inventory_average_cost,p_inventory_min_stock,
    p_inventory_max_stock,p_active,p_allergens,p_locations
  );
$function$;

revoke all on function private.save_company_catalog_product(
  uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,boolean,jsonb,jsonb
) from public,anon,authenticated;
grant execute on function private.save_company_catalog_product(
  uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,boolean,jsonb,jsonb
) to authenticated;

revoke all on function public.save_company_catalog_product(
  uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,boolean,jsonb,jsonb
) from public,anon;
grant execute on function public.save_company_catalog_product(
  uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,boolean,jsonb,jsonb
) to authenticated;
