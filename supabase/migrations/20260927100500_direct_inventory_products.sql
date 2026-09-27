alter table public.products
  add column if not exists inventory_mode text not null default 'none',
  add column if not exists direct_inventory_item_id uuid references public.inventory_items(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.products'::regclass
      and conname='products_inventory_mode_check'
  ) then
    alter table public.products
      add constraint products_inventory_mode_check
      check (inventory_mode in ('none','recipe','direct'));
  end if;
end
$$;

create index if not exists products_direct_inventory_item_idx
  on public.products(direct_inventory_item_id)
  where direct_inventory_item_id is not null;

update public.products p
set inventory_mode = case
  when p.track_inventory
   and exists (select 1 from public.product_recipes pr where pr.product_id=p.id)
    then 'recipe'
  else 'none'
end
where p.inventory_mode='none';

create or replace function private.save_menu_product_configured(
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
  p_inventory_unit text default 'unidad',
  p_inventory_average_cost numeric default 0,
  p_inventory_min_stock numeric default 0,
  p_inventory_max_stock numeric default null,
  p_inventory_opening_stock numeric default 0,
  p_active boolean default true
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
  v_station_id uuid;
  v_inventory_item_id uuid;
  v_existing_direct_item_id uuid;
  v_existing_mode text;
  v_name text := btrim(coalesce(p_name,''));
  v_sku text := nullif(upper(btrim(coalesce(p_sku,''))),'');
  v_unit text := lower(btrim(coalesce(p_inventory_unit,'unidad')));
  v_cost numeric := coalesce(p_inventory_average_cost,0);
  v_min numeric := coalesce(p_inventory_min_stock,0);
  v_opening numeric := coalesce(p_inventory_opening_stock,0);
  v_has_recipe boolean := false;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;

  if not private.user_has_location_permission(p_location_id,'products.manage') then
    raise exception 'Not allowed to manage products';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
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

  select ks.id into v_station_id
  from public.kitchen_stations ks
  where ks.location_id=p_location_id
    and ks.station_type=p_station_type
    and ks.active=true
  order by ks.display_order,ks.created_at
  limit 1;

  if v_station_id is null then
    raise exception 'No active preparation station for type %',p_station_type;
  end if;

  if p_direct_inventory then
    if not private.user_has_location_permission(p_location_id,'inventory.manage') then
      raise exception 'Not allowed to manage inventory';
    end if;

    if v_unit not in ('unidad','g','kg','ml','l','porcion') then
      raise exception 'Invalid inventory unit';
    end if;

    if v_cost<0 or v_min<0 or v_opening<0 then
      raise exception 'Inventory values cannot be negative';
    end if;

    if p_inventory_max_stock is not null and p_inventory_max_stock<v_min then
      raise exception 'Maximum stock cannot be lower than minimum stock';
    end if;
  end if;

  if p_product_id is not null then
    select * into v_product
    from public.products p
    where p.id=p_product_id
      and p.restaurant_id=p_restaurant_id
    for update;

    if not found then raise exception 'Product not found or not authorized'; end if;

    v_existing_direct_item_id := v_product.direct_inventory_item_id;
    v_existing_mode := v_product.inventory_mode;
    v_product_id := v_product.id;
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

      if v_opening>0 then
        insert into public.inventory_movements(
          restaurant_id,location_id,inventory_item_id,movement_type,
          quantity_delta,unit_cost,reference_type,note,created_by
        )
        values(
          p_restaurant_id,p_location_id,v_inventory_item_id,'opening',
          v_opening,v_cost,'manual_opening',
          'Existencia inicial creada desde Productos',v_actor
        );
      end if;
    else
      update public.inventory_items
      set sku=v_sku,
          name=v_name,
          unit=v_unit,
          average_cost=v_cost,
          min_stock=v_min,
          max_stock=p_inventory_max_stock,
          active=true
      where id=v_inventory_item_id
        and restaurant_id=p_restaurant_id;

      if not found then raise exception 'Direct inventory item not found'; end if;
    end if;
  end if;

  if v_product_id is null then
    insert into public.products(
      restaurant_id,category_id,sku,name,description,base_price,tax_rate,
      track_inventory,inventory_mode,direct_inventory_item_id,active
    )
    values(
      p_restaurant_id,p_category_id,v_sku,v_name,
      nullif(btrim(coalesce(p_description,'')),''),
      coalesce(p_base_price,0),coalesce(p_tax_rate,0),
      coalesce(p_direct_inventory,false),
      case when p_direct_inventory then 'direct' else 'none' end,
      case when p_direct_inventory then v_inventory_item_id else null end,
      coalesce(p_active,true)
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
        active=coalesce(p_active,true)
    where id=v_product_id;
  end if;

  if p_direct_inventory then
    delete from public.product_recipes where product_id=v_product_id;
    insert into public.product_recipes(product_id,inventory_item_id,quantity_required)
    values(v_product_id,v_inventory_item_id,1);
  elsif v_existing_mode='direct' then
    delete from public.product_recipes where product_id=v_product_id;
  end if;

  insert into public.product_station_routes(product_id,location_id,station_id)
  values(v_product_id,p_location_id,v_station_id)
  on conflict(product_id,location_id)
  do update set station_id=excluded.station_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product',v_product_id,
    case when p_product_id is null then 'create' else 'update' end,
    jsonb_build_object(
      'name',v_name,
      'inventoryMode',case when p_direct_inventory then 'direct' else
        case when v_existing_mode='direct' then 'none' when v_has_recipe then 'recipe' else 'none' end
      end,
      'directInventoryItemId',case when p_direct_inventory then v_inventory_item_id else null end
    )
  );

  return jsonb_build_object(
    'productId',v_product_id,
    'inventoryMode',case when p_direct_inventory then 'direct' else
      case when v_existing_mode='direct' then 'none' when v_has_recipe then 'recipe' else 'none' end
    end,
    'inventoryItemId',case when p_direct_inventory then v_inventory_item_id else null end
  );
exception
  when unique_violation then
    raise exception 'Product or inventory SKU is already in use';
end;
$function$;

create or replace function public.save_menu_product_configured(
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
  p_inventory_unit text default 'unidad',
  p_inventory_average_cost numeric default 0,
  p_inventory_min_stock numeric default 0,
  p_inventory_max_stock numeric default null,
  p_inventory_opening_stock numeric default 0,
  p_active boolean default true
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.save_menu_product_configured(
    p_product_id,p_restaurant_id,p_location_id,p_category_id,p_name,p_description,
    p_base_price,p_tax_rate,p_sku,p_station_type,p_direct_inventory,p_inventory_unit,
    p_inventory_average_cost,p_inventory_min_stock,p_inventory_max_stock,
    p_inventory_opening_stock,p_active
  );
$function$;

create or replace function private.get_direct_product_inventory_config(
  p_restaurant_id uuid,
  p_location_id uuid
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
  if not private.user_has_location_permission(p_location_id,'products.view') then
    raise exception 'Not allowed to view products';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'productId',p.id,
      'inventoryMode',p.inventory_mode,
      'inventoryItemId',i.id,
      'unit',i.unit,
      'averageCost',i.average_cost,
      'minStock',i.min_stock,
      'maxStock',i.max_stock,
      'currentStock',coalesce((
        select sum(m.quantity_delta)
        from public.inventory_movements m
        where m.inventory_item_id=i.id and m.location_id=p_location_id
      ),0)
    )
    order by p.name
  ),'[]'::jsonb)
  into v_result
  from public.products p
  left join public.inventory_items i on i.id=p.direct_inventory_item_id
  where p.restaurant_id=p_restaurant_id
    and p.inventory_mode='direct';

  return v_result;
