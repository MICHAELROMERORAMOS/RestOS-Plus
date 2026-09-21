create or replace function private.list_staff_members(
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_members jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id, 'staff.view') then
    raise exception 'Not authorized to view staff for this restaurant';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'membership_id', m.id,
        'user_id', m.user_id,
        'full_name', p.full_name,
        'email', p.email::text,
        'phone', p.phone,
        'username', p.username::text,
        'access_status', p.access_status,
        'membership_status', m.status,
        'role_id', m.role_id,
        'role_name', r.name,
        'all_locations', m.all_locations,
        'location_ids', coalesce(
          (
            select jsonb_agg(ml.location_id order by l.name)
            from public.membership_locations ml
            join public.locations l on l.id = ml.location_id
            where ml.membership_id = m.id
          ),
          '[]'::jsonb
        ),
        'is_restaurant_owner', restaurant.owner_user_id = m.user_id,
        'is_current_user', m.user_id = v_actor,
        'created_at', m.created_at,
        'updated_at', m.updated_at
      )
      order by
        case when restaurant.owner_user_id = m.user_id then 0 else 1 end,
        case when m.status = 'active' then 0 else 1 end,
        lower(coalesce(p.full_name, p.email::text, ''))
    ),
    '[]'::jsonb
  )
  into v_members
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  left join public.roles r on r.id = m.role_id
  join public.restaurants restaurant on restaurant.id = m.restaurant_id
  where m.restaurant_id = p_restaurant_id
    and m.status in ('active', 'suspended');

  return v_members;
end;
$$;

create or replace function private.update_staff_member(
  p_restaurant_id uuid,
  p_membership_id uuid,
  p_full_name text,
  p_username text,
  p_phone text,
  p_role_id uuid,
  p_status text,
  p_all_locations boolean,
  p_location_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_membership public.memberships%rowtype;
  v_owner_user_id uuid;
  v_previous_role_id uuid;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_location_ids uuid[];
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id, 'staff.manage') then
    raise exception 'Not authorized to manage staff for this restaurant';
  end if;

  select m.*
  into v_membership
  from public.memberships m
  where m.id = p_membership_id
    and m.restaurant_id = p_restaurant_id
  for update;

  if not found then
    raise exception 'Staff membership not found';
  end if;

  select restaurant.owner_user_id
  into v_owner_user_id
  from public.restaurants restaurant
  where restaurant.id = p_restaurant_id;

  if v_name = '' or char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Full name must contain between 2 and 120 characters';
  end if;

  if char_length(v_username) < 3 or char_length(v_username) > 40
     or v_username !~ '^[a-z0-9][a-z0-9._-]*$' then
    raise exception 'Username must contain 3 to 40 letters, numbers, dots, hyphens or underscores';
  end if;

  if v_phone is not null and char_length(v_phone) > 30 then
    raise exception 'Phone number is too long';
  end if;

  if p_status not in ('active', 'suspended') then
    raise exception 'Invalid staff status';
  end if;

  if not exists (
    select 1
    from public.roles r
    where r.id = p_role_id
      and r.restaurant_id = p_restaurant_id
      and r.active = true
  ) then
    raise exception 'Invalid role for this restaurant';
  end if;

  if v_membership.user_id = v_owner_user_id
     and (p_status <> 'active' or p_role_id <> v_membership.role_id) then
    raise exception 'The primary Owner cannot be deactivated or assigned another role';
  end if;

  if v_membership.user_id = v_actor and p_status <> 'active' then
    raise exception 'You cannot deactivate your own user';
  end if;

  select coalesce(array_agg(distinct location_id), '{}'::uuid[])
  into v_location_ids
  from unnest(coalesce(p_location_ids, '{}'::uuid[])) as selected(location_id)
  where location_id is not null;

  if not coalesce(p_all_locations, false) then
    if cardinality(v_location_ids) = 0 then
      raise exception 'Select at least one location';
    end if;

    if exists (
      select 1
      from unnest(v_location_ids) as selected(location_id)
      left join public.locations l
        on l.id = selected.location_id
       and l.restaurant_id = p_restaurant_id
       and l.active = true
      where l.id is null
    ) then
      raise exception 'One or more selected locations are invalid';
    end if;
  end if;

  v_previous_role_id := v_membership.role_id;

  update public.memberships
  set role_id = p_role_id,
      status = p_status,
      all_locations = coalesce(p_all_locations, false),
      updated_at = now()
  where id = v_membership.id;

  delete from public.membership_locations
  where membership_id = v_membership.id;

  if not coalesce(p_all_locations, false) then
    insert into public.membership_locations (membership_id, location_id)
    select v_membership.id, location_id
    from unnest(v_location_ids) as selected(location_id);
  end if;

  begin
    update public.profiles
    set full_name = v_name,
        username = v_username,
        phone = v_phone,
        access_status = case
          when exists (
            select 1
            from public.memberships active_membership
            where active_membership.user_id = v_membership.user_id
              and active_membership.status = 'active'
          ) then 'active'
          else 'suspended'
        end,
        updated_at = now()
    where id = v_membership.user_id;
  exception
    when unique_violation then
      raise exception 'That username is already in use';
  end;

  update public.access_requests
  set assigned_role_id = p_role_id
  where restaurant_id = p_restaurant_id
    and user_id = v_membership.user_id
    and status = 'approved';

  insert into public.audit_logs (
    restaurant_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  )
  values (
    p_restaurant_id,
    v_actor,
    'membership',
    v_membership.id,
    'staff.updated',
    jsonb_build_object(
      'target_user_id', v_membership.user_id,
      'previous_role_id', v_previous_role_id,
      'role_id', p_role_id,
      'previous_status', v_membership.status,
      'status', p_status,
      'all_locations', coalesce(p_all_locations, false),
      'location_ids', to_jsonb(v_location_ids)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'membership_id', v_membership.id,
    'user_id', v_membership.user_id,
    'status', p_status
  );
end;
$$;

create or replace function public.list_staff_members(
  p_restaurant_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.list_staff_members(p_restaurant_id);
$$;

create or replace function public.update_staff_member(
  p_restaurant_id uuid,
  p_membership_id uuid,
  p_full_name text,
  p_username text,
  p_phone text,
  p_role_id uuid,
  p_status text,
  p_all_locations boolean,
  p_location_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.update_staff_member(
    p_restaurant_id,
    p_membership_id,
    p_full_name,
    p_username,
    p_phone,
    p_role_id,
    p_status,
    p_all_locations,
    p_location_ids
  );
$$;

revoke all on function private.list_staff_members(uuid) from public, anon;
revoke all on function private.update_staff_member(uuid, uuid, text, text, text, uuid, text, boolean, uuid[]) from public, anon;
grant execute on function private.list_staff_members(uuid) to authenticated, service_role;
grant execute on function private.update_staff_member(uuid, uuid, text, text, text, uuid, text, boolean, uuid[]) to authenticated, service_role;

revoke all on function public.list_staff_members(uuid) from public, anon;
revoke all on function public.update_staff_member(uuid, uuid, text, text, text, uuid, text, boolean, uuid[]) from public, anon;
grant execute on function public.list_staff_members(uuid) to authenticated, service_role;
grant execute on function public.update_staff_member(uuid, uuid, text, text, text, uuid, text, boolean, uuid[]) to authenticated, service_role;

-- A logged-in user receives only changes to their own membership because the
-- memberships_select_self RLS policy is evaluated before Realtime delivers it.
-- This makes role changes and suspensions take effect without client polling.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'memberships'
  ) then
    execute 'alter publication supabase_realtime add table public.memberships';
  end if;
end;
$$;
