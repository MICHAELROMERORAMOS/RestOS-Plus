CREATE OR REPLACE FUNCTION public.claim_qr_guest_table(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;v_order uuid;
begin
 if exists(select 1 from public.table_qr_codes q join public.qr_table_order_settings ts on ts.table_id=q.table_id and ts.location_id=q.location_id where q.location_id=p_location_id and q.token=p_qr_token and ts.enabled=false) then raise exception 'Los pedidos QR están desactivados para esta mesa' using errcode='42501';end if;
 if exists(select 1 from public.qr_menu_settings m join public.table_qr_codes t on t.location_id=m.location_id
 where m.location_id=p_location_id and t.token=p_qr_token and m.auth_mode='required')
 and ((select auth.uid()) is null or coalesce((select auth.jwt()->>'is_anonymous'),'false')='true') then
 raise exception 'Inicio de sesión requerido' using errcode='42501'; end if;
 if p_access_code !~ '^[0-9]{4}$' then raise exception 'Introduce un código de 4 dígitos';end if;
 select q.table_id,q.restaurant_id into v_table,v_restaurant
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active=true
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active=true
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 join public.qr_menu_settings ms on ms.location_id=q.location_id and ms.restaurant_id=q.restaurant_id and ms.enabled=true
 where q.token=p_qr_token and q.location_id=p_location_id;
 if v_table is null then raise exception 'Código QR inválido';end if;
 perform 1 from public.dining_tables where id=v_table for update;
 select * into v_session from public.qr_guest_sessions
 where table_id=v_table and location_id=p_location_id and restaurant_id=v_restaurant
 and status='active' and expires_at>now() order by created_at desc limit 1 for update;
 if not found then raise exception 'Solicita al personal el código de esta mesa';end if;
 if v_session.locked_until>now() then raise exception 'Demasiados intentos. Solicita ayuda al personal';end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions
   set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
       locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end
   where id=v_session.id;
  return jsonb_build_object('ok',false,'message','Código incorrecto');
 end if;
 update public.qr_guest_sessions set failed_attempts=0,locked_until=null where id=v_session.id;
 if v_session.claimed_at is not null then
  if not exists(select 1 from public.orders where id=v_session.order_id and status in ('draft','open','awaiting_payment') and payment_status<>'paid')
  then raise exception 'La cuenta está cerrada';end if;
  return jsonb_build_object('ok',true,'tableId',v_table,'orderId',v_session.order_id);
 end if;
 if exists(select 1 from public.table_order_sessions where table_id=v_table) or exists(
  select 1 from public.order_table_links ol join public.orders o on o.id=ol.order_id
  where ol.table_id=v_table and ol.unlinked_at is null and o.status in ('draft','open','awaiting_payment')
 ) then raise exception 'Esta mesa ya se encuentra ocupada';end if;
 insert into public.orders(restaurant_id,location_id,service_mode,payment_timing,status,customer_name)
 values(v_restaurant,p_location_id,'table','postpaid','draft','Pedido QR')
 returning id into v_order;
 update public.qr_guest_sessions set claimed_at=now(),order_id=v_order where id=v_session.id;
 insert into public.order_table_links(order_id,table_id,is_primary) values(v_order,v_table,true);
 return jsonb_build_object('ok',true,'tableId',v_table,'orderId',v_order);
end $function$
;