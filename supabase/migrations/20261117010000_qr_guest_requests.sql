-- QR guest request workflow: controlled staging queue, not direct kitchen dispatch
create table if not exists public.qr_guest_sessions (
 id uuid primary key default gen_random_uuid(),
 table_id uuid not null references public.dining_tables(id),
 location_id uuid not null references public.locations(id),
 restaurant_id uuid not null references public.restaurants(id),
 access_code text not null,
 status text not null default 'active' check (status in ('active','closed')),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '3 hours'),
 closed_at timestamptz,
 unique(id,table_id)
);
create unique index if not exists qr_guest_sessions_one_active_table on public.qr_guest_sessions(table_id) where status='active';
create table if not exists public.qr_guest_requests (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.qr_guest_sessions(id),
 table_id uuid not null references public.dining_tables(id),
 location_id uuid not null references public.locations(id),
 restaurant_id uuid not null references public.restaurants(id),
 items jsonb not null,
 total numeric not null,
 status text not null default 'pending' check(status in ('pending','reviewed','rejected')),
 created_at timestamptz not null default now(),
 reviewed_at timestamptz
);
alter table public.qr_guest_sessions enable row level security;
alter table public.qr_guest_requests enable row level security;
revoke all on public.qr_guest_sessions,public.qr_guest_requests from anon,authenticated;

CREATE OR REPLACE FUNCTION public.close_qr_session_on_paid_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if (new.status in ('closed','cancelled','merged') or new.payment_status='paid') and
 (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
 update public.qr_guest_sessions s set status='closed',closed_at=now()
 where s.status='active' and exists(select 1 from public.order_table_links l where l.order_id=new.id and l.table_id=s.table_id and l.unlinked_at is null);
 end if;
 return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.close_qr_session_when_table_released()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 update public.qr_guest_sessions set status='closed',closed_at=now()
 where table_id=old.table_id and status='active';
 return old;
end $function$
;

CREATE OR REPLACE FUNCTION public.manage_qr_guest_requests(p_location_id uuid, p_request_id uuid DEFAULT NULL::uuid, p_action text DEFAULT 'list'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_restaurant uuid;v_result jsonb;
begin
 select restaurant_id into v_restaurant from public.locations where id=p_location_id;
 if v_restaurant is null or not exists(
 select 1 from public.memberships m join public.restaurants r on r.id=m.restaurant_id
 where m.restaurant_id=v_restaurant and m.user_id=(select auth.uid()) and m.status='active'
 and (r.owner_user_id=(select auth.uid()) or exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','settings.manage')))
 and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 if p_action in ('reviewed','rejected') and p_request_id is not null then
 update public.qr_guest_requests set status=p_action,reviewed_at=now()
 where id=p_request_id and location_id=p_location_id and status='pending';
 elsif p_action<>'list' then raise exception 'Acción inválida';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'tableId',q.table_id,'tableName',t.name,
 'items',q.items,'total',q.total,'status',q.status,'createdAt',q.created_at)
 order by q.created_at desc),'[]'::jsonb) into v_result
 from (select * from public.qr_guest_requests where location_id=p_location_id and status='pending' order by created_at desc limit 100) q
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
declare v_location uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;
begin
 select t.location_id,l.restaurant_id into v_location,v_restaurant from public.dining_tables t
 join public.locations l on l.id=t.location_id and l.active=true where t.id=p_table_id and t.active=true;
 if v_location is null or not exists (
 select 1 from public.memberships m join public.restaurants r on r.id=m.restaurant_id
 where m.restaurant_id=v_restaurant and m.user_id=(select auth.uid()) and m.status='active'
 and (r.owner_user_id=(select auth.uid()) or exists (
 select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('tables.manage','orders.create','settings.manage')
 ))
 and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=v_location))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 perform 1 from public.dining_tables where id=p_table_id for update;
 update public.qr_guest_sessions set status='closed',closed_at=now()
 where table_id=p_table_id and status='active' and expires_at<=now();
 if p_action='open' then
  if not exists(select 1 from public.qr_menu_settings where location_id=v_location and enabled=true) then
   raise exception 'El menú público no está habilitado';end if;
  if not exists(select 1 from public.table_order_sessions where table_id=p_table_id) and not exists(
   select 1 from public.order_table_links otl join public.orders o on o.id=otl.order_id
   where otl.table_id=p_table_id and otl.unlinked_at is null and o.status in ('draft','open','awaiting_payment')
  ) then raise exception 'Abre primero la mesa desde RestOS+ antes de habilitar pedidos QR';end if;
  insert into public.qr_guest_sessions(table_id,location_id,restaurant_id,access_code)
  values(p_table_id,v_location,v_restaurant,upper(substr(replace(gen_random_uuid()::text,'-',''),1,16)))
  on conflict do nothing;
 elsif p_action='close' then
  update public.qr_guest_sessions set status='closed',closed_at=now() where table_id=p_table_id and status='active';
 elsif p_action<>'read' then raise exception 'Acción no permitida';end if;
 select * into v_session from public.qr_guest_sessions where table_id=p_table_id and status='active' and expires_at>now() order by created_at desc limit 1;
 return jsonb_build_object('active',v_session.id is not null,'code',v_session.access_code,'expiresAt',v_session.expires_at);
