CREATE OR REPLACE FUNCTION public.submit_qr_guest_request(p_location_id uuid, p_qr_token uuid, p_access_code text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;
v_line jsonb;v_prod public.products%rowtype;v_qty int;v_price numeric;v_total numeric:=0;
v_items jsonb:='[]'::jsonb;v_request uuid;v_declared jsonb;v_allergy jsonb;v_allergen uuid;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>25
 then raise exception 'Pedido inválido';end if;
 if p_access_code !~ '^[0-9]{4}$' then raise exception 'Código de 4 dígitos requerido';end if;
 select q.table_id,q.restaurant_id into v_table,v_restaurant
 from public.table_qr_codes q join public.qr_menu_settings qm on qm.location_id=q.location_id and qm.restaurant_id=q.restaurant_id and qm.enabled
 join public.dining_tables t on t.id=q.table_id and t.active and t.location_id=q.location_id
 where q.token=p_qr_token and q.location_id=p_location_id;
 if v_table is null then raise exception 'QR inválido';end if;
 perform 1 from public.dining_tables where id=v_table for update;
 select * into v_session from public.qr_guest_sessions s
 where s.table_id=v_table and s.location_id=p_location_id and s.restaurant_id=v_restaurant
 and s.status='active' and s.expires_at>now()
 order by s.created_at desc limit 1 for update;
 if not found or v_session.claimed_at is null or v_session.order_id is null then
 raise exception 'Primero abre la mesa con el PIN';end if;
 if v_session.locked_until>now() then raise exception 'Acceso bloqueado temporalmente';end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
  locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end where id=v_session.id;
  return jsonb_build_object('ok',false,'message','Código incorrecto');
 end if;
 if not exists(select 1 from public.orders o join public.order_table_links l on l.order_id=o.id
 where o.id=v_session.order_id and o.restaurant_id=v_restaurant and o.location_id=p_location_id
 and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
 and l.table_id=v_table and l.unlinked_at is null) then
 raise exception 'La cuenta ya no admite pedidos';end if;
 for v_line in select value from jsonb_array_elements(p_items) loop
  if not (v_line ? 'productId') or not(v_line ? 'quantity') or (v_line->>'quantity') !~ '^[0-9]{1,2}$'
  then raise exception 'Producto o cantidad inválida';end if;
  v_qty:=(v_line->>'quantity')::int;
  if v_qty<1 or v_qty>20 then raise exception 'Cantidad fuera de rango';end if;
  select * into v_prod from public.products p where p.id=(v_line->>'productId')::uuid
   and p.restaurant_id=v_restaurant and p.active;
  if not found or not public.qr_product_in_stock(v_prod.id,p_location_id)
  then raise exception 'Producto sin existencias. Actualiza el menú';end if;
  select coalesce(pl.price_override,v_prod.base_price) into v_price from public.product_locations pl
   where pl.product_id=v_prod.id and pl.restaurant_id=v_restaurant and pl.location_id=p_location_id and pl.active;
  if v_price is null then raise exception 'Producto no disponible';end if;
  v_declared:=coalesce(v_line->'declaredAllergies','[]'::jsonb);
  if jsonb_typeof(v_declared)<>'array' or jsonb_array_length(v_declared)>20 then
    raise exception 'Alérgenos inválidos';end if;
  for v_allergy in select value from jsonb_array_elements(v_declared) loop
    if jsonb_typeof(v_allergy)<>'object' then raise exception 'Alérgeno inválido';end if;
    if (v_allergy->>'allergenId') !~* '^[0-9a-f-]{36}$' then raise exception 'Alérgeno inválido';end if;
    v_allergen:=(v_allergy->>'allergenId')::uuid;
    if not exists(select 1 from public.allergen_groups a where a.id=v_allergen and a.active)
      then raise exception 'Alérgeno no reconocido';end if;
    if exists(select 1 from public.product_allergens a where a.product_id=v_prod.id and a.allergen_id=v_allergen)
      then raise exception 'Producto incompatible con las alergias declaradas';end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object(
   'allergenId',g.id,'nameEs',g.name_es,
   'subtypeIds',coalesce(a.value->'subtypeIds','[]'::jsonb)
  )),'[]'::jsonb) into v_declared
  from jsonb_array_elements(v_declared) a(value)
  join public.allergen_groups g on g.id=(a.value->>'allergenId')::uuid;
  v_total:=v_total+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object(
   'productId',v_prod.id,'name',v_prod.name,'quantity',v_qty,'unitPrice',v_price,
   'declaredAllergies',v_declared));
 end loop;
 if (select count(*) from public.qr_guest_requests where session_id=v_session.id
 and created_at>now()-interval '1 minute')>=6
 then raise exception 'Demasiadas solicitudes. Vuelve a intentarlo en un minuto';end if;
 insert into public.qr_guest_requests(session_id,table_id,location_id,restaurant_id,items,total)
 values(v_session.id,v_table,p_location_id,v_restaurant,v_items,v_total)
 returning id into v_request;
 return jsonb_build_object('ok',true,'requestId',v_request,'status','pending','total',v_total);
end $function$
;
revoke all on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) from public;
grant execute on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) to anon,authenticated;
