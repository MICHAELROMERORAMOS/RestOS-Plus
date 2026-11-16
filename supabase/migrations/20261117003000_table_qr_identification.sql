-- QR identification per active dining table; identification is NOT ordering authorization.
create table if not exists public.table_qr_codes (
 table_id uuid primary key references public.dining_tables(id) on delete cascade,
 location_id uuid not null references public.locations(id) on delete cascade,
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 token uuid not null unique default gen_random_uuid(),
 regenerated_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
alter table public.table_qr_codes enable row level security;
revoke all on public.table_qr_codes from anon,authenticated;

create or replace function public.manage_table_qr_codes(p_location_id uuid,p_table_id uuid default null,p_regenerate boolean default false)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_restaurant_id uuid; v_tables jsonb;
begin
 select l.restaurant_id into v_restaurant_id from public.locations l where l.id=p_location_id and l.active=true;
 if v_restaurant_id is null or not exists (
 select 1 from public.memberships m
 join public.restaurants r on r.id=m.restaurant_id
 where m.restaurant_id=v_restaurant_id and m.user_id=(select auth.uid()) and m.status='active'
 and (r.owner_user_id=(select auth.uid()) or exists (
 select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('tables.manage','settings.manage')))
 and (m.all_locations=true or exists (
 select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 ) then raise exception 'No autorizado para administrar códigos QR de esta sucursal' using errcode='42501'; end if;
 if p_regenerate and (p_table_id is null or not exists (
 select 1 from public.dining_tables t where t.id=p_table_id and t.location_id=p_location_id and t.active=true
 )) then raise exception 'Mesa no válida' using errcode='22023'; end if;
 insert into public.table_qr_codes(table_id,location_id,restaurant_id)
 select t.id,t.location_id,v_restaurant_id from public.dining_tables t
 where t.location_id=p_location_id and t.active=true on conflict(table_id) do nothing;
 if p_regenerate then
 update public.table_qr_codes q set token=gen_random_uuid(),regenerated_at=now()
 where q.table_id=p_table_id and q.location_id=p_location_id and q.restaurant_id=v_restaurant_id;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
 'tableId',t.id,'tableName',t.name,'zoneName',z.name,'locationId',t.location_id,
 'token',q.token::text,'regeneratedAt',q.regenerated_at) order by z.name,t.name),'[]'::jsonb)
 into v_tables
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active=true
 join public.dining_zones z on z.id=t.zone_id and z.location_id=t.location_id
 where q.location_id=p_location_id and q.restaurant_id=v_restaurant_id;
 return jsonb_build_object('tables',v_tables);
end $$;
revoke all on function public.manage_table_qr_codes(uuid,uuid,boolean) from public,anon;
grant execute on function public.manage_table_qr_codes(uuid,uuid,boolean) to authenticated;

create or replace function public.resolve_public_qr_table(p_location_id uuid,p_token uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
 select jsonb_build_object('tableId',t.id,'tableName',t.name,'zoneName',z.name,'locationId',t.location_id)
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.active=true and t.location_id=q.location_id
 join public.dining_zones z on z.id=t.zone_id and z.location_id=t.location_id and z.active=true
 join public.locations l on l.id=q.location_id and l.active=true and l.restaurant_id=q.restaurant_id
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 join public.qr_menu_settings ms on ms.location_id=l.id and ms.restaurant_id=r.id and ms.enabled=true
 where q.location_id=p_location_id and q.token=p_token limit 1;
$$;
revoke all on function public.resolve_public_qr_table(uuid,uuid) from public;
grant execute on function public.resolve_public_qr_table(uuid,uuid) to anon,authenticated;
