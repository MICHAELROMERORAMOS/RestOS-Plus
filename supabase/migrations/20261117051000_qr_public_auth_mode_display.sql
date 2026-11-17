CREATE OR REPLACE FUNCTION public.get_public_qr_menu(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
select jsonb_build_object(
 'restaurant',jsonb_build_object('name',r.name,'logoUrl',r.logo_url,'currency',coalesce(s.currency_code,r.currency_code)),
 'location',jsonb_build_object('name',l.name),
 'authMode',q.auth_mode,
 'allergenCatalog',coalesce((
   select jsonb_agg(jsonb_build_object('id',a.id,'nameEs',a.name_es,'nameEn',a.name_en,'icon',a.icon,
    'subtypes',coalesce((select jsonb_agg(jsonb_build_object('id',st.id,'nameEs',st.name_es,'nameEn',st.name_en) order by st.display_order)
                        from public.allergen_subtypes st where st.allergen_id=a.id and st.active),'[]'::jsonb))
    order by a.display_order)
   from public.allergen_groups a where a.active
 ),'[]'::jsonb),
 'categories',coalesce((
   select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'description',c.description) order by c.display_order,c.name)
   from public.menu_categories c where c.restaurant_id=r.id and c.active
 ),'[]'::jsonb),
 'products',coalesce((
   select jsonb_agg(jsonb_build_object('id',p.id,'categoryId',p.category_id,'name',p.name,
     'description',p.description,'imageUrl',p.image_url,'price',coalesce(pl.price_override,p.base_price),
     'allergens',coalesce((
       select jsonb_agg(jsonb_build_object('allergenId',pa.allergen_id,'nameEs',ag.name_es,'icon',ag.icon,
           'level',pa.exposure_level,
           'subtypes',coalesce((select jsonb_agg(jsonb_build_object('id',ast.id,'nameEs',ast.name_es,
                'level',pas.exposure_level))
             from public.product_allergen_subtypes pas join public.allergen_subtypes ast on ast.id=pas.subtype_id
             where pas.product_id=p.id and ast.allergen_id=pa.allergen_id),'[]'::jsonb))
         order by ag.display_order)
       from public.product_allergens pa join public.allergen_groups ag on ag.id=pa.allergen_id and ag.active
       where pa.product_id=p.id
     ),'[]'::jsonb))
     order by p.name)
   from public.products p
   join public.product_locations pl on pl.product_id=p.id and pl.restaurant_id=r.id and pl.location_id=l.id and pl.active
   where p.restaurant_id=r.id and p.active
     and (p.category_id is null or exists(select 1 from public.menu_categories c where c.id=p.category_id and c.restaurant_id=r.id and c.active))
     and public.qr_product_in_stock(p.id,l.id)
 ),'[]'::jsonb)
) from public.qr_menu_settings q
join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active
join public.restaurants r on r.id=q.restaurant_id and r.status='active'
left join public.restaurant_settings s on s.restaurant_id=r.id
where q.location_id=p_location_id and q.enabled limit 1
$function$
;
revoke all on function public.get_public_qr_menu(uuid) from public;
grant execute on function public.get_public_qr_menu(uuid) to anon,authenticated;