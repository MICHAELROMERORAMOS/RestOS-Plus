CREATE OR REPLACE FUNCTION public.manage_qr_guest_requests(p_location_id uuid, p_request_id uuid DEFAULT NULL::uuid, p_action text DEFAULT 'list'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_restaurant uuid;v_result jsonb;v_req public.qr_guest_requests%rowtype;
v_order public.orders%rowtype;v_round uuid;v_round_no int;v_item jsonb;
v_product public.products%rowtype;v_price numeric;v_station uuid;v_sent_order bigint;v_item_id uuid;v_position int;v_allergies jsonb;v_allergy_context jsonb;
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
    v_position:=0;
    for v_item in select value from jsonb_array_elements(v_req.items) loop
      v_position:=v_position+1;
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
      select coalesce(jsonb_agg(jsonb_build_object('allergenId',g.id,'nameEs',g.name_es,
         'subtypeIds',coalesce(a.value->'subtypeIds','[]'::jsonb))),'[]'::jsonb)
       into v_allergies
       from jsonb_array_elements(coalesce(v_item->'declaredAllergies','[]'::jsonb)) as a(value)
       join public.allergen_groups g on g.id=(a.value->>'allergenId')::uuid;
      v_allergy_context:=jsonb_build_object('declared',v_allergies,'conflicts','[]'::jsonb);
      insert into public.order_items(order_id,round_id,product_id,station_id,product_name,sku,
       quantity,unit_price,tax_rate,line_total,status,created_by,allergy_context)
      values(v_order.id,v_round,v_product.id,v_station,v_product.name,v_product.sku,
       (v_item->>'quantity')::numeric,v_price,v_product.tax_rate,
       round(v_price*(v_item->>'quantity')::numeric,2),'sent',(select auth.uid()),v_allergy_context)
      returning id into v_item_id;
      insert into public.qr_guest_request_items(request_id,position,order_item_id)
      values(v_req.id,v_position,v_item_id);
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
revoke all on function public.manage_qr_guest_requests(uuid,uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_requests(uuid,uuid,text) to authenticated;
