create or replace function private.enforce_table_order_session_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_claimed_by uuid;
  v_is_initial_link boolean := false;
begin
  perform 1
  from public.dining_tables t
  where t.id = new.table_id
  for update;

  delete from public.table_order_sessions
  where table_id = new.table_id
    and last_seen_at < now() - interval '5 minutes';

  select claimed_by
  into v_claimed_by
  from public.table_order_sessions
  where table_id = new.table_id
  for update;

  if found then
    if v_user is null or v_claimed_by <> v_user then
      raise exception 'Table is being opened by another user';
    end if;

    delete from public.table_order_sessions
    where table_id = new.table_id
      and claimed_by = v_user;

    return new;
  end if;

  select
    not exists (
      select 1
      from public.order_rounds r
      where r.order_id = new.order_id
    )
    and not exists (
      select 1
      from public.order_table_links l
      where l.order_id = new.order_id
        and l.unlinked_at is null
    )
  into v_is_initial_link;

  if v_is_initial_link then
    raise exception 'Table session is no longer active. Open the table again before sending the order';
  end if;

  return new;
end;
$function$;
