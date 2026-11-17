CREATE OR REPLACE FUNCTION public.manage_qr_attention_requests(p_location_id uuid, p_request_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rid uuid;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active;
 if rid is null or not exists (
 select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
 and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','payments.create','settings.manage'))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 if p_request_id is not null then
  if p_status not in ('acknowledged','completed','cancelled') then raise exception 'Estado inválido';end if;
  update public.qr_attention_requests set status=p_status,
   acknowledged_at=case when p_status='acknowledged' then now() else acknowledged_at end,
   completed_at=case when p_status in ('completed','cancelled') then now() else completed_at end,
   handled_by=(select auth.uid())
  where id=p_request_id and location_id=p_location_id and restaurant_id=rid
    and (status='pending' or (status='acknowledged' and p_status in ('completed','cancelled')));
  if not found then raise exception 'Solicitud no disponible o ya atendida';end if;
 end if;
 return jsonb_build_object('enabled',coalesce((select s.enabled from public.qr_attention_settings s where s.location_id=p_location_id and s.restaurant_id=rid),false),'requests',coalesce((
 select jsonb_agg(jsonb_build_object('id',r.id,'action',r.action,'status',r.status,'createdAt',r.created_at,'tableName',t.name,'zoneName',z.name)
 order by r.created_at desc)
 from public.qr_attention_requests r join public.dining_tables t on t.id=r.table_id
 left join public.dining_zones z on z.id=t.zone_id
 where r.location_id=p_location_id and r.restaurant_id=rid and r.created_at>now()-interval '24 hours'
 and r.status in ('pending','acknowledged')
 ),'[]'::jsonb));
end $function$
;