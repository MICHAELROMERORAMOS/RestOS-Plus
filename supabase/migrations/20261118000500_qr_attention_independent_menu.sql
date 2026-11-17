CREATE OR REPLACE FUNCTION public.resolve_public_qr_table(p_location_id uuid, p_token uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select jsonb_build_object(
  'tableId',t.id,
  'tableName',t.name,
  'zoneName',z.name,
  'locationId',t.location_id
 )
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.active=true and t.location_id=q.location_id
 join public.dining_zones z on z.id=t.zone_id and z.location_id=t.location_id and z.active=true
 join public.locations l on l.id=q.location_id and l.active=true and l.restaurant_id=q.restaurant_id
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 left join public.qr_menu_settings ms on ms.location_id=l.id and ms.restaurant_id=r.id
 left join public.qr_attention_settings att on att.location_id=l.id and att.restaurant_id=r.id
 where q.location_id=p_location_id and q.token=p_token and (coalesce(ms.enabled,false) or coalesce(att.enabled,false))
 limit 1;
$function$
;