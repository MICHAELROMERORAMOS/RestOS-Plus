-- QR menu availability: stock, recipe ingredients and temporary product suspensions
CREATE OR REPLACE FUNCTION public.get_public_qr_menu(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
select jsonb_build_object(
 'restaurant',jsonb_build_object('name',r.name,'logoUrl',r.logo_url,'currency',coalesce(s.currency_code,r.currency_code)),
 'location',jsonb_build_object('name',l.name),
 'categories',coalesce((
   select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'description',c.description) order by c.display_order,c.name)
   from public.menu_categories c where c.restaurant_id=r.id and c.active=true
 ),'[]'::jsonb),
 'products',coalesce((
   select jsonb_agg(jsonb_build_object('id',p.id,'categoryId',p.category_id,'name',p.name,
     'description',p.description,'imageUrl',p.image_url,'price',coalesce(pl.price_override,p.base_price)) order by p.name)
   from public.products p
   join public.product_locations pl on pl.product_id=p.id and pl.restaurant_id=r.id and pl.location_id=l.id and pl.active=true
   where p.restaurant_id=r.id and p.active=true
     and (p.category_id is null or exists(select 1 from public.menu_categories c where c.id=p.category_id and c.restaurant_id=r.id and c.active=true))
     and public.qr_product_in_stock(p.id,l.id)
 ),'[]'::jsonb)
) from public.qr_menu_settings q
join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active=true
join public.restaurants r on r.id=q.restaurant_id and r.status='active'
left join public.restaurant_settings s on s.restaurant_id=r.id
where q.location_id=p_location_id and q.enabled=true limit 1
$function$
;

CREATE OR REPLACE FUNCTION public.qr_product_in_stock(p_product_id uuid, p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
select exists (
 select 1 from public.products p
 join public.locations l on l.id=p_location_id and l.restaurant_id=p.restaurant_id and l.active=true
 join public.product_locations pl on pl.product_id=p.id and pl.location_id=l.id and pl.restaurant_id=p.restaurant_id and pl.active=true
 where p.id=p_product_id and p.active=true
 and not exists (
   select 1 from public.product_unavailability_requests u
   where u.product_id=p.id and u.restaurant_id=p.restaurant_id and u.location_id=l.id
   and u.status='approved' and u.unavailable_until>now()
 )
 and (
  p.track_inventory=false
  or (p.track_inventory=true and p.inventory_mode='direct' and p.direct_inventory_item_id is not null
      and exists (select 1 from public.inventory_items i where i.id=p.direct_inventory_item_id and i.restaurant_id=p.restaurant_id and i.active=true)
      and (select coalesce(sum(m.quantity_delta),0) from public.inventory_movements m
           where m.inventory_item_id=p.direct_inventory_item_id and m.restaurant_id=p.restaurant_id and m.location_id=l.id)>=1)
  or (p.track_inventory=true and p.inventory_mode='recipe'
      and exists(select 1 from public.product_recipes rec where rec.product_id=p.id)
      and not exists(
        select 1 from public.product_recipes rec
        left join public.inventory_items i on i.id=rec.inventory_item_id and i.restaurant_id=p.restaurant_id and i.active=true
        where rec.product_id=p.id and
         (i.id is null or rec.quantity_required<=0 or
          (select coalesce(sum(m.quantity_delta),0) from public.inventory_movements m
           where m.inventory_item_id=rec.inventory_item_id and m.restaurant_id=p.restaurant_id and m.location_id=l.id)<rec.quantity_required)
      ))
 )
)
$function$
;
revoke all on function public.qr_product_in_stock(uuid,uuid) from public,anon,authenticated;
revoke all on function public.get_public_qr_menu(uuid) from public;
grant execute on function public.get_public_qr_menu(uuid) to anon,authenticated;
