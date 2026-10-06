grant usage on schema private to service_role;
grant execute on function private.update_platform_company_subscription(uuid,date,integer) to authenticated;

create table if not exists private.branch_capacity_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  requested_additional_count integer not null check (requested_additional_count between 1 and 100),
  allowed_branch_count_snapshot integer not null,
  active_branch_count_snapshot integer not null,
  status text not null default 'pending' check (status in ('pending','paid','code_sent','activated','cancelled')),
  request_email_sent_at timestamptz,
  payment_confirmed_at timestamptz,
  payment_confirmed_by uuid references public.profiles(id),
  activation_code_hash text,
  activation_code_sent_at timestamptz,
  activated_at timestamptz,
  activated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists branch_capacity_requests_restaurant_status_idx
  on private.branch_capacity_requests(restaurant_id,status,created_at desc);
create index if not exists branch_capacity_requests_status_created_idx
  on private.branch_capacity_requests(status,created_at desc);

CREATE OR REPLACE FUNCTION private.create_branch_capacity_request_internal(p_restaurant_id uuid, p_requested_by uuid, p_additional_count integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant public.restaurants%rowtype;
  v_active_count integer;
  v_request_id uuid;
  v_requester_email text;
begin
  if p_restaurant_id is null or p_requested_by is null then
    raise exception 'Missing request context';
  end if;

  if p_additional_count is null or p_additional_count < 1 or p_additional_count > 100 then
    raise exception 'Additional branch count must be between 1 and 100';
  end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    where m.restaurant_id=p_restaurant_id
      and m.user_id=p_requested_by
      and m.status='active'
      and rp.permission_code='branches.manage'
  ) and not exists (
    select 1
    from public.restaurants r
    where r.id=p_restaurant_id
      and r.owner_user_id=p_requested_by
  ) then
    raise exception 'Not allowed to request branch capacity';
  end if;

  select *
  into v_restaurant
  from public.restaurants
  where id=p_restaurant_id
    and status='active'
  for update;

  if not found then raise exception 'Company not found'; end if;

  if exists (
    select 1
    from private.branch_capacity_requests q
    where q.restaurant_id=p_restaurant_id
      and q.status in ('pending','paid','code_sent')
  ) then
    raise exception 'Open branch capacity request already exists';
  end if;

  select count(*)::integer
  into v_active_count
  from public.locations
  where restaurant_id=p_restaurant_id
    and active=true;

  select p.email::text
  into v_requester_email
  from public.profiles p
  where p.id=p_requested_by;

  insert into private.branch_capacity_requests(
    restaurant_id,
    requested_by,
    requested_additional_count,
    allowed_branch_count_snapshot,
    active_branch_count_snapshot
  )
  values(
    p_restaurant_id,
    p_requested_by,
    p_additional_count,
    v_restaurant.allowed_branch_count,
    v_active_count
  )
  returning id into v_request_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,
    p_requested_by,
    'restaurant',
    p_restaurant_id,
    'branch_capacity_requested',
    jsonb_build_object(
      'requestId',v_request_id,
      'additionalBranches',p_additional_count,
      'allowedBranchCount',v_restaurant.allowed_branch_count,
      'activeBranchCount',v_active_count
    )
  );

  return jsonb_build_object(
    'requestId',v_request_id,
    'companyName',v_restaurant.name,
    'additionalBranches',p_additional_count,
    'allowedBranchCount',v_restaurant.allowed_branch_count,
    'activeBranchCount',v_active_count,
    'requesterEmail',v_requester_email
  );
end;
$function$


CREATE OR REPLACE FUNCTION public.create_branch_capacity_request_internal(p_restaurant_id uuid, p_requested_by uuid, p_additional_count integer)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.create_branch_capacity_request_internal(
    p_restaurant_id,p_requested_by,p_additional_count
  );
$function$


