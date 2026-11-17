-- Expose only per-table pending QR request counts to authorized branch staff.
CREATE OR REPLACE FUNCTION public.get_table_qr_pending_counts(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_restaurant_id uuid;v_counts jsonb;
begin
  select l.restaurant_id into v_restaurant_id
  from public.locations l where l.id=p_location_id and l.active=true;
  if v_restaurant_id is null or not exists (
    select 1 from public.memberships m
    join public.restaurants r on r.id=m.restaurant_id
    where m.restaurant_id=v_restaurant_id
      and m.user_id=(select auth.uid()) and m.status='active'
      and (r.owner_user_id=(select auth.uid()) or exists(
        select 1 from public.role_permissions rp
        where rp.role_id=m.role_id and rp.permission_code in
          ('tables.view','tables.manage','orders.create','payments.create')
      ))
      and (m.all_locations=true or exists (
        select 1 from public.membership_locations ml
        where ml.membership_id=m.id and ml.location_id=p_location_id
      ))
  ) then
    raise exception 'No autorizado' using errcode='42501';
  end if;
  select coalesce(jsonb_object_agg(x.table_id::text,x.pending_count),'{}'::jsonb) into v_counts
  from (
    select q.table_id,count(*)::integer as pending_count
    from public.qr_guest_requests q
    where q.location_id=p_location_id and q.restaurant_id=v_restaurant_id
      and q.status='pending'
    group by q.table_id
  ) x;
  return jsonb_build_object('pendingByTable',v_counts);
end $function$
;
revoke all on function public.get_table_qr_pending_counts(uuid) from public,anon;
grant execute on function public.get_table_qr_pending_counts(uuid) to authenticated;
