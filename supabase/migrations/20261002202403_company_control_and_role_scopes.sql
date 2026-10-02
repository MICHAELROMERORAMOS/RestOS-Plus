-- Corporate vs branch access model.
alter table public.role_presets
  add column if not exists company_scope boolean not null default false;

alter table public.roles
  add column if not exists company_scope boolean not null default false;

insert into public.permissions(code,module,description) values
  ('company.control.view','company','Entrar al Control Central de la empresa'),
  ('products.catalog.manage','products','Crear y modificar el catálogo maestro de la empresa'),
  ('products.branch.assign','products','Asignar productos y precios a sucursales'),
  ('products.availability.request','products','Solicitar indisponibilidad temporal de un producto en una sucursal'),
  ('products.availability.approve','products','Autorizar indisponibilidad temporal de productos'),
  ('inventory.central.manage','inventory','Administrar el almacén central de la empresa'),
  ('inventory.transfer.request','inventory','Solicitar transferencias de inventario'),
  ('inventory.transfer.approve','inventory','Aprobar transferencias de inventario'),
  ('inventory.transfer.dispatch','inventory','Despachar transferencias desde almacén central'),
  ('inventory.transfer.receive','inventory','Confirmar recepción de transferencias en una sucursal')
on conflict (code) do update
set module=excluded.module, description=excluded.description;

update public.role_presets
set company_scope = (code='owner');

insert into public.role_presets(code,name,description,sort_order,active,company_scope)
values(
  'corporate_admin',
  'Corporate Administrator / Administrador Corporativo',
  'Administración general de la empresa: sucursales, personal, catálogo, configuración, reportes e inventario central.',
  15,
  true,
  true
)
on conflict (code) do update
set name=excluded.name,
    description=excluded.description,
    sort_order=excluded.sort_order,
    active=true,
    company_scope=true;

insert into public.role_preset_permissions(preset_code,permission_code)
select 'owner', p.code
from public.permissions p
where p.code in (
  'company.control.view',
  'products.catalog.manage',
  'products.branch.assign',
  'products.availability.request',
  'products.availability.approve',
  'inventory.central.manage',
  'inventory.transfer.request',
  'inventory.transfer.approve',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive'
)
on conflict do nothing;

insert into public.role_preset_permissions(preset_code,permission_code)
select 'corporate_admin', p.code
from public.permissions p
where p.code in (
  'company.control.view',
  'dashboard.view',
  'branches.view','branches.manage',
  'staff.view','staff.manage',
  'settings.view','settings.manage',
  'reports.view',
  'products.view','products.manage','products.catalog.manage','products.branch.assign',
  'products.availability.request','products.availability.approve',
  'inventory.view','inventory.manage','inventory.central.manage',
  'inventory.transfer.request','inventory.transfer.approve',
  'inventory.transfer.dispatch','inventory.transfer.receive'
)
on conflict do nothing;

delete from public.role_preset_permissions
where preset_code='manager'
  and permission_code in ('products.manage','branches.view','staff.view');

insert into public.role_preset_permissions(preset_code,permission_code)
values
  ('manager','products.availability.request'),
  ('manager','inventory.transfer.request'),
  ('manager','inventory.transfer.receive')
on conflict do nothing;

insert into public.role_preset_permissions(preset_code,permission_code)
values
  ('inventory','inventory.transfer.request'),
  ('inventory','inventory.transfer.receive')
on conflict do nothing;

update public.role_presets
set description='Supervisión operativa de una o varias sucursales. No administra el catálogo maestro, personal corporativo ni configuración central.'
where code='manager';

create or replace function private.sync_system_role_company_scope()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_scope boolean;
begin
  if coalesce(new.is_system,false) then
    select rp.company_scope
      into v_scope
    from public.role_presets rp
    where rp.name=new.name
      and rp.active=true
    order by rp.sort_order
    limit 1;

    if found then
      new.company_scope := coalesce(v_scope,false);
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists roles_sync_company_scope on public.roles;
create trigger roles_sync_company_scope
before insert or update of name,is_system
on public.roles
for each row
execute function private.sync_system_role_company_scope();

update public.roles r
set company_scope=rp.company_scope
from public.role_presets rp
where r.is_system=true
  and r.name=rp.name;

do $block$
declare
  v_restaurant record;
  v_role_id uuid;
begin
  for v_restaurant in
    select id from public.restaurants where status='active'
  loop
    select r.id into v_role_id
    from public.roles r
    where r.restaurant_id=v_restaurant.id
      and r.name='Corporate Administrator / Administrador Corporativo'
      and r.active=true
    limit 1;

    if v_role_id is null then
      insert into public.roles(
        restaurant_id,name,description,is_system,active,company_scope
      )
      values(
        v_restaurant.id,
        'Corporate Administrator / Administrador Corporativo',
        'Administración general de la empresa: sucursales, personal, catálogo, configuración, reportes e inventario central.',
        true,true,true
      )
      returning id into v_role_id;
    else
      update public.roles
      set company_scope=true,
          is_system=true,
          description='Administración general de la empresa: sucursales, personal, catálogo, configuración, reportes e inventario central.'
      where id=v_role_id;
    end if;

    insert into public.role_permissions(role_id,permission_code)
    select v_role_id,rpp.permission_code
    from public.role_preset_permissions rpp
    where rpp.preset_code='corporate_admin'
    on conflict do nothing;
  end loop;
end;
$block$;

insert into public.role_permissions(role_id,permission_code)
select r.id,rpp.permission_code
from public.roles r
join public.role_presets rp
  on rp.name=r.name and rp.active=true
join public.role_preset_permissions rpp
  on rpp.preset_code=rp.code
where r.is_system=true
  and rp.code in ('owner','manager','inventory')
on conflict do nothing;

delete from public.role_permissions rperm
using public.roles r
where rperm.role_id=r.id
  and r.is_system=true
  and r.name='Manager / Supervisor'
  and rperm.permission_code in ('products.manage','branches.view','staff.view');

create or replace function private.enforce_company_scope_membership()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if exists (
    select 1
    from public.roles r
    where r.id=new.role_id
      and r.restaurant_id=new.restaurant_id
      and r.active=true
      and r.company_scope=true
  ) then
    new.all_locations := true;
  end if;
  return new;
end;
$function$;

drop trigger if exists memberships_enforce_company_scope on public.memberships;
create trigger memberships_enforce_company_scope
before insert or update of role_id,restaurant_id,all_locations
on public.memberships
for each row
execute function private.enforce_company_scope_membership();

update public.memberships m
set all_locations=true,
    updated_at=now()
from public.roles r
where r.id=m.role_id
  and r.company_scope=true
  and m.all_locations=false;

create or replace function private.list_staff_members(
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
        'role_company_scope', coalesce(r.company_scope,false),
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
$function$;

grant select on public.permissions to authenticated;
grant select on public.roles to authenticated;