CREATE OR REPLACE FUNCTION private.list_platform_admin_recipients_internal()
 RETURNS TABLE(email text, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.email::text,coalesce(p.full_name,p.username,p.email::text)
  from public.platform_admins pa
  join public.profiles p on p.id=pa.user_id
  where pa.active=true
    and p.email is not null;
$function$


CREATE OR REPLACE FUNCTION public.list_platform_admin_recipients_internal()
 RETURNS TABLE(email text, full_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select * from private.list_platform_admin_recipients_internal();
$function$


CREATE OR REPLACE FUNCTION private.mark_branch_capacity_request_email_sent_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update private.branch_capacity_requests
  set request_email_sent_at=now(),
      updated_at=now()
  where id=p_request_id;

  return found;
end;
$function$


CREATE OR REPLACE FUNCTION public.mark_branch_capacity_request_email_sent_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.mark_branch_capacity_request_email_sent_internal(p_request_id);
$function$


CREATE OR REPLACE FUNCTION private.cancel_branch_capacity_request_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update private.branch_capacity_requests
  set status='cancelled',
      activation_code_hash=null,
      updated_at=now()
  where id=p_request_id
    and status='pending'
    and request_email_sent_at is null;

  return found;
end;
$function$


CREATE OR REPLACE FUNCTION public.cancel_branch_capacity_request_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.cancel_branch_capacity_request_internal(p_request_id);
$function$


CREATE OR REPLACE FUNCTION private.list_platform_branch_capacity_requests()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
begin
  if not private.is_platform_admin(v_user) then
    raise exception 'Platform administrator access required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',q.id,
      'restaurantId',q.restaurant_id,
      'companyName',r.name,
      'ownerName',coalesce(owner_p.full_name,owner_p.username,owner_p.email::text),
      'ownerEmail',owner_p.email,
      'requestedByName',coalesce(requester.full_name,requester.username,requester.email::text),
      'requestedByEmail',requester.email,
      'additionalBranches',q.requested_additional_count,
      'allowedBranchCountSnapshot',q.allowed_branch_count_snapshot,
      'activeBranchCountSnapshot',q.active_branch_count_snapshot,
      'currentAllowedBranchCount',r.allowed_branch_count,
      'currentActiveBranchCount',(
        select count(*) from public.locations l
        where l.restaurant_id=q.restaurant_id and l.active=true
      ),
      'status',q.status,
      'requestEmailSentAt',q.request_email_sent_at,
      'paymentConfirmedAt',q.payment_confirmed_at,
      'activationCodeSentAt',q.activation_code_sent_at,
      'activatedAt',q.activated_at,
      'createdAt',q.created_at
    )
    order by
      case q.status
        when 'pending' then 1
        when 'paid' then 2
        when 'code_sent' then 3
        when 'activated' then 4
        else 5
      end,
      q.created_at desc
  ),'[]'::jsonb)
  into v_result
  from private.branch_capacity_requests q
  join public.restaurants r on r.id=q.restaurant_id
  left join public.profiles owner_p on owner_p.id=r.owner_user_id
  left join public.profiles requester on requester.id=q.requested_by;

  return v_result;
end;
$function$


CREATE OR REPLACE FUNCTION public.list_platform_branch_capacity_requests()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select private.list_platform_branch_capacity_requests();
$function$


CREATE OR REPLACE FUNCTION private.prepare_branch_capacity_activation_internal(p_request_id uuid, p_admin_user_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request private.branch_capacity_requests%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_owner public.profiles%rowtype;
  v_code text := upper(btrim(coalesce(p_code,'')));
begin
  if not private.is_platform_admin(p_admin_user_id) then
    raise exception 'Platform administrator access required';
  end if;

  if v_code !~ '^[A-Z0-9]{8}$' then
    raise exception 'Invalid activation code';
  end if;

  select *
  into v_request
  from private.branch_capacity_requests
  where id=p_request_id
  for update;

  if not found then raise exception 'Branch capacity request not found'; end if;
  if v_request.status='activated' then raise exception 'Branch capacity request is already activated'; end if;
  if v_request.status='cancelled' then raise exception 'Branch capacity request is cancelled'; end if;

  select * into v_restaurant
  from public.restaurants
  where id=v_request.restaurant_id
  for update;

  if not found then raise exception 'Company not found'; end if;

  select *
  into v_owner
  from public.profiles
  where id=v_restaurant.owner_user_id;

  if v_owner.id is null or v_owner.email is null then
    raise exception 'Company owner email is not configured';
  end if;

  update private.branch_capacity_requests
  set status='paid',
      payment_confirmed_at=coalesce(payment_confirmed_at,now()),
      payment_confirmed_by=coalesce(payment_confirmed_by,p_admin_user_id),
      activation_code_hash=encode(extensions.digest(v_code,'sha256'),'hex'),
      activation_code_sent_at=null,
      updated_at=now()
  where id=p_request_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_request.restaurant_id,
    p_admin_user_id,
    'restaurant',
    v_request.restaurant_id,
    'branch_capacity_payment_confirmed',
    jsonb_build_object(
      'requestId',p_request_id,
      'additionalBranches',v_request.requested_additional_count
    )
  );

  return jsonb_build_object(
    'requestId',p_request_id,
    'restaurantId',v_restaurant.id,
    'companyName',v_restaurant.name,
    'ownerName',coalesce(v_owner.full_name,v_owner.username,v_owner.email::text),
    'ownerEmail',v_owner.email,
    'additionalBranches',v_request.requested_additional_count,
    'currentAllowedBranchCount',v_restaurant.allowed_branch_count
  );
