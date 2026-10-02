create or replace function private.approve_access_request(
  p_request_id uuid,
  p_role_id uuid,
  p_location_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_request public.access_requests%rowtype;
  v_target_role public.roles%rowtype;
  v_membership_id uuid;
  v_actor uuid := (select auth.uid());
  v_owner_user_id uuid;
  v_effective_location_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select *
    into v_request
  from public.access_requests
  where id=p_request_id
  for update;

  if not found then
    raise exception 'Access request not found';
  end if;

  if not private.user_has_restaurant_permission(v_request.restaurant_id,'staff.manage') then
    raise exception 'Not authorized to manage staff for this restaurant';
  end if;

  if v_request.status<>'pending' then
    raise exception 'This request is no longer pending';
  end if;

  select *
    into v_target_role
  from public.roles r
  where r.id=p_role_id
    and r.restaurant_id=v_request.restaurant_id
    and r.active=true;

  if not found then
    raise exception 'Invalid role for this restaurant';
  end if;

  select owner_user_id
    into v_owner_user_id
  from public.restaurants
  where id=v_request.restaurant_id;

  if v_target_role.name='Owner / Super Admin' then
    raise exception 'The primary Owner role cannot be assigned to another user';
  end if;

  if v_target_role.company_scope
     and not private.user_has_restaurant_permission(v_request.restaurant_id,'company.control.view') then
    raise exception 'Corporate roles can only be assigned from Company Control';
  end if;

  v_effective_location_id := case
    when v_target_role.company_scope then null
    else p_location_id
  end;

  if v_effective_location_id is not null and not exists (
    select 1
    from public.locations l
    where l.id=v_effective_location_id
      and l.restaurant_id=v_request.restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid location for this restaurant';
  end if;

  update public.profiles
  set access_status='active',
      updated_at=now()
  where id=v_request.user_id;

  insert into public.memberships(
    restaurant_id,user_id,role_id,status,all_locations,approved_by,approved_at
  )
  values(
    v_request.restaurant_id,
    v_request.user_id,
    p_role_id,
    'active',
    v_target_role.company_scope or v_effective_location_id is null,
    v_actor,
    now()
  )
  on conflict(restaurant_id,user_id) do update
  set role_id=excluded.role_id,
      status='active',
      all_locations=excluded.all_locations,
      approved_by=excluded.approved_by,
      approved_at=excluded.approved_at,
      updated_at=now()
  returning id into v_membership_id;

  delete from public.membership_locations
  where membership_id=v_membership_id;

  if v_effective_location_id is not null then
    insert into public.membership_locations(membership_id,location_id)
    values(v_membership_id,v_effective_location_id);
  end if;

  update public.access_requests
  set status='approved',
      reviewed_by=v_actor,
      reviewed_at=now(),
      assigned_role_id=p_role_id
  where id=p_request_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_request.restaurant_id,
    v_actor,
    'membership',
    v_membership_id,
    'staff.approved',
    jsonb_build_object(
      'targetUserId',v_request.user_id,
      'roleId',p_role_id,
      'companyScope',v_target_role.company_scope,
      'locationId',v_effective_location_id
    )
  );

  return jsonb_build_object(
    'ok',true,
    'status','approved',
    'user_id',v_request.user_id,
    'membership_id',v_membership_id,
    'company_scope',v_target_role.company_scope
  );
end;
$function$;

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
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_membership public.memberships%rowtype;
  v_target_role public.roles%rowtype;
  v_owner_user_id uuid;
  v_previous_role_id uuid;
  v_name text := btrim(coalesce(p_full_name,''));
  v_username text := lower(btrim(coalesce(p_username,'')));
  v_phone text := nullif(btrim(coalesce(p_phone,'')),'');
  v_location_ids uuid[];
  v_all_locations boolean;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'staff.manage') then
    raise exception 'Not authorized to manage staff for this restaurant';
  end if;

  select m.*
    into v_membership
  from public.memberships m
  where m.id=p_membership_id
    and m.restaurant_id=p_restaurant_id
  for update;

  if not found then
    raise exception 'Staff membership not found';
  end if;

  select restaurant.owner_user_id
    into v_owner_user_id
  from public.restaurants restaurant
  where restaurant.id=p_restaurant_id;

  if v_membership.user_id=v_owner_user_id and v_actor<>v_owner_user_id then
    raise exception 'Only the primary Owner can edit the primary Owner account';
  end if;

  if v_name='' or char_length(v_name)<2 or char_length(v_name)>120 then
    raise exception 'Full name must contain between 2 and 120 characters';
  end if;

  if char_length(v_username)<3 or char_length(v_username)>40
     or v_username !~ '^[a-z0-9][a-z0-9._-]*$' then
    raise exception 'Username must contain 3 to 40 letters, numbers, dots, hyphens or underscores';
  end if;

  if v_phone is not null and char_length(v_phone)>30 then
    raise exception 'Phone number is too long';
  end if;

  if p_status not in ('active','suspended') then
    raise exception 'Invalid staff status';
  end if;

  select *
    into v_target_role
  from public.roles r
  where r.id=p_role_id
    and r.restaurant_id=p_restaurant_id
    and r.active=true;

  if not found then
    raise exception 'Invalid role for this restaurant';
  end if;

  if v_target_role.name='Owner / Super Admin'
     and v_membership.user_id<>v_owner_user_id then
    raise exception 'The primary Owner role cannot be assigned to another user';
  end if;

  if v_target_role.company_scope
     and not private.user_has_restaurant_permission(p_restaurant_id,'company.control.view') then
    raise exception 'Corporate roles can only be assigned from Company Control';
  end if;

  if v_membership.user_id=v_owner_user_id
     and (p_status<>'active' or p_role_id<>v_membership.role_id) then
    raise exception 'The primary Owner cannot be deactivated or assigned another role';
  end if;

  if v_membership.user_id=v_actor and p_status<>'active' then
    raise exception 'You cannot deactivate your own user';
  end if;

  select coalesce(array_agg(distinct location_id),'{}'::uuid[])
    into v_location_ids
  from unnest(coalesce(p_location_ids,'{}'::uuid[])) as selected(location_id)
  where location_id is not null;

  v_all_locations := coalesce(p_all_locations,false) or v_target_role.company_scope;

  if not v_all_locations then
    if cardinality(v_location_ids)=0 then
      raise exception 'Select at least one location';
    end if;

    if exists (
      select 1
      from unnest(v_location_ids) as selected(location_id)
      left join public.locations l
        on l.id=selected.location_id
       and l.restaurant_id=p_restaurant_id
       and l.active=true
      where l.id is null
    ) then
      raise exception 'One or more selected locations are invalid';
    end if;
  else
    v_location_ids := '{}'::uuid[];
  end if;

  v_previous_role_id := v_membership.role_id;

  update public.memberships
  set role_id=p_role_id,
      status=p_status,
      all_locations=v_all_locations,
      updated_at=now()
  where id=v_membership.id;

  delete from public.membership_locations
  where membership_id=v_membership.id;

  if not v_all_locations then
    insert into public.membership_locations(membership_id,location_id)
    select v_membership.id,location_id
    from unnest(v_location_ids) as selected(location_id);
  end if;

  begin
    update public.profiles
    set full_name=v_name,
        username=v_username,
        phone=v_phone,
        access_status=case
          when exists (
            select 1
            from public.memberships active_membership
            where active_membership.user_id=v_membership.user_id
              and active_membership.status='active'
          ) then 'active'
          else 'suspended'
        end,
        updated_at=now()
    where id=v_membership.user_id;
  exception
    when unique_violation then
      raise exception 'That username is already in use';
  end;

  update public.access_requests
  set assigned_role_id=p_role_id
  where restaurant_id=p_restaurant_id
    and user_id=v_membership.user_id
    and status='approved';

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,
    v_actor,
    'membership',
    v_membership.id,
    'staff.updated',
    jsonb_build_object(
      'target_user_id',v_membership.user_id,
      'previous_role_id',v_previous_role_id,
      'role_id',p_role_id,
      'company_scope',v_target_role.company_scope,
      'previous_status',v_membership.status,
      'status',p_status,
      'all_locations',v_all_locations,
      'location_ids',to_jsonb(v_location_ids)
    )
  );

  return jsonb_build_object(
    'ok',true,
    'membership_id',v_membership.id,
    'user_id',v_membership.user_id,
    'status',p_status,
    'company_scope',v_target_role.company_scope
  );
end;
$function$;

update public.roles r
set description=rp.description,
    company_scope=rp.company_scope,
    updated_at=now()
from public.role_presets rp
where r.is_system=true
  and r.name=rp.name;
