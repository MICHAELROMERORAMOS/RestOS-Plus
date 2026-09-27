-- Multi-company onboarding and platform administration.
-- Applied to Supabase as migration: multi_company_onboarding

alter table public.restaurants
  add column if not exists join_code text;

update public.restaurants
set join_code=upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))
where join_code is null or btrim(join_code)='';

alter table public.restaurants
  alter column join_code set default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  alter column join_code set not null;

create unique index if not exists restaurants_join_code_uidx
  on public.restaurants(upper(join_code));

create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

insert into public.platform_admins(user_id)
select r.owner_user_id
from public.restaurants r
where r.owner_user_id is not null
order by r.created_at
limit 1
on conflict (user_id) do update set active=true;

create table if not exists public.company_registration_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_name text not null,
  legal_name text not null default '',
  tax_id text not null default '',
  verification_digit text not null default '',
  tax_regime text not null default '',
  tax_responsibilities text not null default '',
  address text not null default '',
  city text not null default '',
  region text not null default '',
  country text not null default '',
  company_phone text not null default '',
  company_email text not null default '',
  currency_code char(3) not null default 'COP',
  timezone text not null default 'America/Bogota',
  primary_branch_name text not null default 'Principal',
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  updated_at timestamptz not null default now()
);

create unique index if not exists company_registration_one_pending_per_user_idx
  on public.company_registration_requests(user_id)
  where status='pending';

create index if not exists company_registration_status_requested_idx
  on public.company_registration_requests(status,requested_at desc);

create index if not exists company_registration_restaurant_idx
  on public.company_registration_requests(restaurant_id);

create index if not exists company_registration_reviewed_by_idx
  on public.company_registration_requests(reviewed_by);

alter table public.company_registration_requests enable row level security;

insert into public.role_preset_permissions(preset_code,permission_code)
values
  ('owner','branches.view'),
  ('owner','branches.manage'),
  ('owner','shifts.view'),
  ('owner','shifts.close'),
  ('manager','branches.view'),
  ('manager','shifts.view'),
  ('manager','shifts.close'),
  ('cashier','shifts.view'),
  ('cashier','shifts.close')
on conflict do nothing;

create or replace function private.is_platform_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  select p_user_id is not null
    and exists (
      select 1
      from public.platform_admins pa
      where pa.user_id=p_user_id
        and pa.active=true
    );
