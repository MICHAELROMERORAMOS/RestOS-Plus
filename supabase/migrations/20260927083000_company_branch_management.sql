insert into public.permissions(code,module,description)
values
  ('branches.view','branches','Ver la empresa y sus sucursales'),
  ('branches.manage','branches','Crear, editar, activar y desactivar sucursales')
on conflict (code) do update
set module=excluded.module, description=excluded.description;

insert into public.role_permissions(role_id,permission_code)
select r.id,'branches.view'
from public.roles r
where r.name in ('Owner / Super Admin','Manager / Supervisor')
on conflict do nothing;

insert into public.role_permissions(role_id,permission_code)
select r.id,'branches.manage'
from public.roles r
where r.name='Owner / Super Admin'
on conflict do nothing;

create or replace function private.load_company_branches(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.view') then
    raise exception 'Not allowed to view branches';
  end if;

  select jsonb_build_object(
    'company', jsonb_build_object(
      'id',r.id,'name',r.name,'legalName',r.legal_name,'taxId',r.tax_id,
      'email',r.email,'phone',r.phone,'currencyCode',trim(r.currency_code::text),
      'timezone',r.timezone,'status',r.status
    ),
    'branches',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',l.id,'name',l.name,'code',l.code,'addressLine1',l.address_line1,
          'addressLine2',l.address_line2,'city',l.city,'country',l.country,
          'phone',l.phone,'active',l.active,'createdAt',l.created_at,'updatedAt',l.updated_at,
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
      from public.locations l where l.restaurant_id=r.id
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
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_name text := nullif(btrim(coalesce(p_name,'')),'');
  v_code text := upper(nullif(btrim(coalesce(p_code,'')),''));
  v_branch public.locations%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then
    raise exception 'Not allowed to manage branches';
  end if;
  if v_name is null then raise exception 'Branch name is required'; end if;
  if v_code is null then v_code := 'BR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)); end if;

  if p_branch_id is null then
    insert into public.locations(
      restaurant_id,name,code,address_line1,address_line2,city,country,phone,active
    )
    values(
      p_restaurant_id,v_name,v_code,
      nullif(btrim(coalesce(p_address_line1,'')),''),
      nullif(btrim(coalesce(p_address_line2,'')),''),
      nullif(btrim(coalesce(p_city,'')),''),
      nullif(btrim(coalesce(p_country,'')),''),
      nullif(btrim(coalesce(p_phone,'')),''),
      true
    )
    returning * into v_branch;
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

  insert into public.audit_logs(restaurant_id,actor_user_id,entity_type,entity_id,action,details)
  values(
    p_restaurant_id,v_user,'location',v_branch.id,
    case when p_branch_id is null then 'branch_created' else 'branch_updated' end,
    jsonb_build_object('name',v_branch.name,'code',v_branch.code)
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
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_branch public.locations%rowtype;
  v_active_count integer;
  v_open_orders integer;
  v_live_sessions integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then
    raise exception 'Not allowed to manage branches';
  end if;

  select * into v_branch
  from public.locations
  where id=p_branch_id and restaurant_id=p_restaurant_id
  for update;

  if not found then raise exception 'Branch not found'; end if;
  if v_branch.active=p_active then return true; end if;

  if not p_active then
    select count(*)::integer into v_active_count
    from public.locations
    where restaurant_id=p_restaurant_id and active=true;

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

  insert into public.audit_logs(restaurant_id,actor_user_id,entity_type,entity_id,action,details)
  values(
    p_restaurant_id,v_user,'location',p_branch_id,
    case when p_active then 'branch_activated' else 'branch_deactivated' end,
    jsonb_build_object('name',v_branch.name,'active',p_active)
  );

  return true;
end;
$function$;

create or replace function public.load_company_branches(p_restaurant_id uuid)
returns jsonb language sql stable set search_path=''
as $function$ select private.load_company_branches(p_restaurant_id); $function$;

create or replace function public.save_company_branch(
  p_restaurant_id uuid,p_branch_id uuid,p_name text,p_code text,
  p_address_line1 text default null,p_address_line2 text default null,
  p_city text default null,p_country text default null,p_phone text default null
)
returns jsonb language sql set search_path=''
as $function$
  select private.save_company_branch(
    p_restaurant_id,p_branch_id,p_name,p_code,p_address_line1,p_address_line2,p_city,p_country,p_phone
  );
$function$;

create or replace function public.set_company_branch_active(
  p_restaurant_id uuid,p_branch_id uuid,p_active boolean
)
returns boolean language sql set search_path=''
as $function$ select private.set_company_branch_active(p_restaurant_id,p_branch_id,p_active); $function$;

revoke all on function public.load_company_branches(uuid) from public,anon;
revoke all on function public.save_company_branch(uuid,uuid,text,text,text,text,text,text,text) from public,anon;
revoke all on function public.set_company_branch_active(uuid,uuid,boolean) from public,anon;
grant execute on function public.load_company_branches(uuid) to authenticated;
grant execute on function public.save_company_branch(uuid,uuid,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.set_company_branch_active(uuid,uuid,boolean) to authenticated;
