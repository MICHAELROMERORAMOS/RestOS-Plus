create or replace function private.release_table_order_session(p_table_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_session public.table_order_sessions%rowtype;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_session
  from public.table_order_sessions
  where table_id = p_table_id
  for update;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.order_table_links otl
    join public.orders o on o.id = otl.order_id
    where otl.table_id = p_table_id
      and otl.unlinked_at is null
      and o.status in ('draft', 'open', 'awaiting_payment')
  ) then
    raise exception 'Table already has an active order';
  end if;

  if v_session.claimed_by <> v_user
     and not private.user_has_location_permission(v_session.location_id, 'tables.manage') then
    raise exception 'Not allowed to release this table';
  end if;

  delete from public.table_order_sessions
  where table_id = p_table_id;

  return found;
end;
$function$;
