create or replace function private.approve_company_registration_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_request public.company_registration_requests%rowtype;
  v_restaurant_id uuid;
  v_location_id uuid;
  v_role_id uuid;
  v_owner_role_id uuid;
  v_preset record;
  v_join_code text;
begin
  if not private.is_platform_admin(v_actor) then
    raise exception 'Platform administrator access required';
  end if;

  select * into v_request
  from public.company_registration_requests
  where id=p_request_id
  for update;

  if not found then raise exception 'Company request not found'; end if;
  if v_request.status<>'pending' then raise exception 'Company request is no longer pending'; end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id=v_request.user_id and m.status='active'
  ) then
    raise exception 'Applicant already belongs to an active company';
  end if;

  v_join_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.restaurants(
    name,legal_name,tax_id,email,phone,currency_code,timezone,status,owner_user_id,join_code
  )
  values(
    v_request.company_name,
    nullif(v_request.legal_name,''),
    nullif(v_request.tax_id,''),
    nullif(v_request.company_email,'')::extensions.citext,
    nullif(v_request.company_phone,''),
    v_request.currency_code,
    v_request.timezone,
    'active',
    v_request.user_id,
    v_join_code
  )
  returning id into v_restaurant_id;

  insert into public.company_profiles(
    restaurant_id,legal_name,trade_name,nit,verification_digit,tax_regime,
    tax_responsibilities,address,city,department,phone,email
  )
  values(
    v_restaurant_id,
    coalesce(nullif(v_request.legal_name,''),v_request.company_name),
    v_request.company_name,
    v_request.tax_id,
    v_request.verification_digit,
    v_request.tax_regime,
    v_request.tax_responsibilities,
    v_request.address,
    v_request.city,
    v_request.region,
    v_request.company_phone,
    v_request.company_email
  );

  insert into public.restaurant_settings(restaurant_id,currency_code)
  values(v_restaurant_id,trim(v_request.currency_code::text));

  insert into public.locations(
    restaurant_id,name,code,address_line1,city,country,phone,active
  )
  values(
    v_restaurant_id,
    coalesce(nullif(v_request.primary_branch_name,''),'Principal'),
    'MAIN',
    nullif(v_request.address,''),
    nullif(v_request.city,''),
    nullif(v_request.country,''),
    nullif(v_request.company_phone,''),
    true
  )
  returning id into v_location_id;

  for v_preset in
    select rp.*
    from public.role_presets rp
    where rp.active=true
    order by rp.sort_order,rp.code
  loop
    insert into public.roles(
      restaurant_id,name,description,is_system,active
    )
    values(
      v_restaurant_id,v_preset.name,v_preset.description,true,true
    )
    returning id into v_role_id;

    insert into public.role_permissions(role_id,permission_code)
    select v_role_id,rpp.permission_code
    from public.role_preset_permissions rpp
    where rpp.preset_code=v_preset.code
    on conflict do nothing;

    if v_preset.code='owner' then
      v_owner_role_id := v_role_id;
    end if;
  end loop;

  if v_owner_role_id is null then
    raise exception 'Owner role preset is not configured';
  end if;

  insert into public.memberships(
    restaurant_id,user_id,role_id,status,all_locations,approved_by,approved_at
  )
  values(
    v_restaurant_id,v_request.user_id,v_owner_role_id,'active',true,v_actor,now()
  );

  update public.profiles
  set access_status='active',updated_at=now()
  where id=v_request.user_id;

  update public.company_registration_requests
  set
    status='approved',
    restaurant_id=v_restaurant_id,
    reviewed_by=v_actor,
    reviewed_at=now(),
    review_note=null,
    updated_at=now()
  where id=v_request.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_restaurant_id,
    v_actor,
    'restaurant',
    v_restaurant_id,
    'company_registration_approved',
    jsonb_build_object(
      'ownerUserId',v_request.user_id,
      'primaryLocationId',v_location_id,
      'joinCode',v_join_code
    )
  );

  return jsonb_build_object(
    'ok',true,
    'restaurant_id',v_restaurant_id,
    'location_id',v_location_id,
    'company_name',v_request.company_name,
    'join_code',v_join_code,
    'owner_user_id',v_request.user_id
  );
end;
$function$;
