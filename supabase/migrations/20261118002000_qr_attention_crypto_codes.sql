CREATE OR REPLACE FUNCTION public.get_qr_attention_display(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rid uuid; c public.qr_attention_codes%rowtype; v_enabled boolean;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active;
 if rid is null or not exists (
 select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
 and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','payments.create','settings.manage'))
 ) then raise exception 'Pantalla no autorizada' using errcode='42501';end if;
 select enabled into v_enabled from public.qr_attention_settings where location_id=p_location_id and restaurant_id=rid;
 if not coalesce(v_enabled,false) then return jsonb_build_object('enabled',false);end if;
 insert into public.qr_attention_codes(location_id,restaurant_id,code,expires_at)
 values (p_location_id,rid,lpad(((('x'||encode(extensions.gen_random_bytes(4),'hex'))::bit(32)::bigint % 1000000)::text),6,'0'),now()+interval '20 minutes')
 on conflict(location_id) do update set
 code=case when qr_attention_codes.expires_at<=now() then excluded.code else qr_attention_codes.code end,
 expires_at=case when qr_attention_codes.expires_at<=now() then excluded.expires_at else qr_attention_codes.expires_at end,
 failed_attempts=case when qr_attention_codes.expires_at<=now() then 0 else qr_attention_codes.failed_attempts end,
 locked_until=case when qr_attention_codes.expires_at<=now() then null else qr_attention_codes.locked_until end,
 updated_at=now()
 where qr_attention_codes.restaurant_id=excluded.restaurant_id;
 select * into c from public.qr_attention_codes where location_id=p_location_id;
 return jsonb_build_object('enabled',true,'code',c.code,'expiresAt',c.expires_at,'serverNow',now());
end $function$
;