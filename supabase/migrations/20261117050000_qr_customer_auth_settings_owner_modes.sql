alter table public.qr_menu_settings add column if not exists auth_mode text not null default 'required';
alter table public.qr_menu_settings drop constraint if exists qr_menu_settings_auth_mode_check;
alter table public.qr_menu_settings add constraint qr_menu_settings_auth_mode_check check(auth_mode in ('required','optional','disabled'));
alter table public.qr_guest_view_tokens add column if not exists customer_user_id uuid;
alter table public.qr_guest_requests add column if not exists customer_user_id uuid;
alter table public.qr_guest_requests add column if not exists view_token_id uuid references public.qr_guest_view_tokens(id);
CREATE OR REPLACE FUNCTION public.manage_qr_customer_auth(p_location_id uuid, p_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_restaurant uuid;v_current text;v_owner boolean;
begin
 select restaurant_id into v_restaurant from public.locations where id=p_location_id and active=true;
 if v_restaurant is null then raise exception 'Sucursal inválida' using errcode='42501'; end if;
 select exists(select 1 from public.restaurants r join public.memberships m on m.restaurant_id=r.id
  where r.id=v_restaurant and r.owner_user_id=(select auth.uid()) and m.user_id=(select auth.uid()) and m.status='active'
  and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id)))
 into v_owner;
 if not v_owner and not exists(select 1 from public.memberships m where m.restaurant_id=v_restaurant and m.user_id=(select auth.uid()) and m.status='active'
  and (m.all_locations=true or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
  and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code='settings.manage')) then
  raise exception 'No autorizado' using errcode='42501';
 end if;
 if p_mode is not null then
  if not v_owner then raise exception 'Solo el propietario puede cambiar la autenticación QR' using errcode='42501';end if;
  if p_mode not in ('required','optional','disabled') then raise exception 'Modo inválido';end if;
  insert into public.qr_menu_settings(location_id,restaurant_id,enabled,auth_mode)
  values(p_location_id,v_restaurant,false,p_mode)
  on conflict(location_id) do update set auth_mode=excluded.auth_mode,updated_at=now()
  where qr_menu_settings.restaurant_id=excluded.restaurant_id;
 end if;
 select auth_mode into v_current from public.qr_menu_settings where location_id=p_location_id and restaurant_id=v_restaurant;
 return jsonb_build_object('mode',coalesce(v_current,'required'),'ownerCanChange',v_owner);
end $function$
;
revoke all on function public.manage_qr_customer_auth(uuid,text) from public,anon;
grant execute on function public.manage_qr_customer_auth(uuid,text) to authenticated;
