revoke select on table public.product_unavailability_requests from authenticated;

create or replace function private.load_product_unavailability_state(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns table(
  request_id uuid,
  product_id uuid,
  reason text,
  unavailable_until timestamptz
)
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id,'products.view') then
    raise exception 'Not authorized to view products in this branch';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id=p_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid branch';
  end if;

  return query
  select pur.id,pur.product_id,pur.reason,pur.unavailable_until
  from public.product_unavailability_requests pur
  where pur.restaurant_id=p_restaurant_id
    and pur.location_id=p_location_id
    and pur.status='approved'
    and pur.unavailable_until>now()
  order by pur.unavailable_until desc;
end;
$function$;

create or replace function public.load_product_unavailability_state(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns table(
  request_id uuid,
  product_id uuid,
  reason text,
  unavailable_until timestamptz
)
language sql
stable
set search_path=''
as $function$
  select * from private.load_product_unavailability_state(
    p_restaurant_id,p_location_id
  );
$function$;

create or replace function private.list_my_pending_product_unavailability(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns table(
  request_id uuid,
  product_id uuid,
  reason text,
  duration_minutes integer,
  authorization_expires_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(
    p_location_id,'products.availability.request'
  ) then
    raise exception 'Not authorized to request product unavailability in this branch';
  end if;

  return query
  select
    pur.id,pur.product_id,pur.reason,pur.duration_minutes,
    pur.authorization_expires_at,pur.email_sent_at,pur.created_at
  from public.product_unavailability_requests pur
  where pur.restaurant_id=p_restaurant_id
    and pur.location_id=p_location_id
    and pur.requested_by=v_actor
    and pur.status='pending'
    and pur.authorization_expires_at>now()
  order by pur.created_at desc;
end;
$function$;

create or replace function public.list_my_pending_product_unavailability(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns table(
  request_id uuid,
  product_id uuid,
  reason text,
  duration_minutes integer,
  authorization_expires_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz
)
language sql
stable
set search_path=''
as $function$
  select * from private.list_my_pending_product_unavailability(
    p_restaurant_id,p_location_id
  );
$function$;

revoke all on function private.load_product_unavailability_state(uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.load_product_unavailability_state(uuid,uuid)
  to authenticated;

revoke all on function public.load_product_unavailability_state(uuid,uuid)
  from public,anon;
grant execute on function public.load_product_unavailability_state(uuid,uuid)
  to authenticated;

revoke all on function private.list_my_pending_product_unavailability(uuid,uuid)
  from public,anon,authenticated;
grant execute on function private.list_my_pending_product_unavailability(uuid,uuid)
  to authenticated;

revoke all on function public.list_my_pending_product_unavailability(uuid,uuid)
  from public,anon;
grant execute on function public.list_my_pending_product_unavailability(uuid,uuid)
  to authenticated;
