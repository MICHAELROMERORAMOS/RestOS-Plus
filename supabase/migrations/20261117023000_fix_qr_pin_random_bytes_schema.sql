-- Fix pin issuance when pgcrypto is installed in Supabase's extensions schema.
-- The SECURITY DEFINER function uses search_path='', so extension functions must be qualified.
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
   v_bytes:=extensions.gen_random_bytes(4);
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
revoke all on function public.manage_qr_guest_session(uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_session(uuid,text) to authenticated;
