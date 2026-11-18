CREATE OR REPLACE FUNCTION public.submit_qr_guest_request(p_location_id uuid, p_qr_token uuid, p_access_code text, p_items jsonb, p_view_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session uuid;v_view uuid;v_owner uuid;v_mode text;v_result jsonb;v_request uuid;
begin
 if exists(select 1 from public.table_qr_codes q join public.qr_table_order_settings ts on ts.table_id=q.table_id and ts.location_id=q.location_id where q.location_id=p_location_id and q.token=p_qr_token and ts.enabled=false) then raise exception 'Los pedidos QR están desactivados para esta mesa' using errcode='42501';end if;
 select s.id,v.id,v.customer_user_id,qm.auth_mode into v_session,v_view,v_owner,v_mode
 from public.qr_guest_view_tokens v
 join public.qr_guest_sessions s on s.id=v.session_id
 join public.table_qr_codes t on t.table_id=s.table_id and t.location_id=s.location_id and t.restaurant_id=s.restaurant_id
 join public.qr_menu_settings qm on qm.location_id=s.location_id and qm.restaurant_id=s.restaurant_id and qm.enabled
 where t.token=p_qr_token and t.location_id=p_location_id
 and v.token_hash=extensions.digest(p_view_token::text,'sha256') and v.expires_at>now()
 and s.status='active' and s.expires_at>now();
 if v_view is null then raise exception 'Acceso privado inválido' using errcode='42501';end if;
 if v_mode='required' and ((select auth.uid()) is null or coalesce((select auth.jwt()->>'is_anonymous'),'false')='true')
 then raise exception 'Debes iniciar sesión antes de pedir' using errcode='42501';end if;
 if v_owner is not null and v_owner is distinct from (select auth.uid())
 then raise exception 'La autorización pertenece a otro cliente' using errcode='42501';end if;
 v_result:=public.submit_qr_guest_request(p_location_id,p_qr_token,p_access_code,p_items);
 if coalesce((v_result->>'ok')::boolean,false) then
  v_request:=(v_result->>'requestId')::uuid;
  update public.qr_guest_requests
    set view_token_id=v_view,customer_user_id=case when v_mode='disabled' then null else (select auth.uid()) end
    where id=v_request and session_id=v_session and location_id=p_location_id;
  if not found then raise exception 'No se pudo asociar el pedido al cliente';end if;
 end if;
 return v_result;
end $function$
;