end;
$function$;

create or replace function public.get_direct_product_inventory_config(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
set search_path=''
as $function$
  select private.get_direct_product_inventory_config(p_restaurant_id,p_location_id);
$function$;

create or replace function private.save_product_recipe_impl(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_line_count integer;
  v_cost numeric;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'inventory.manage') then
    raise exception 'Not allowed to manage inventory';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true
  ) then
    raise exception 'Location does not belong to this restaurant';
  end if;
  if not exists (
    select 1 from public.products p
    where p.id=p_product_id and p.restaurant_id=p_restaurant_id
  ) then
    raise exception 'Product does not belong to this restaurant';
  end if;
  if jsonb_typeof(p_lines)<>'array' then raise exception 'Recipe lines must be an array'; end if;

  v_line_count := jsonb_array_length(p_lines);

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line(value)
    left join public.inventory_items i
      on i.id=(line.value->>'inventoryItemId')::uuid
     and i.restaurant_id=p_restaurant_id
    where i.id is null or coalesce((line.value->>'quantityRequired')::numeric,0)<=0
  ) then
    raise exception 'Recipe contains an invalid ingredient or quantity';
  end if;

  delete from public.product_recipes where product_id=p_product_id;

  if v_line_count>0 then
    insert into public.product_recipes(product_id,inventory_item_id,quantity_required)
    select p_product_id,(line.value->>'inventoryItemId')::uuid,
           sum((line.value->>'quantityRequired')::numeric)
    from jsonb_array_elements(p_lines) line(value)
    group by (line.value->>'inventoryItemId')::uuid;
  end if;

  update public.products
  set track_inventory=v_line_count>0,
      inventory_mode=case when v_line_count>0 then 'recipe' else 'none' end,
      direct_inventory_item_id=null
  where id=p_product_id;

  select coalesce(sum(pr.quantity_required*i.average_cost),0)
  into v_cost
  from public.product_recipes pr
  join public.inventory_items i on i.id=pr.inventory_item_id
  where pr.product_id=p_product_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product_recipe',p_product_id,'replace',
    jsonb_build_object('lineCount',v_line_count,'estimatedCost',v_cost)
  );

  return jsonb_build_object(
    'productId',p_product_id,
    'lineCount',v_line_count,
    'estimatedCost',round(v_cost,2)
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Recipe contains invalid values';
end;
$function$;

revoke all on function public.save_menu_product_configured(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean) from public,anon;
revoke all on function public.get_direct_product_inventory_config(uuid,uuid) from public,anon;
grant execute on function public.save_menu_product_configured(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean) to authenticated;
grant execute on function public.get_direct_product_inventory_config(uuid,uuid) to authenticated;
