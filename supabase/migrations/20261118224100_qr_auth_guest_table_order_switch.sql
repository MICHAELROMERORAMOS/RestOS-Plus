CREATE OR REPLACE FUNCTION public.authorize_qr_guest_view(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session public.qr_guest_sessions%rowtype;v_token uuid;
begin
 if exists(select 1 from public.table_qr_codes q join public.qr_table_order_settings ts on ts.table_id=q.table_id and ts.location_id=q.location_id where q.location_id=p_location_id and q.token=p_qr_token and ts.enabled=false) then raise exception 'Los pedidos QR están desactivados para esta mesa' using errcode='42501';end if;
 if coalesce((select auth_mode from public.qr_menu_settings where location_id=p_location_id),'required')='required'
 and ((select auth.uid()) is null or coalesce((select auth.jwt()->>'is_anonymous'),'false')='true')
 then return jsonb_build_object('ok',false,'message','Debes iniciar sesión para pedir'); end if;
 if p_access_code !~ '^[0-9]{4}$' then return jsonb_build_object('ok',false,'message','PIN inválido');end if;
 select s.* into v_session
 from public.table_qr_codes q
 join public.qr_guest_sessions s on s.table_id=q.table_id and s.location_id=q.location_id and s.restaurant_id=q.restaurant_id
 join public.qr_menu_settings qm on qm.location_id=q.location_id and qm.restaurant_id=q.restaurant_id and qm.enabled
 join public.orders o on o.id=s.order_id and o.restaurant_id=s.restaurant_id and o.location_id=s.location_id
 where q.location_id=p_location_id and q.token=p_qr_token and s.status='active' and s.expires_at>now()
   and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
 order by s.created_at desc limit 1 for update of s;
 if not found then return jsonb_build_object('ok',false,'message','Sesión de mesa no disponible');end if;
 if v_session.locked_until>now() then return jsonb_build_object('ok',false,'message','PIN bloqueado temporalmente');end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions
  set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
      locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end
  where id=v_session.id;
  return jsonb_build_object('ok',false,'message','PIN incorrecto');
 end if;
 update public.qr_guest_sessions set failed_attempts=0,locked_until=null where id=v_session.id;
 v_token:=gen_random_uuid();
 insert into public.qr_guest_view_tokens(session_id,token_hash,expires_at,customer_user_id)
 values(v_session.id,extensions.digest(v_token::text,'sha256'),now()+interval '48 hours',case when (select auth_mode from public.qr_menu_settings where location_id=p_location_id)='disabled' then null else (select auth.uid()) end);
 return jsonb_build_object('ok',true,'viewToken',v_token,'validHours',48);
end $function$
;