
create table if not exists public.qr_table_order_settings(
 table_id uuid primary key references public.dining_tables(id) on delete cascade,
 location_id uuid not null references public.locations(id) on delete cascade,
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 enabled boolean not null default true,
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.qr_table_order_settings enable row level security;
revoke all on public.qr_table_order_settings from public,anon,authenticated;
create index if not exists qr_table_order_settings_scope_idx on public.qr_table_order_settings(location_id,restaurant_id);

create or replace function public.manage_qr_table_order_setting(p_location_id uuid,p_table_id uuid default null,p_enabled boolean default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;tbl uuid; permitted boolean; rows_json jsonb;
begin
 select l.restaurant_id into rid from public.locations l where l.id=p_location_id and l.active=true;
 if rid is null then raise exception 'Sucursal no válida' using errcode='42501';end if;
 select exists(
  select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
  and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
  and (exists(select 1 from public.restaurants r where r.id=rid and r.owner_user_id=(select auth.uid()))
   or exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('tables.manage','orders.create','payments.create','settings.manage')))
 ) into permitted;
 if not permitted then raise exception 'No tienes permiso para gestionar pedidos QR de esta sucursal' using errcode='42501';end if;
 if p_enabled is not null then
  if p_table_id is null then raise exception 'Selecciona una mesa';end if;
  select t.id into tbl from public.dining_tables t where t.id=p_table_id and t.location_id=p_location_id and t.active=true;
  if tbl is null then raise exception 'Mesa no válida en esta sucursal';end if;
  insert into public.qr_table_order_settings(table_id,location_id,restaurant_id,enabled,updated_by)
  values(tbl,p_location_id,rid,p_enabled,(select auth.uid()))
  on conflict(table_id) do update set enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=now()
    where qr_table_order_settings.location_id=excluded.location_id and qr_table_order_settings.restaurant_id=excluded.restaurant_id;
 end if;
 select coalesce(jsonb_object_agg(t.id::text,coalesce(s.enabled,true)),'{}'::jsonb) into rows_json
 from public.dining_tables t left join public.qr_table_order_settings s on s.table_id=t.id
 where t.location_id=p_location_id and t.active=true;
 return jsonb_build_object('enabledByTable',rows_json);
end $$;
revoke all on function public.manage_qr_table_order_setting(uuid,uuid,boolean) from public,anon;
grant execute on function public.manage_qr_table_order_setting(uuid,uuid,boolean) to authenticated;

create or replace function public.get_public_qr_table_order_permission(p_location_id uuid,p_qr_token uuid)
returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object('enabled',coalesce(s.enabled,true))
from public.table_qr_codes q
join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active=true
join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active=true
join public.restaurants r on r.id=q.restaurant_id and r.status='active'
left join public.qr_table_order_settings s on s.table_id=t.id and s.location_id=q.location_id and s.restaurant_id=q.restaurant_id
where q.location_id=p_location_id and q.token=p_qr_token limit 1
$$;
revoke all on function public.get_public_qr_table_order_permission(uuid,uuid) from public;
grant execute on function public.get_public_qr_table_order_permission(uuid,uuid) to anon,authenticated;
