alter table public.restaurants
  add column if not exists subscription_started_at date,
  add column if not exists allowed_branch_count integer;

update public.restaurants
set subscription_started_at=created_at::date
where subscription_started_at is null;

update public.restaurants r
set allowed_branch_count=greatest(
  1,
  (select count(*)::integer from public.locations l where l.restaurant_id=r.id and l.active=true)
)
where allowed_branch_count is null;

alter table public.restaurants
  alter column subscription_started_at set default current_date,
  alter column subscription_started_at set not null,
  alter column allowed_branch_count set default 1,
  alter column allowed_branch_count set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.restaurants'::regclass
      and conname='restaurants_allowed_branch_count_check'
  ) then
    alter table public.restaurants
      add constraint restaurants_allowed_branch_count_check
      check (allowed_branch_count >= 1 and allowed_branch_count <= 1000);
  end if;
end;
$$;

create or replace function private.enforce_restaurant_branch_limit()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare
  v_limit integer;
  v_active_count integer;
begin
  if new.active is not true then return new; end if;
  if tg_op='UPDATE' and old.active is true and old.restaurant_id=new.restaurant_id then return new; end if;

  select r.allowed_branch_count into v_limit
  from public.restaurants r
  where r.id=new.restaurant_id
  for update;

  if v_limit is null then raise exception 'Company not found'; end if;

  select count(*)::integer into v_active_count
  from public.locations l
  where l.restaurant_id=new.restaurant_id
    and l.active=true
    and (tg_op='INSERT' or l.id<>new.id);

  if v_active_count >= v_limit then
    raise exception 'Active branch limit reached';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_restaurant_branch_limit on public.locations;
create trigger trg_enforce_restaurant_branch_limit
before insert or update of active,restaurant_id on public.locations
for each row execute function private.enforce_restaurant_branch_limit();

create or replace function private.update_platform_company_subscription(
  p_restaurant_id uuid,
  p_subscription_started_at date,
  p_allowed_branch_count integer
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_active_count integer;
  v_restaurant public.restaurants%rowtype;
begin
  if not private.is_platform_admin(v_actor) then raise exception 'Platform administrator access required'; end if;
  if p_subscription_started_at is null then raise exception 'Subscription date is required'; end if;
  if p_allowed_branch_count is null or p_allowed_branch_count < 1 or p_allowed_branch_count > 1000 then
    raise exception 'Allowed branch count must be between 1 and 1000';
  end if;

  select * into v_restaurant from public.restaurants where id=p_restaurant_id for update;
  if not found then raise exception 'Company not found'; end if;

  select count(*)::integer into v_active_count
  from public.locations
  where restaurant_id=p_restaurant_id and active=true;

  if p_allowed_branch_count < v_active_count then
    raise exception 'Allowed branch count cannot be lower than active branch count';
  end if;

  update public.restaurants
  set subscription_started_at=p_subscription_started_at,
      allowed_branch_count=p_allowed_branch_count,
      updated_at=now()
  where id=p_restaurant_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  ) values (
    p_restaurant_id,v_actor,'restaurant',p_restaurant_id,'platform_subscription_updated',
    jsonb_build_object(
      'subscriptionStartedAt',p_subscription_started_at,
      'allowedBranchCount',p_allowed_branch_count,
      'activeBranchCount',v_active_count
    )
  );

  return jsonb_build_object(
    'ok',true,
    'restaurantId',p_restaurant_id,
    'subscriptionStartedAt',p_subscription_started_at,
    'allowedBranchCount',p_allowed_branch_count,
    'activeBranchCount',v_active_count
  );
end;
$function$;

create or replace function public.update_platform_company_subscription(
  p_restaurant_id uuid,
  p_subscription_started_at date,
  p_allowed_branch_count integer
)
returns jsonb language sql set search_path=''
as $function$
  select private.update_platform_company_subscription(
    p_restaurant_id,p_subscription_started_at,p_allowed_branch_count
  );
$function$;

revoke all on function private.update_platform_company_subscription(uuid,date,integer)
from public,anon,authenticated;
revoke all on function public.update_platform_company_subscription(uuid,date,integer)
from public,anon;
grant execute on function public.update_platform_company_subscription(uuid,date,integer)
to authenticated;

create or replace function private.list_platform_companies()
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
begin
  if not private.is_platform_admin(v_user) then raise exception 'Platform administrator access required'; end if;

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
      'allowedBranchCount',r.allowed_branch_count,
      'subscriptionStartedAt',r.subscription_started_at,
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