$function$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
set search_path=''
as $function$
  select private.is_platform_admin((select auth.uid()));
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  insert into public.profiles (
    id, full_name, email, phone, username, avatar_url, access_status
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.email,
    new.raw_user_meta_data ->> 'phone',
    nullif(new.raw_user_meta_data ->> 'username',''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    'pending'
  )
  on conflict (id) do update
  set
    full_name=coalesce(excluded.full_name,public.profiles.full_name),
    email=coalesce(excluded.email,public.profiles.email),
    phone=coalesce(excluded.phone,public.profiles.phone),
    username=coalesce(excluded.username,public.profiles.username),
    avatar_url=coalesce(excluded.avatar_url,public.profiles.avatar_url),
    updated_at=now();

  return new;
end;
$function$;

create or replace function private.submit_company_registration(
  p_company_name text,
  p_legal_name text default '',
  p_tax_id text default '',
  p_verification_digit text default '',
  p_tax_regime text default '',
  p_tax_responsibilities text default '',
  p_address text default '',
  p_city text default '',
  p_region text default '',
  p_country text default '',
  p_company_phone text default '',
  p_company_email text default '',
  p_currency_code text default 'COP',
  p_timezone text default 'America/Bogota',
  p_primary_branch_name text default 'Principal'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_company_name text := nullif(btrim(coalesce(p_company_name,'')),'');
  v_currency text := upper(btrim(coalesce(p_currency_code,'COP')));
  v_timezone text := nullif(btrim(coalesce(p_timezone,'')),'');
  v_request_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_company_name is null then raise exception 'Company name is required'; end if;
  if length(v_currency) <> 3 then raise exception 'Currency code must have 3 characters'; end if;
  if v_timezone is null then v_timezone := 'America/Bogota'; end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id=v_user and m.status='active'
  ) then
    raise exception 'User already belongs to an active company';
  end if;

  if exists (
    select 1 from public.company_registration_requests cr
    where cr.user_id=v_user and cr.status='pending'
  ) then
    raise exception 'You already have a pending company request';
  end if;

  insert into public.company_registration_requests(
    user_id,company_name,legal_name,tax_id,verification_digit,tax_regime,
    tax_responsibilities,address,city,region,country,company_phone,company_email,
    currency_code,timezone,primary_branch_name,status
  )
  values(
    v_user,
    v_company_name,
    btrim(coalesce(p_legal_name,'')),
    btrim(coalesce(p_tax_id,'')),
    btrim(coalesce(p_verification_digit,'')),
    btrim(coalesce(p_tax_regime,'')),
    btrim(coalesce(p_tax_responsibilities,'')),
    btrim(coalesce(p_address,'')),
    btrim(coalesce(p_city,'')),
    btrim(coalesce(p_region,'')),
    btrim(coalesce(p_country,'')),
    btrim(coalesce(p_company_phone,'')),
    lower(btrim(coalesce(p_company_email,''))),
    v_currency::char(3),
    v_timezone,
    coalesce(nullif(btrim(coalesce(p_primary_branch_name,'')),''),'Principal'),
    'pending'
  )
  returning id into v_request_id;

  update public.profiles
  set access_status='pending',updated_at=now()
  where id=v_user;

  return jsonb_build_object(
    'ok',true,
    'request_id',v_request_id,
    'status','pending',
    'company_name',v_company_name
  );
end;
$function$;

create or replace function public.submit_company_registration(
  p_company_name text,
  p_legal_name text default '',
  p_tax_id text default '',
  p_verification_digit text default '',
  p_tax_regime text default '',
  p_tax_responsibilities text default '',
  p_address text default '',
  p_city text default '',
  p_region text default '',
  p_country text default '',
  p_company_phone text default '',
  p_company_email text default '',
  p_currency_code text default 'COP',
  p_timezone text default 'America/Bogota',
  p_primary_branch_name text default 'Principal'
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.submit_company_registration(
    p_company_name,p_legal_name,p_tax_id,p_verification_digit,p_tax_regime,
    p_tax_responsibilities,p_address,p_city,p_region,p_country,p_company_phone,
    p_company_email,p_currency_code,p_timezone,p_primary_branch_name
  );
$function$;

create or replace function private.submit_company_access_request(p_join_code text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_restaurant public.restaurants%rowtype;
  v_request public.access_requests%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_restaurant
  from public.restaurants
  where upper(join_code)=upper(btrim(coalesce(p_join_code,'')))
    and status='active'
  limit 1;

  if not found then raise exception 'Company code not found'; end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id=v_user
      and m.restaurant_id=v_restaurant.id
      and m.status='active'
  ) then
    raise exception 'You already belong to this company';
  end if;

  select * into v_request
  from public.access_requests ar
  where ar.user_id=v_user
    and ar.restaurant_id=v_restaurant.id
  for update;

  if found then
    if v_request.status='pending' then
      return jsonb_build_object(
        'ok',true,'status','pending','company_name',v_restaurant.name,'request_id',v_request.id
      );
    end if;

    if v_request.status='approved' then
      raise exception 'This access request was already approved';
    end if;

    update public.access_requests
    set status='pending',
        requested_at=now(),
        reviewed_by=null,
        reviewed_at=null,
        assigned_role_id=null
    where id=v_request.id
    returning * into v_request;
  else
    insert into public.access_requests(user_id,restaurant_id,status)
    values(v_user,v_restaurant.id,'pending')
    returning * into v_request;
  end if;

  update public.profiles
  set access_status='pending',updated_at=now()
  where id=v_user;

  return jsonb_build_object(
    'ok',true,
    'status','pending',
    'company_name',v_restaurant.name,
    'request_id',v_request.id
  );
end;
$function$;

create or replace function public.submit_company_access_request(p_join_code text)
returns jsonb
language sql
set search_path=''
as $function$
  select private.submit_company_access_request(p_join_code);
$function$;

create or replace function private.get_my_onboarding_status()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_company_request record;
  v_access_request record;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id=v_user and m.status='active'
  ) then
    return jsonb_build_object('status','active');
  end if;

  select cr.*,r.name as created_company_name
  into v_company_request
  from public.company_registration_requests cr
  left join public.restaurants r on r.id=cr.restaurant_id
  where cr.user_id=v_user
  order by cr.requested_at desc
  limit 1;

  if found then
    if v_company_request.status='pending' then
      return jsonb_build_object(
        'status','company_pending',
        'company_name',v_company_request.company_name,
        'requested_at',v_company_request.requested_at
      );
    elsif v_company_request.status='rejected' then
      return jsonb_build_object(
        'status','company_rejected',
        'company_name',v_company_request.company_name,
        'review_note',v_company_request.review_note,
        'reviewed_at',v_company_request.reviewed_at
      );
    elsif v_company_request.status='approved' then
      return jsonb_build_object(
        'status','company_approved',
        'company_name',coalesce(v_company_request.created_company_name,v_company_request.company_name)
      );
    end if;
  end if;

  select ar.*,r.name as company_name
  into v_access_request
  from public.access_requests ar
  join public.restaurants r on r.id=ar.restaurant_id
  where ar.user_id=v_user
  order by ar.requested_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'status',
      case v_access_request.status
        when 'pending' then 'employee_pending'
        when 'rejected' then 'employee_rejected'
        when 'approved' then 'employee_approved'
        else 'onboarding_required'
      end,
      'company_name',v_access_request.company_name,
      'requested_at',v_access_request.requested_at,
      'reviewed_at',v_access_request.reviewed_at
    );
  end if;

  return jsonb_build_object('status','onboarding_required');
