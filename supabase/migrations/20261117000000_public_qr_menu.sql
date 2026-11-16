-- RestOS+ public QR menu (read-only, opt-in by branch)
create table if not exists public.qr_menu_settings (
 location_id uuid primary key references public.locations(id) on delete cascade,
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 enabled boolean not null default false,
 updated_at timestamptz not null default now(),
 constraint qr_menu_settings_location_restaurant_unique unique (location_id,restaurant_id)
);
alter table public.qr_menu_settings enable row level security;
revoke all on public.qr_menu_settings from anon,authenticated;

create or replace function public.get_public_qr_menu(p_location_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
 select jsonb_build_object(
 'restaurant',jsonb_build_object('name',r.name,'logoUrl',r.logo_url,'currency',coalesce(s.currency_code,r.currency_code)),
 'location',jsonb_build_object('name',l.name),
 'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'description',c.description) order by c.display_order,c.name) from public.menu_categories c where c.restaurant_id=r.id and c.active is true),'[]'::jsonb),
 'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'categoryId',p.category_id,'name',p.name,'description',p.description,'imageUrl',p.image_url,'price',coalesce(pl.price_override,p.base_price)) order by p.name)
 from public.products p join public.product_locations pl on pl.product_id=p.id and pl.restaurant_id=r.id and pl.location_id=l.id and pl.active is true where p.restaurant_id=r.id and p.active is true),'[]'::jsonb)
 ) from public.qr_menu_settings q
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active is true
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 left join public.restaurant_settings s on s.restaurant_id=r.id
 where q.location_id=p_location_id and q.enabled is true limit 1
$$;
revoke all on function public.get_public_qr_menu(uuid) from public;
grant execute on function public.get_public_qr_menu(uuid) to anon,authenticated;

create or replace function public.manage_qr_menu(p_location_id uuid,p_enabled boolean default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_restaurant_id uuid; v_enabled boolean;
begin
 select l.restaurant_id into v_restaurant_id from public.locations l where l.id=p_location_id;
 if v_restaurant_id is null or not exists(
 select 1 from public.memberships m join public.restaurants r on r.id=m.restaurant_id
 where m.restaurant_id=v_restaurant_id and m.user_id=(select auth.uid()) and m.status='active'
 and (r.owner_user_id=(select auth.uid()) or exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code='settings.manage'))
 and (m.all_locations is true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 ) then raise exception 'No autorizado para administrar el menú QR de esta sucursal' using errcode='42501'; end if;
 if p_enabled is not null then
 insert into public.qr_menu_settings(location_id,restaurant_id,enabled) values(p_location_id,v_restaurant_id,p_enabled)
 on conflict(location_id) do update set enabled=excluded.enabled,updated_at=now()
 where qr_menu_settings.restaurant_id=excluded.restaurant_id;
 end if;
 select coalesce(q.enabled,false) into v_enabled from public.qr_menu_settings q where q.location_id=p_location_id;
 return jsonb_build_object('enabled',coalesce(v_enabled,false),'locationId',p_location_id);
end $$;
revoke all on function public.manage_qr_menu(uuid,boolean) from public,anon;
grant execute on function public.manage_qr_menu(uuid,boolean) to authenticated;
