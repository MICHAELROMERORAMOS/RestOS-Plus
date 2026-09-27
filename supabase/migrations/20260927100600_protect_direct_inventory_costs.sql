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

  if not private.user_has_location_permission(p_location_id,'inventory.manage') then
    raise exception 'Not allowed to manage inventory';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id=p_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
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
        where m.inventory_item_id=i.id
          and m.location_id=p_location_id
      ),0)
    )
    order by p.name
  ),'[]'::jsonb)
  into v_result
  from public.products p
  join public.inventory_items i on i.id=p.direct_inventory_item_id
  where p.restaurant_id=p_restaurant_id
    and p.inventory_mode='direct';

  return v_result;
end;
$function$;