end;
$function$;

create or replace function public.get_my_onboarding_status()
returns jsonb
language sql
stable
set search_path=''
as $function$
  select private.get_my_onboarding_status();
$function$;

create or replace function private.list_platform_company_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
begin
  if not private.is_platform_admin(v_user) then
    raise exception 'Platform administrator access required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',cr.id,
      'userId',cr.user_id,
      'ownerName',coalesce(p.full_name,p.username,p.email::text),
      'ownerEmail',p.email,
      'ownerPhone',p.phone,
      'companyName',cr.company_name,
      'legalName',cr.legal_name,
      'taxId',cr.tax_id,
      'verificationDigit',cr.verification_digit,
      'taxRegime',cr.tax_regime,
      'taxResponsibilities',cr.tax_responsibilities,
      'address',cr.address,
      'city',cr.city,
      'region',cr.region,
      'country',cr.country,
      'companyPhone',cr.company_phone,
      'companyEmail',cr.company_email,
      'currencyCode',trim(cr.currency_code::text),
      'timezone',cr.timezone,
      'primaryBranchName',cr.primary_branch_name,
      'status',cr.status,
      'requestedAt',cr.requested_at,
      'reviewedAt',cr.reviewed_at,
      'reviewNote',cr.review_note,
      'restaurantId',cr.restaurant_id
    )
    order by
      case when cr.status='pending' then 0 else 1 end,
      cr.requested_at desc
  ),'[]'::jsonb)
  into v_result
  from public.company_registration_requests cr
  join public.profiles p on p.id=cr.user_id;

  return v_result;
end;
$function$;

create or replace function public.list_platform_company_requests()
returns jsonb
language sql
stable
set search_path=''
as $function$
  select private.list_platform_company_requests();
$function$;

create or replace function private.list_platform_companies()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
begin
  if not private.is_platform_admin(v_user) then
    raise exception 'Platform administrator access required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',r.id,
      'name',r.name,
      'legalName',r.legal_name,
      'taxId',r.tax_id,
      'email',r.email,
      'phone',r.phone,
      'currencyCode',trim(r.currency_code::text),
      'timezone',r.timezone,
      'status',r.status,
      'joinCode',r.join_code,
      'ownerUserId',r.owner_user_id,
      'ownerName',coalesce(p.full_name,p.username,p.email::text),
      'ownerEmail',p.email,
      'branchCount',(select count(*) from public.locations l where l.restaurant_id=r.id),
      'activeBranchCount',(select count(*) from public.locations l where l.restaurant_id=r.id and l.active=true),
      'activeUserCount',(select count(*) from public.memberships m where m.restaurant_id=r.id and m.status='active'),
      'createdAt',r.created_at
    )
    order by r.created_at desc
  ),'[]'::jsonb)
  into v_result
  from public.restaurants r
  left join public.profiles p on p.id=r.owner_user_id;

  return v_result;
end;
$function$;

create or replace function public.list_platform_companies()
returns jsonb
language sql
stable
set search_path=''
as $function$
  select private.list_platform_companies();
$function$;

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
    nullif(v_request.company_email,'')::public.email_address,
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

create or replace function public.approve_company_registration_request(p_request_id uuid)
returns jsonb
language sql
set search_path=''
as $function$
  select private.approve_company_registration_request(p_request_id);