create or replace function private.load_company_branches(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
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
      'joinCode',case when v_can_manage then r.join_code else null end,
      'subscriptionStartedAt',r.subscription_started_at,
      'allowedBranchCount',r.allowed_branch_count,
      'activeBranchCount',(
        select count(*) from public.locations active_l
        where active_l.restaurant_id=r.id and active_l.active=true
      )
    ),
    'branches',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',l.id,'name',l.name,'code',l.code,'addressLine1',l.address_line1,
          'addressLine2',l.address_line2,'city',l.city,'country',l.country,'phone',l.phone,
          'active',l.active,'createdAt',l.created_at,'updatedAt',l.updated_at,
          'invoicePrefix',l.invoice_prefix,'nextInvoiceNumber',l.next_invoice_number,
          'nextInvoice',('FAC-' || l.invoice_prefix || '-' || lpad(l.next_invoice_number::text,6,'0')),
          'invoicePrefixLocked',exists(select 1 from public.sales_invoices si where si.location_id=l.id),
          'assignedUsers',(
            select count(distinct m.user_id)
            from public.memberships m
            where m.restaurant_id=l.restaurant_id and m.status='active'
              and (m.all_locations or exists (
                select 1 from public.membership_locations ml
                where ml.membership_id=m.id and ml.location_id=l.id
              ))
          ),
          'openOrders',(
            select count(*) from public.orders o
            where o.location_id=l.id and o.status not in ('closed','cancelled','merged')
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
  where r.id=p_restaurant_id and r.status='active';

  if v_result is null then raise exception 'Company not found'; end if;
  return v_result;
end;
$function$;

create or replace function private.save_company_branch(
  p_restaurant_id uuid,p_branch_id uuid,p_name text,p_code text,
  p_address_line1 text default null,p_address_line2 text default null,
  p_city text default null,p_country text default null,p_phone text default null
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_name text := nullif(btrim(coalesce(p_name,'')),'');
  v_code text := upper(nullif(btrim(coalesce(p_code,'')),''));
  v_branch public.locations%rowtype;
  v_membership public.memberships%rowtype;
  v_allowed_branch_count integer;
  v_active_branch_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then raise exception 'Not allowed to manage branches'; end if;
  if v_name is null then raise exception 'Branch name is required'; end if;
  if v_code is null then v_code := 'BR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)); end if;

  select r.allowed_branch_count into v_allowed_branch_count
  from public.restaurants r where r.id=p_restaurant_id for update;
  if not found then raise exception 'Company not found'; end if;

  select * into v_membership from public.memberships
  where user_id=v_user and restaurant_id=p_restaurant_id and status='active' limit 1;

  if p_branch_id is null then
    select count(*)::integer into v_active_branch_count
    from public.locations where restaurant_id=p_restaurant_id and active=true;

    if v_active_branch_count >= v_allowed_branch_count then raise exception 'Active branch limit reached'; end if;

    insert into public.locations(
      restaurant_id,name,code,address_line1,address_line2,city,country,phone,active
    ) values (
      p_restaurant_id,v_name,v_code,
      nullif(btrim(coalesce(p_address_line1,'')),''),
      nullif(btrim(coalesce(p_address_line2,'')),''),
      nullif(btrim(coalesce(p_city,'')),''),
      nullif(btrim(coalesce(p_country,'')),''),
      nullif(btrim(coalesce(p_phone,'')),''),
      true
    )
    returning * into v_branch;

    if v_membership.id is not null and not v_membership.all_locations then
      insert into public.membership_locations(membership_id,location_id)
      values(v_membership.id,v_branch.id) on conflict do nothing;
    end if;
  else
    update public.locations
    set name=v_name,code=v_code,
        address_line1=nullif(btrim(coalesce(p_address_line1,'')),''),
        address_line2=nullif(btrim(coalesce(p_address_line2,'')),''),
        city=nullif(btrim(coalesce(p_city,'')),''),
        country=nullif(btrim(coalesce(p_country,'')),''),
        phone=nullif(btrim(coalesce(p_phone,'')),''),
        updated_at=now()
    where id=p_branch_id and restaurant_id=p_restaurant_id
    returning * into v_branch;

    if not found then raise exception 'Branch not found'; end if;
  end if;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  ) values (
    p_restaurant_id,v_user,'location',v_branch.id,
    case when p_branch_id is null then 'branch_created' else 'branch_updated' end,
    jsonb_build_object('name',v_branch.name,'code',v_branch.code,'allowedBranchCount',v_allowed_branch_count)
  );

  return jsonb_build_object(
    'id',v_branch.id,'name',v_branch.name,'code',v_branch.code,
    'addressLine1',v_branch.address_line1,'addressLine2',v_branch.address_line2,
    'city',v_branch.city,'country',v_branch.country,'phone',v_branch.phone,'active',v_branch.active
  );
exception
  when unique_violation then raise exception 'Branch name or code is already in use';
end;
$function$;

create or replace function private.set_company_branch_active(
  p_restaurant_id uuid,p_branch_id uuid,p_active boolean
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_branch public.locations%rowtype;
  v_active_count integer;
  v_open_orders integer;
  v_live_sessions integer;
  v_allowed_branch_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then raise exception 'Not allowed to manage branches'; end if;

  select r.allowed_branch_count into v_allowed_branch_count
  from public.restaurants r where r.id=p_restaurant_id for update;
  if not found then raise exception 'Company not found'; end if;

  select * into v_branch
  from public.locations
  where id=p_branch_id and restaurant_id=p_restaurant_id
  for update;

  if not found then raise exception 'Branch not found'; end if;
  if v_branch.active=p_active then return true; end if;

  select count(*)::integer into v_active_count
  from public.locations where restaurant_id=p_restaurant_id and active=true;

  if p_active then
    if v_active_count >= v_allowed_branch_count then raise exception 'Active branch limit reached'; end if;
  else
    if v_active_count <= 1 then raise exception 'Cannot deactivate the last active branch'; end if;

    select count(*)::integer into v_open_orders
    from public.orders
    where location_id=p_branch_id and status not in ('closed','cancelled','merged');
    if v_open_orders > 0 then raise exception 'Branch has active orders'; end if;

    select count(*)::integer into v_live_sessions
    from public.table_order_sessions
    where location_id=p_branch_id and last_seen_at>=now()-interval '5 minutes';
    if v_live_sessions > 0 then raise exception 'Branch has active table sessions'; end if;
  end if;

  update public.locations set active=p_active,updated_at=now() where id=p_branch_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  ) values (
    p_restaurant_id,v_user,'location',p_branch_id,
    case when p_active then 'branch_activated' else 'branch_deactivated' end,
    jsonb_build_object('name',v_branch.name,'active',p_active,'allowedBranchCount',v_allowed_branch_count)
  );

  return true;
end;
$function$;

create or replace function private.approve_company_registration_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
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
  if not private.is_platform_admin(v_actor) then raise exception 'Platform administrator access required'; end if;

  select * into v_request from public.company_registration_requests where id=p_request_id for update;
  if not found then raise exception 'Company request not found'; end if;
  if v_request.status<>'pending' then raise exception 'Company request is no longer pending'; end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id=v_request.user_id and m.status='active'
  ) then raise exception 'Applicant already belongs to an active company'; end if;

  v_join_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.restaurants(
    name,legal_name,tax_id,email,phone,currency_code,timezone,status,owner_user_id,join_code,
    subscription_started_at,allowed_branch_count
  ) values (
    v_request.company_name,nullif(v_request.legal_name,''),nullif(v_request.tax_id,''),
    nullif(v_request.company_email,'')::extensions.citext,nullif(v_request.company_phone,''),
    v_request.currency_code,v_request.timezone,'active',v_request.user_id,v_join_code,current_date,1
  )
  returning id into v_restaurant_id;

  insert into public.company_profiles(
    restaurant_id,legal_name,trade_name,nit,verification_digit,tax_regime,
    tax_responsibilities,address,city,department,phone,email
  ) values (
    v_restaurant_id,coalesce(nullif(v_request.legal_name,''),v_request.company_name),
    v_request.company_name,v_request.tax_id,v_request.verification_digit,v_request.tax_regime,
    v_request.tax_responsibilities,v_request.address,v_request.city,v_request.region,
    v_request.company_phone,v_request.company_email
  );

  insert into public.restaurant_settings(restaurant_id,currency_code)
  values(v_restaurant_id,trim(v_request.currency_code::text));

  insert into public.locations(
    restaurant_id,name,code,address_line1,city,country,phone,active
  ) values (
    v_restaurant_id,coalesce(nullif(v_request.primary_branch_name,''),'Principal'),'MAIN',
    nullif(v_request.address,''),nullif(v_request.city,''),nullif(v_request.country,''),
    nullif(v_request.company_phone,''),true
  )
  returning id into v_location_id;

  for v_preset in
    select rp.* from public.role_presets rp
    where rp.active=true order by rp.sort_order,rp.code
  loop
    insert into public.roles(restaurant_id,name,description,is_system,active)
    values(v_restaurant_id,v_preset.name,v_preset.description,true,true)
    returning id into v_role_id;

    insert into public.role_permissions(role_id,permission_code)
    select v_role_id,rpp.permission_code
    from public.role_preset_permissions rpp
    where rpp.preset_code=v_preset.code
    on conflict do nothing;

    if v_preset.code='owner' then v_owner_role_id := v_role_id; end if;
  end loop;

  if v_owner_role_id is null then raise exception 'Owner role preset is not configured'; end if;

  insert into public.memberships(
    restaurant_id,user_id,role_id,status,all_locations,approved_by,approved_at
  ) values (
    v_restaurant_id,v_request.user_id,v_owner_role_id,'active',true,v_actor,now()
  );

  update public.profiles set access_status='active',updated_at=now() where id=v_request.user_id;

  update public.company_registration_requests
  set status='approved',restaurant_id=v_restaurant_id,reviewed_by=v_actor,reviewed_at=now(),
      review_note=null,updated_at=now()
  where id=v_request.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  ) values (
    v_restaurant_id,v_actor,'restaurant',v_restaurant_id,'company_registration_approved',
    jsonb_build_object(
      'ownerUserId',v_request.user_id,'primaryLocationId',v_location_id,'joinCode',v_join_code,
      'subscriptionStartedAt',current_date,'allowedBranchCount',1
    )
  );

  return jsonb_build_object(
    'ok',true,'restaurant_id',v_restaurant_id,'location_id',v_location_id,
    'company_name',v_request.company_name,'join_code',v_join_code,'owner_user_id',v_request.user_id,
    'subscription_started_at',current_date,'allowed_branch_count',1
  );
end;
$function$;