end $function$
;

CREATE OR REPLACE FUNCTION public.submit_qr_guest_request(p_location_id uuid, p_qr_token uuid, p_access_code text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session uuid;v_line jsonb;v_prod public.products%rowtype;v_qty int;v_price numeric;v_total numeric:=0;v_items jsonb:='[]'::jsonb;v_request uuid;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>25 then
 raise exception 'Pedido inválido';end if;
 select q.table_id,q.restaurant_id into v_table,v_restaurant
 from public.table_qr_codes q join public.qr_menu_settings ms on ms.location_id=q.location_id and ms.enabled=true
 join public.dining_tables t on t.id=q.table_id and t.active=true
 where q.token=p_qr_token and q.location_id=p_location_id;
 if v_table is null then raise exception 'QR inválido';end if;
 perform 1 from public.dining_tables where id=v_table for update;
 select s.id into v_session from public.qr_guest_sessions s
 where s.table_id=v_table and s.location_id=p_location_id and s.restaurant_id=v_restaurant
 and s.status='active' and s.expires_at>now() and s.access_code=upper(trim(p_access_code))
 limit 1;
 if v_session is null then raise exception 'Código de autorización inválido o sesión finalizada';end if;
 if not exists(select 1 from public.table_order_sessions where table_id=v_table) and not exists(
 select 1 from public.order_table_links otl join public.orders o on o.id=otl.order_id
 where otl.table_id=v_table and otl.unlinked_at is null and o.status in ('draft','open','awaiting_payment')
 ) then raise exception 'Mesa cerrada: solicita al personal una nueva autorización';end if;
 if exists(select 1 from public.order_table_links otl join public.orders o on o.id=otl.order_id
 where otl.table_id=v_table and otl.unlinked_at is null and (o.status not in ('draft','open','awaiting_payment') or o.payment_status='paid')
 ) then raise exception 'La cuenta de esta mesa está cerrada';end if;
 for v_line in select value from jsonb_array_elements(p_items)
 loop
  if not (v_line ? 'productId') or not (v_line ? 'quantity') then raise exception 'Producto inválido';end if;
  if (v_line->>'quantity') !~ '^[0-9]{1,2}$' then raise exception 'Cantidad inválida';end if;
  v_qty:=(v_line->>'quantity')::int;
  if v_qty<1 or v_qty>20 then raise exception 'Cantidad fuera de rango';end if;
  select p.* into v_prod from public.products p where p.id=(v_line->>'productId')::uuid and p.restaurant_id=v_restaurant and p.active=true;
  if not found then raise exception 'Producto no disponible';end if;
  select coalesce(pl.price_override,v_prod.base_price) into v_price from public.product_locations pl
  where pl.product_id=v_prod.id and pl.location_id=p_location_id and pl.restaurant_id=v_restaurant and pl.active=true;
  if v_price is null then raise exception 'Producto no disponible en la sucursal';end if;
  v_total:=v_total+v_qty*v_price;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_prod.id,'name',v_prod.name,'quantity',v_qty,'unitPrice',v_price));
 end loop;
 insert into public.qr_guest_requests(session_id,table_id,location_id,restaurant_id,items,total)
 values(v_session,v_table,p_location_id,v_restaurant,v_items,v_total) returning id into v_request;
 return jsonb_build_object('ok',true,'requestId',v_request,'status','pending','total',v_total);
end $function$
;

revoke all on function public.manage_qr_guest_session(uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_session(uuid,text) to authenticated;
revoke all on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) from public;
grant execute on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) to anon,authenticated;
revoke all on function public.manage_qr_guest_requests(uuid,uuid,text) from public,anon;
grant execute on function public.manage_qr_guest_requests(uuid,uuid,text) to authenticated;
revoke all on function public.close_qr_session_when_table_released() from public;
revoke all on function public.close_qr_session_on_paid_order() from public;
drop trigger if exists close_qr_session_after_release on public.table_order_sessions;
create trigger close_qr_session_after_release after delete on public.table_order_sessions for each row execute function public.close_qr_session_when_table_released();
drop trigger if exists close_qr_session_when_paid on public.orders;
create trigger close_qr_session_when_paid after update of status,payment_status on public.orders for each row execute function public.close_qr_session_on_paid_order();