$function$;

create or replace function private.reject_company_registration_request(
  p_request_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_request public.company_registration_requests%rowtype;
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

  update public.company_registration_requests
  set
    status='rejected',
    reviewed_by=v_actor,
    reviewed_at=now(),
    review_note=nullif(btrim(coalesce(p_reason,'')),''),
    updated_at=now()
  where id=p_request_id;

  return jsonb_build_object('ok',true,'status','rejected','user_id',v_request.user_id);
end;
$function$;

create or replace function public.reject_company_registration_request(
  p_request_id uuid,
  p_reason text default null
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.reject_company_registration_request(p_request_id,p_reason);
$function$;

create or replace function private.rotate_company_join_code(p_restaurant_id uuid)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_code text;
begin
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then
    raise exception 'Not allowed to manage company access code';
  end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
    exit when not exists (
      select 1 from public.restaurants r where upper(r.join_code)=v_code
    );
  end loop;

  update public.restaurants
  set join_code=v_code,updated_at=now()
  where id=p_restaurant_id;

  return v_code;
end;
$function$;

create or replace function public.rotate_company_join_code(p_restaurant_id uuid)
returns text
language sql
set search_path=''
as $function$
  select private.rotate_company_join_code(p_restaurant_id);
$function$;

create or replace function private.load_company_branches(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_result jsonb;
  v_can_manage boolean;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.view') then
    raise exception 'Not allowed to view branches';
  end if;

  v_can_manage := private.user_has_restaurant_permission(p_restaurant_id,'branches.manage');

  select jsonb_build_object(
    'company', jsonb_build_object(
      'id',r.id,
      'name',r.name,
      'legalName',r.legal_name,
      'taxId',r.tax_id,
      'email',r.email,
      'phone',r.phone,
      'currencyCode',trim(r.currency_code::text),
      'timezone',r.timezone,
      'status',r.status,
      'joinCode',case when v_can_manage then r.join_code else null end
    ),
    'branches',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',l.id,
          'name',l.name,
          'code',l.code,
          'addressLine1',l.address_line1,
          'addressLine2',l.address_line2,
          'city',l.city,
          'country',l.country,
          'phone',l.phone,
          'active',l.active,
          'createdAt',l.created_at,
          'updatedAt',l.updated_at,
          'assignedUsers',(
            select count(distinct m.user_id)
            from public.memberships m
            where m.restaurant_id=l.restaurant_id
              and m.status='active'
              and (
                m.all_locations
                or exists (
                  select 1 from public.membership_locations ml
                  where ml.membership_id=m.id and ml.location_id=l.id
                )
              )
          ),
          'openOrders',(
            select count(*)
            from public.orders o
            where o.location_id=l.id
              and o.status not in ('closed','cancelled','merged')
          )
        )
        order by l.active desc,l.created_at,l.name
      )
      from public.locations l
      where l.restaurant_id=r.id
    ),'[]'::jsonb)
  )
  into v_result
  from public.restaurants r
  where r.id=p_restaurant_id
    and r.status='active';

  if v_result is null then raise exception 'Company not found'; end if;
  return v_result;
end;
$function$;

revoke all on table public.platform_admins from anon,authenticated;
revoke all on table public.company_registration_requests from anon,authenticated;

revoke all on function public.is_platform_admin() from public,anon;
revoke all on function public.submit_company_registration(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) from public,anon;
revoke all on function public.submit_company_access_request(text) from public,anon;
revoke all on function public.get_my_onboarding_status() from public,anon;
revoke all on function public.list_platform_company_requests() from public,anon;
revoke all on function public.list_platform_companies() from public,anon;
revoke all on function public.approve_company_registration_request(uuid) from public,anon;
revoke all on function public.reject_company_registration_request(uuid,text) from public,anon;
revoke all on function public.rotate_company_join_code(uuid) from public,anon;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.submit_company_registration(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.submit_company_access_request(text) to authenticated;
grant execute on function public.get_my_onboarding_status() to authenticated;
grant execute on function public.list_platform_company_requests() to authenticated;
grant execute on function public.list_platform_companies() to authenticated;
grant execute on function public.approve_company_registration_request(uuid) to authenticated;
grant execute on function public.reject_company_registration_request(uuid,text) to authenticated;
grant execute on function public.rotate_company_join_code(uuid) to authenticated;
