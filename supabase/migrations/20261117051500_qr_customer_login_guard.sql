CREATE OR REPLACE FUNCTION public.claim_qr_guest_table(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;v_order uuid;
begin
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
CREATE OR REPLACE FUNCTION public.authorize_qr_guest_view(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session public.qr_guest_sessions%rowtype;v_token uuid;
begin
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
 values(v_session.id,extensions.digest(v_token::text,'sha256'),now()+interval '48 hours',(select auth.uid()));
 return jsonb_build_object('ok',true,'viewToken',v_token,'validHours',48);
end $function$
;
CREATE OR REPLACE FUNCTION public.get_qr_guest_order_status(p_location_id uuid, p_qr_token uuid, p_view_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session public.qr_guest_sessions%rowtype;v_status jsonb;v_order_status text;v_paid text;v_view_id uuid;
begin
 select s.* into v_session
 from public.qr_guest_view_tokens v
 join public.qr_guest_sessions s on s.id=v.session_id
 join public.table_qr_codes q on q.table_id=s.table_id and q.location_id=s.location_id and q.restaurant_id=s.restaurant_id
 where q.location_id=p_location_id and q.token=p_qr_token
   and v.token_hash=extensions.digest(p_view_token::text,'sha256') and v.expires_at>now()
 and (v.customer_user_id is null or (v.customer_user_id=(select auth.uid()) and coalesce((select auth.jwt()->>'is_anonymous'),'false')<>'true'))
 limit 1;
 if not found then return jsonb_build_object('authorized',false);end if;
 select id into v_view_id from public.qr_guest_view_tokens where token_hash=extensions.digest(p_view_token::text,'sha256');
 select o.status,o.payment_status into v_order_status,v_paid
 from public.orders o where o.id=v_session.order_id and o.restaurant_id=v_session.restaurant_id
 and o.location_id=p_location_id;
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',rq.id,'createdAt',rq.created_at,'status',rq.status,'total',rq.total,
   'items',coalesce((
     select jsonb_agg(jsonb_build_object(
       'name',it.value->>'name','quantity',(it.value->>'quantity')::numeric,
       'unitPrice',(it.value->>'unitPrice')::numeric,
       'status',coalesce(oi.status,case when rq.status='rejected' then 'rejected' else rq.status end),
       'servedQuantity',coalesce(oi.served_quantity,0)
     ) order by it.ordinality)
     from jsonb_array_elements(rq.items) with ordinality as it(value,ordinality)
     left join public.qr_guest_request_items map on map.request_id=rq.id and map.position=it.ordinality
     left join public.order_items oi on oi.id=map.order_item_id and oi.order_id=v_session.order_id
   ),'[]'::jsonb)
 ) order by rq.created_at desc),'[]'::jsonb)
 into v_status
 from public.qr_guest_requests rq where rq.session_id=v_session.id and rq.view_token_id=v_view_id
 and rq.location_id=p_location_id and rq.restaurant_id=v_session.restaurant_id
 and rq.table_id=v_session.table_id;
 return jsonb_build_object(
    'authorized',true,'requests',v_status,
    'canOrder',v_session.status='active' and v_session.expires_at>now() and v_order_status in ('draft','open','awaiting_payment') and coalesce(v_paid,'')<>'paid',
    'orderClosed',v_session.status<>'active' or coalesce(v_paid,'')='paid' or v_order_status in ('closed','cancelled','merged'),
    'updatedAt',now()
 );
end $function$
;
revoke all on function public.claim_qr_guest_table(uuid,uuid,text) from public;
grant execute on function public.claim_qr_guest_table(uuid,uuid,text) to anon,authenticated;
revoke all on function public.authorize_qr_guest_view(uuid,uuid,text) from public;
grant execute on function public.authorize_qr_guest_view(uuid,uuid,text) to anon,authenticated;
revoke all on function public.get_qr_guest_order_status(uuid,uuid,uuid) from public;
grant execute on function public.get_qr_guest_order_status(uuid,uuid,uuid) to anon,authenticated;