end;
$function$


CREATE OR REPLACE FUNCTION public.prepare_branch_capacity_activation_internal(p_request_id uuid, p_admin_user_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.prepare_branch_capacity_activation_internal(
    p_request_id,p_admin_user_id,p_code
  );
$function$


CREATE OR REPLACE FUNCTION private.mark_branch_capacity_activation_email_sent_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update private.branch_capacity_requests
  set status='code_sent',
      activation_code_sent_at=now(),
      updated_at=now()
  where id=p_request_id
    and status='paid'
    and activation_code_hash is not null;

  return found;
end;
$function$


CREATE OR REPLACE FUNCTION public.mark_branch_capacity_activation_email_sent_internal(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.mark_branch_capacity_activation_email_sent_internal(p_request_id);
$function$


CREATE OR REPLACE FUNCTION private.cancel_platform_branch_capacity_request(p_request_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_request private.branch_capacity_requests%rowtype;
begin
  if not private.is_platform_admin(v_actor) then
    raise exception 'Platform administrator access required';
  end if;

  select *
  into v_request
  from private.branch_capacity_requests
  where id=p_request_id
  for update;

  if not found then raise exception 'Branch capacity request not found'; end if;
  if v_request.status='activated' then
    raise exception 'Activated request cannot be cancelled';
  end if;

  update private.branch_capacity_requests
  set status='cancelled',
      activation_code_hash=null,
      updated_at=now()
  where id=p_request_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_request.restaurant_id,
    v_actor,
    'restaurant',
    v_request.restaurant_id,
    'branch_capacity_request_cancelled',
    jsonb_build_object('requestId',p_request_id)
  );

  return true;
end;
$function$


CREATE OR REPLACE FUNCTION public.cancel_platform_branch_capacity_request(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.cancel_platform_branch_capacity_request(p_request_id);
$function$


CREATE OR REPLACE FUNCTION private.activate_branch_capacity(p_restaurant_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_code_hash text := encode(extensions.digest(upper(btrim(coalesce(p_code,''))),'sha256'),'hex');
  v_request private.branch_capacity_requests%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_new_limit integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage')
     and not exists (
       select 1 from public.restaurants r
       where r.id=p_restaurant_id and r.owner_user_id=v_user
     ) then
    raise exception 'Not allowed to activate branch capacity';
  end if;

  select *
  into v_request
  from private.branch_capacity_requests
  where restaurant_id=p_restaurant_id
    and status in ('paid','code_sent')
    and activation_code_hash=v_code_hash
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Invalid or unavailable activation code';
  end if;

  select *
  into v_restaurant
  from public.restaurants
  where id=p_restaurant_id
  for update;

  if not found then raise exception 'Company not found'; end if;

  v_new_limit := v_restaurant.allowed_branch_count + v_request.requested_additional_count;

  update public.restaurants
  set allowed_branch_count=v_new_limit,
      updated_at=now()
  where id=p_restaurant_id;

  update private.branch_capacity_requests
  set status='activated',
      activated_at=now(),
      activated_by=v_user,
      activation_code_hash=null,
      updated_at=now()
  where id=v_request.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,
    v_user,
    'restaurant',
    p_restaurant_id,
    'branch_capacity_activated',
    jsonb_build_object(
      'requestId',v_request.id,
      'additionalBranches',v_request.requested_additional_count,
      'previousAllowedBranchCount',v_restaurant.allowed_branch_count,
      'newAllowedBranchCount',v_new_limit
    )
  );

  return jsonb_build_object(
    'ok',true,
    'requestId',v_request.id,
    'additionalBranches',v_request.requested_additional_count,
    'previousAllowedBranchCount',v_restaurant.allowed_branch_count,
    'newAllowedBranchCount',v_new_limit
  );
end;
$function$


CREATE OR REPLACE FUNCTION public.activate_branch_capacity(p_restaurant_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.activate_branch_capacity(p_restaurant_id,p_code);
$function$


CREATE OR REPLACE FUNCTION private.load_company_branches(p_restaurant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      ),
      'branchCapacityRequest',case when v_can_manage then (
        select jsonb_build_object(
          'id',q.id,
          'status',q.status,
          'additionalBranches',q.requested_additional_count,
          'requestedAt',q.created_at,
          'activationCodeSentAt',q.activation_code_sent_at
        )
        from private.branch_capacity_requests q
        where q.restaurant_id=r.id
          and q.status in ('pending','paid','code_sent')
        order by q.created_at desc
        limit 1
      ) else null end
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
          'invoicePrefix',l.invoice_prefix,
          'nextInvoiceNumber',l.next_invoice_number,
          'nextInvoice',('FAC-' || l.invoice_prefix || '-' || lpad(l.next_invoice_number::text,6,'0')),
          'invoicePrefixLocked',exists(select 1 from public.sales_invoices si where si.location_id=l.id),
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
            select count(*) from public.orders o
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
  where r.id=p_restaurant_id and r.status='active';

  if v_result is null then raise exception 'Company not found'; end if;
  return v_result;
end;
$function$


revoke all on function private.create_branch_capacity_request_internal(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.create_branch_capacity_request_internal(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function private.create_branch_capacity_request_internal(uuid,uuid,integer) to service_role;
grant execute on function public.create_branch_capacity_request_internal(uuid,uuid,integer) to service_role;

revoke all on function private.list_platform_admin_recipients_internal() from public,anon,authenticated;
revoke all on function public.list_platform_admin_recipients_internal() from public,anon,authenticated;
grant execute on function private.list_platform_admin_recipients_internal() to service_role;
grant execute on function public.list_platform_admin_recipients_internal() to service_role;

revoke all on function private.mark_branch_capacity_request_email_sent_internal(uuid) from public,anon,authenticated;
revoke all on function public.mark_branch_capacity_request_email_sent_internal(uuid) from public,anon,authenticated;
grant execute on function private.mark_branch_capacity_request_email_sent_internal(uuid) to service_role;
grant execute on function public.mark_branch_capacity_request_email_sent_internal(uuid) to service_role;

revoke all on function private.cancel_branch_capacity_request_internal(uuid) from public,anon,authenticated;
revoke all on function public.cancel_branch_capacity_request_internal(uuid) from public,anon,authenticated;
grant execute on function private.cancel_branch_capacity_request_internal(uuid) to service_role;
grant execute on function public.cancel_branch_capacity_request_internal(uuid) to service_role;

revoke all on function private.list_platform_branch_capacity_requests() from public,anon;
revoke all on function public.list_platform_branch_capacity_requests() from public,anon;
grant execute on function private.list_platform_branch_capacity_requests() to authenticated;
grant execute on function public.list_platform_branch_capacity_requests() to authenticated;

revoke all on function private.prepare_branch_capacity_activation_internal(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.prepare_branch_capacity_activation_internal(uuid,uuid,text) from public,anon,authenticated;
grant execute on function private.prepare_branch_capacity_activation_internal(uuid,uuid,text) to service_role;
grant execute on function public.prepare_branch_capacity_activation_internal(uuid,uuid,text) to service_role;

revoke all on function private.mark_branch_capacity_activation_email_sent_internal(uuid) from public,anon,authenticated;
revoke all on function public.mark_branch_capacity_activation_email_sent_internal(uuid) from public,anon,authenticated;
grant execute on function private.mark_branch_capacity_activation_email_sent_internal(uuid) to service_role;
grant execute on function public.mark_branch_capacity_activation_email_sent_internal(uuid) to service_role;

revoke all on function private.cancel_platform_branch_capacity_request(uuid) from public,anon;
revoke all on function public.cancel_platform_branch_capacity_request(uuid) from public,anon;
grant execute on function private.cancel_platform_branch_capacity_request(uuid) to authenticated;
grant execute on function public.cancel_platform_branch_capacity_request(uuid) to authenticated;

revoke all on function private.activate_branch_capacity(uuid,text) from public,anon;
revoke all on function public.activate_branch_capacity(uuid,text) from public,anon;
grant execute on function private.activate_branch_capacity(uuid,text) to authenticated;
grant execute on function public.activate_branch_capacity(uuid,text) to authenticated;
