
alter table public.qr_menu_settings
 add column if not exists customer_ordering_enabled boolean not null default true;

create or replace function public.manage_qr_customer_ordering(
 p_location_id uuid,p_enabled boolean default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; enabled_now boolean;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active=true;
 if rid is null or not exists(
  select 1 from public.memberships m
  join public.restaurants r on r.id=m.restaurant_id
  where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
  and (r.owner_user_id=(select auth.uid()) or exists(
   select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code='settings.manage'))
  and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 ) then raise exception 'No autorizado para modificar pedidos QR' using errcode='42501';end if;
 if p_enabled is not null then
  insert into public.qr_menu_settings(location_id,restaurant_id,enabled,customer_ordering_enabled)
  values(p_location_id,rid,false,p_enabled)
  on conflict(location_id) do update set customer_ordering_enabled=excluded.customer_ordering_enabled,updated_at=now()
  where qr_menu_settings.restaurant_id=excluded.restaurant_id;
 end if;
 select customer_ordering_enabled into enabled_now from public.qr_menu_settings
 where location_id=p_location_id and restaurant_id=rid;
 return jsonb_build_object('enabled',coalesce(enabled_now,true));
end $$;
revoke all on function public.manage_qr_customer_ordering(uuid,boolean) from public,anon;
grant execute on function public.manage_qr_customer_ordering(uuid,boolean) to authenticated;
