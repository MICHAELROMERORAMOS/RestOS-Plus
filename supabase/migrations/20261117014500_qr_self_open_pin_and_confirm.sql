-- Four-digit PIN for self-service QR table opening; throttled and scoped to one visit
alter table public.qr_guest_sessions
 add column if not exists claimed_at timestamptz,
 add column if not exists order_id uuid references public.orders(id),
 add column if not exists failed_attempts integer not null default 0,
 add column if not exists locked_until timestamptz;
CREATE OR REPLACE FUNCTION public.claim_qr_guest_table(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;v_order uuid;
begin
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
 insert into public.order_table_links(order_id,table_id,is_primary) values(v_order,v_table,true);
 update public.qr_guest_sessions set claimed_at=now(),order_id=v_order where id=v_session.id;
 return jsonb_build_object('ok',true,'tableId',v_table,'orderId',v_order);
end $function$
;

CREATE OR REPLACE FUNCTION public.manage_qr_guest_requests(p_location_id uuid, p_request_id uuid DEFAULT NULL::uuid, p_action text DEFAULT 'list'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_restaurant uuid;v_result jsonb;v_req public.qr_guest_requests%rowtype;
v_order public.orders%rowtype;v_round uuid;v_round_no int;v_item jsonb;
v_product public.products%rowtype;v_price numeric;v_station uuid;v_sent_order bigint;
begin
 select restaurant_id into v_restaurant from public.locations where id=p_location_id and active=true;
 if v_restaurant is null or not exists(
  select 1 from public.memberships m join public.restaurants r on r.id=m.restaurant_id
  where m.restaurant_id=v_restaurant and m.user_id=(select auth.uid()) and m.status='active'
  and (r.owner_user_id=(select auth.uid()) or exists(
    select 1 from public.role_permissions rp where rp.role_id=m.role_id and
    rp.permission_code in ('orders.create','payments.create','tables.manage')))
  and (m.all_locations=true or exists(
    select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 if p_action in ('reviewed','rejected') and p_request_id is not null then
  select * into v_req from public.qr_guest_requests
  where id=p_request_id and location_id=p_location_id and restaurant_id=v_restaurant for update;
  if not found or v_req.status<>'pending' then raise exception 'Solicitud ya procesada o inexistente';end if;
  if p_action='reviewed' then
    perform 1 from public.dining_tables where id=v_req.table_id for update;
    select o.* into v_order from public.orders o
    join public.qr_guest_sessions s on s.order_id=o.id and s.id=v_req.session_id
    join public.order_table_links tl on tl.order_id=o.id and tl.table_id=v_req.table_id and tl.unlinked_at is null
    where o.restaurant_id=v_restaurant and o.location_id=p_location_id
      and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
      and s.status='active' and s.expires_at>now()
    for update of o;
    if not found then raise exception 'Esta mesa ya no admite pedidos';end if;
    -- Check aggregate ingredient demand across the entire request to avoid overselling.
    if exists (
      with lines as (
        select (x->>'productId')::uuid pid,(x->>'quantity')::numeric qty
        from jsonb_array_elements(v_req.items) x
      ), needs as (
        select rec.inventory_item_id id, rec.quantity_required*li.qty need
        from lines li join public.products p on p.id=li.pid
        join public.product_recipes rec on rec.product_id=p.id
        where p.track_inventory=true and p.inventory_mode='recipe'
        union all
        select p.direct_inventory_item_id id,li.qty need
        from lines li join public.products p on p.id=li.pid
        where p.track_inventory=true and p.inventory_mode='direct'
      ), totals as (select id,sum(need) need from needs group by id)
      select 1 from totals t where t.id is null or
       t.need > (select coalesce(sum(m.quantity_delta),0) from public.inventory_movements m
         where m.inventory_item_id=t.id and m.location_id=p_location_id and m.restaurant_id=v_restaurant)
    ) then raise exception 'Inventario insuficiente para confirmar esta solicitud';end if;
    for v_item in select value from jsonb_array_elements(v_req.items) loop
      if not public.qr_product_in_stock((v_item->>'productId')::uuid,p_location_id)
        then raise exception 'Producto agotado: actualiza la solicitud';end if;
    end loop;
    select coalesce(max(round_number),0)+1 into v_round_no
    from public.order_rounds where order_id=v_order.id;
    update public.orders set status='open' where id=v_order.id;
    perform private.ensure_preparation_order_number(v_order.id);
    insert into public.order_rounds(order_id,round_number,status,created_by,sent_by,sent_at)
    values(v_order.id,v_round_no,'sent',(select auth.uid()),(select auth.uid()),now()) returning id into v_round;
    for v_item in select value from jsonb_array_elements(v_req.items) loop
      select * into v_product from public.products p
      where p.id=(v_item->>'productId')::uuid and p.restaurant_id=v_restaurant and p.active=true;
      if not found then raise exception 'Producto no disponible';end if;
      select coalesce(pl.price_override,v_product.base_price) into v_price from public.product_locations pl
       where pl.product_id=v_product.id and pl.location_id=p_location_id and pl.restaurant_id=v_restaurant and pl.active=true;
      if v_price is null then raise exception 'Producto deshabilitado en la sucursal';end if;
      select r.station_id into v_station from public.product_station_routes r
       join public.kitchen_stations st on st.id=r.station_id and st.active=true and st.location_id=p_location_id
       where r.product_id=v_product.id and r.location_id=p_location_id limit 1;
      if v_station is null then raise exception 'Producto sin estación de preparación';end if;
      insert into public.order_items(order_id,round_id,product_id,station_id,product_name,sku,
       quantity,unit_price,tax_rate,line_total,status,created_by)
      values(v_order.id,v_round,v_product.id,v_station,v_product.name,v_product.sku,
       (v_item->>'quantity')::numeric,v_price,v_product.tax_rate,
       round(v_price*(v_item->>'quantity')::numeric,2),'sent',(select auth.uid()));
    end loop;
    perform private.recalculate_order_financials(v_order.id);
  end if;
  update public.qr_guest_requests set status=p_action,reviewed_at=now()
   where id=v_req.id and status='pending';
 elsif p_action<>'list' then raise exception 'Acción inválida';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'tableId',q.table_id,'tableName',t.name,
  'items',q.items,'total',q.total,'status',q.status,'createdAt',q.created_at)
  order by q.created_at desc),'[]'::jsonb) into v_result
 from (select * from public.qr_guest_requests where location_id=p_location_id and restaurant_id=v_restaurant
  and status='pending' order by created_at desc limit 100) q
 join public.dining_tables t on t.id=q.table_id;
 return jsonb_build_object('requests',v_result);
end $function$
;

CREATE OR REPLACE FUNCTION public.manage_qr_guest_session(p_table_id uuid, p_action text DEFAULT 'read'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_location uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;v_pin text;v_bytes bytea;
begin
 select t.location_id,l.restaurant_id into v_location,v_restaurant
 from public.dining_tables t join public.locations l on l.id=t.location_id and l.active=true
 where t.id=p_table_id and t.active=true;
 if v_location is null or not exists (
 select 1 from public.memberships m join public.restaurants r on r.id=m.restaurant_id
 where m.restaurant_id=v_restaurant and m.user_id=(select auth.uid()) and m.status='active'
 and (r.owner_user_id=(select auth.uid()) or exists(
 select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('tables.manage','orders.create','settings.manage','payments.create')))
 and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=v_location))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 perform 1 from public.dining_tables where id=p_table_id for update;
 update public.qr_guest_sessions set status='closed',closed_at=now()
 where table_id=p_table_id and status='active' and expires_at<=now();
 if p_action='open' then
  if not exists(select 1 from public.qr_menu_settings where location_id=v_location and restaurant_id=v_restaurant and enabled=true) then
   raise exception 'Primero habilita el menú QR de esta sucursal';end if;
  if exists (
   select 1 from public.order_table_links otl join public.orders o on o.id=otl.order_id
   where otl.table_id=p_table_id and otl.unlinked_at is null and o.status in ('draft','open','awaiting_payment')
  ) then raise exception 'La mesa tiene una cuenta abierta. No se puede iniciar otro turno QR'; end if;
  if exists(select 1 from public.table_order_sessions where table_id=p_table_id) then
   raise exception 'La mesa está reservada por el personal'; end if;
  select * into v_session from public.qr_guest_sessions where table_id=p_table_id and status='active' and expires_at>now() limit 1;
  if not found then
   v_bytes:=gen_random_bytes(4);
   v_pin:=lpad(((get_byte(v_bytes,0)::bigint*16777216+get_byte(v_bytes,1)::bigint*65536+get_byte(v_bytes,2)::bigint*256+get_byte(v_bytes,3)::bigint)%10000)::text,4,'0');
   insert into public.qr_guest_sessions(table_id,location_id,restaurant_id,access_code,expires_at)
   values(p_table_id,v_location,v_restaurant,v_pin,now()+interval '3 hours');
  end if;
 elsif p_action='close' then
  update public.qr_guest_sessions set status='closed',closed_at=now() where table_id=p_table_id and status='active';
 elsif p_action<>'read' then raise exception 'Acción inválida';end if;
 select * into v_session from public.qr_guest_sessions where table_id=p_table_id and status='active' and expires_at>now() limit 1;
 return jsonb_build_object('active',v_session.id is not null,'code',v_session.access_code,
    'claimed',v_session.claimed_at is not null,'expiresAt',v_session.expires_at,'orderId',v_session.order_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.submit_qr_guest_request(p_location_id uuid, p_qr_token uuid, p_access_code text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;
v_line jsonb;v_prod public.products%rowtype;v_qty int;v_price numeric;v_total numeric:=0;v_items jsonb:='[]'::jsonb;v_request uuid;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>25 then raise exception 'Pedido inválido';end if;
 if p_access_code !~ '^[0-9]{4}$' then raise exception 'Código de 4 dígitos requerido';end if;
 select q.table_id,q.restaurant_id into v_table,v_restaurant from public.table_qr_codes q
 join public.qr_menu_settings ms on ms.location_id=q.location_id and ms.restaurant_id=q.restaurant_id and ms.enabled=true
 join public.dining_tables t on t.id=q.table_id and t.active=true and t.location_id=q.location_id
 where q.token=p_qr_token and q.location_id=p_location_id;
 if v_table is null then raise exception 'QR inválido';end if;
 perform 1 from public.dining_tables where id=v_table for update;
 select * into v_session from public.qr_guest_sessions
 where table_id=v_table and location_id=p_location_id and restaurant_id=v_restaurant and status='active' and expires_at>now()
 order by created_at desc limit 1 for update;
 if not found or v_session.claimed_at is null or v_session.order_id is null then
 raise exception 'Primero abre la mesa con el PIN';end if;
 if v_session.locked_until>now() then raise exception 'Acceso bloqueado temporalmente';end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
  locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end where id=v_session.id;
  return jsonb_build_object('ok',false,'message','Código incorrecto');
 end if;
 if not exists (select 1 from public.orders o join public.order_table_links l on l.order_id=o.id
  where o.id=v_session.order_id and o.restaurant_id=v_restaurant and o.location_id=p_location_id
   and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
   and l.table_id=v_table and l.unlinked_at is null) then raise exception 'La mesa está cerrada';end if;
 for v_line in select value from jsonb_array_elements(p_items) loop
  if not (v_line ? 'productId') or not(v_line ? 'quantity') or (v_line->>'quantity') !~ '^[0-9]{1,2}$'
    then raise exception 'Producto o cantidad inválida';end if;
  v_qty:=(v_line->>'quantity')::int;
  if v_qty<1 or v_qty>20 then raise exception 'Cantidad fuera de rango';end if;
  select * into v_prod from public.products p
   where p.id=(v_line->>'productId')::uuid and p.restaurant_id=v_restaurant and p.active=true;
  if not found or not public.qr_product_in_stock(v_prod.id,p_location_id)
    then raise exception 'Uno de los productos no está disponible. Actualiza el menú';end if;
  select coalesce(pl.price_override,v_prod.base_price) into v_price
   from public.product_locations pl where pl.product_id=v_prod.id and pl.restaurant_id=v_restaurant
   and pl.location_id=p_location_id and pl.active=true;
  if v_price is null then raise exception 'Producto no disponible';end if;
  v_total:=v_total+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_prod.id,'name',v_prod.name,'quantity',v_qty,'unitPrice',v_price));
 end loop;
 insert into public.qr_guest_requests(session_id,table_id,location_id,restaurant_id,items,total)
 values(v_session.id,v_table,p_location_id,v_restaurant,v_items,v_total) returning id into v_request;
 return jsonb_build_object('ok',true,'requestId',v_request,'status','pending','total',v_total);
end $function$
;
revoke all on function public.manage_qr_guest_session(uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_session(uuid,text) to authenticated;
revoke all on function public.claim_qr_guest_table(uuid,uuid,text) from public;
grant execute on function public.claim_qr_guest_table(uuid,uuid,text) to anon,authenticated;
revoke all on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) from public;
grant execute on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) to anon,authenticated;
revoke all on function public.manage_qr_guest_requests(uuid,uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_requests(uuid,uuid,text) to authenticated;
