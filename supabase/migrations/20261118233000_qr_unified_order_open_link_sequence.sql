CREATE OR REPLACE FUNCTION public.open_qr_guest_order_with_attention(p_location_id uuid, p_qr_token uuid, p_attention_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rid uuid;tid uuid;login_mode text; s public.qr_guest_sessions%rowtype;oid uuid; token uuid; internal_pin text; v_created boolean:=false;
begin
 select q.restaurant_id,q.table_id,m.auth_mode into rid,tid,login_mode
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 join public.qr_menu_settings m on m.location_id=q.location_id and m.restaurant_id=q.restaurant_id and m.enabled
 join public.qr_attention_settings cfg on cfg.location_id=q.location_id and cfg.restaurant_id=q.restaurant_id and cfg.enabled
 join public.qr_attention_sessions a on a.location_id=q.location_id and a.restaurant_id=q.restaurant_id and a.table_id=q.table_id
   and a.token_hash=extensions.digest(p_attention_token::text,'sha256') and a.expires_at>now() and a.revoked_at is null
 left join public.qr_table_order_settings ts on ts.table_id=q.table_id and ts.location_id=q.location_id and ts.restaurant_id=q.restaurant_id
 where q.location_id=p_location_id and q.token=p_qr_token and coalesce(ts.enabled,true);
 if tid is null then raise exception 'El acceso QR o los pedidos de esta mesa no están disponibles' using errcode='42501';end if;
 if login_mode='required' and ((select auth.uid()) is null or coalesce((select auth.jwt()->>'is_anonymous'),'false')='true') then
 raise exception 'Inicia sesión para realizar pedidos' using errcode='42501';end if;
 perform 1 from public.dining_tables t where t.id=tid for update;
 update public.qr_guest_sessions qs set status='closed',closed_at=now() where qs.table_id=tid and qs.location_id=p_location_id and qs.status='active' and qs.expires_at<=now();
 select qs.* into s from public.qr_guest_sessions qs
 where qs.table_id=tid and qs.location_id=p_location_id and qs.restaurant_id=rid and qs.status='active' and qs.expires_at>now()
 order by qs.created_at desc limit 1 for update;
 if s.order_id is not null then
  select o.id into oid from public.orders o join public.order_table_links l on l.order_id=o.id and l.table_id=tid and l.unlinked_at is null
  where o.id=s.order_id and o.restaurant_id=rid and o.location_id=p_location_id
  and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid';
 end if;
 if oid is null then
  select o.id into oid from public.orders o join public.order_table_links l on l.order_id=o.id
  where l.table_id=tid and l.unlinked_at is null and o.restaurant_id=rid and o.location_id=p_location_id
  and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
  order by o.created_at desc limit 1;
 end if;
 if oid is null and exists(select 1 from public.table_order_sessions tos where tos.table_id=tid) then
 raise exception 'El mesero está iniciando la cuenta de esta mesa. Inténtalo después de enviar el primer pedido';end if;
 if oid is null then
  insert into public.orders(restaurant_id,location_id,service_mode,payment_timing,status,customer_name)
  values(rid,p_location_id,'table','postpaid','draft','Pedido QR') returning id into oid;
  v_created:=true;
 end if;
 if s.id is null then
  internal_pin:=lpad(((('x'||encode(extensions.gen_random_bytes(4),'hex'))::bit(32)::bigint % 10000)::text),4,'0');
  insert into public.qr_guest_sessions(table_id,location_id,restaurant_id,access_code,expires_at,claimed_at,order_id)
  values(tid,p_location_id,rid,internal_pin,now()+interval '4 hours',now(),oid) returning * into s;
 elsif s.order_id is distinct from oid then
  update public.qr_guest_sessions qs set order_id=oid,claimed_at=coalesce(qs.claimed_at,now())
  where qs.id=s.id returning * into s;
 end if;
 if v_created then
  insert into public.order_table_links(order_id,table_id,is_primary) values(oid,tid,true);
 end if;
 token:=gen_random_uuid();
 insert into public.qr_guest_view_tokens(session_id,token_hash,expires_at,customer_user_id)
 values(s.id,extensions.digest(token::text,'sha256'),now()+interval '48 hours',
 case when login_mode='disabled' then null else (select auth.uid()) end);
 return jsonb_build_object('ok',true,'viewToken',token,'orderId',oid,'tableId',tid);
end $function$
;