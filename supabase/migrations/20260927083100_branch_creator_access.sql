create or replace function private.save_company_branch(
  p_restaurant_id uuid,
  p_branch_id uuid,
  p_name text,
  p_code text,
  p_address_line1 text default null,
  p_address_line2 text default null,
  p_city text default null,
  p_country text default null,
  p_phone text default null
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
  v_membership public.memberships%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then
    raise exception 'Not allowed to manage branches';
  end if;
  if v_name is null then raise exception 'Branch name is required'; end if;
  if v_code is null then
    v_code := 'BR-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  end if;

  select * into v_membership
  from public.memberships
  where user_id=v_user and restaurant_id=p_restaurant_id and status='active'
  limit 1;

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

    if v_membership.id is not null and not v_membership.all_locations then
      insert into public.membership_locations(membership_id,location_id)
      values(v_membership.id,v_branch.id)
      on conflict do nothing;
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
