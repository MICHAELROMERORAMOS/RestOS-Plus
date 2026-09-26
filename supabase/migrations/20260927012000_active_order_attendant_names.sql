create or replace function private.load_order_attendants(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'order_id', o.id,
        'opened_by_name', coalesce(
          nullif(btrim(p.full_name), ''),
          nullif(btrim(p.username::text), ''),
          nullif(split_part(p.email::text, '@', 1), ''),
          'Usuario'
        )
      )
      order by o.opened_at, o.order_number
    ),
    '[]'::jsonb
  )
  into v_result
  from public.orders o
  left join public.profiles p on p.id = o.opened_by
  where o.restaurant_id = p_restaurant_id
    and o.location_id = p_location_id
    and (
      p_order_ids is null
      or o.id = any(p_order_ids)
    )
    and (
      p_order_ids is not null
      or o.status not in ('closed', 'cancelled')
      or o.refund_due > 0.005
    );

  return v_result;
end;
$function$;

create or replace function public.load_order_attendants(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_ids uuid[] default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select private.load_order_attendants(p_restaurant_id, p_location_id, p_order_ids);
$function$;

revoke all on function public.load_order_attendants(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.load_order_attendants(uuid, uuid, uuid[]) to authenticated;
grant execute on function private.load_order_attendants(uuid, uuid, uuid[]) to authenticated;
revoke all on function private.load_order_attendants(uuid, uuid, uuid[]) from public, anon;
