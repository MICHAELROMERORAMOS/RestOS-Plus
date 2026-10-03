alter table public.kitchen_stations
  add column if not exists output_mode text not null default 'screen',
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.kitchen_stations'::regclass
      and conname='kitchen_stations_output_mode_check'
  ) then
    alter table public.kitchen_stations
      add constraint kitchen_stations_output_mode_check
      check (output_mode in ('screen','printer'));
  end if;
end $$;

create unique index if not exists kitchen_stations_location_type_uidx
  on public.kitchen_stations(location_id,station_type);

with station_defaults(station_type,name,display_order) as (
  values
    ('kitchen'::text,'Cocina'::text,10),
    ('bar'::text,'Bar'::text,20),
    ('dessert'::text,'Postres'::text,30),
    ('coffee'::text,'Café'::text,40),
    ('other'::text,'Otra estación'::text,50)
)
insert into public.kitchen_stations(
  location_id,name,station_type,display_order,active,output_mode
)
select l.id,d.name,d.station_type,d.display_order,false,'screen'
from public.locations l
cross join station_defaults d
where l.active=true
  and not exists (
    select 1 from public.kitchen_stations ks
    where ks.location_id=l.id
      and ks.station_type=d.station_type
  );

update public.restaurant_settings
set separate_kitchen_bar=true,
    updated_at=now()
where separate_kitchen_bar is distinct from true;

drop policy if exists kitchen_stations_select_authorized on public.kitchen_stations;
create policy kitchen_stations_select_authorized
on public.kitchen_stations
for select
to authenticated
using (
  (select private.user_has_location_permission(location_id,'settings.view'))
  or (select private.user_has_location_permission(location_id,'products.view'))
  or (select private.user_has_location_permission(location_id,'products.manage'))
  or (select private.user_has_location_permission(location_id,'orders.create'))
  or (select private.user_has_location_permission(location_id,'kitchen.view'))
  or (select private.user_has_location_permission(location_id,'bar.view'))
);

drop policy if exists kitchen_stations_insert_authorized on public.kitchen_stations;
create policy kitchen_stations_insert_authorized
on public.kitchen_stations
for insert
to authenticated
with check (
  (select private.user_has_location_permission(location_id,'settings.manage'))
);

drop policy if exists kitchen_stations_update_authorized on public.kitchen_stations;
create policy kitchen_stations_update_authorized
on public.kitchen_stations
for update
to authenticated
using (
  (select private.user_has_location_permission(location_id,'settings.manage'))
)
with check (
  (select private.user_has_location_permission(location_id,'settings.manage'))
);

create or replace function private.save_branch_station_setting(
  p_location_id uuid,
  p_station_type text,
  p_active boolean,
  p_output_mode text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_location public.locations%rowtype;
  v_station public.kitchen_stations%rowtype;
  v_station_name text;
  v_display_order integer;
  v_product_count integer;
  v_product_names text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;

  if not private.user_has_location_permission(p_location_id,'settings.manage') then
    raise exception 'Tu usuario no puede modificar las estaciones de esta sucursal';
  end if;

  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Tipo de estación inválido';
  end if;

  if p_output_mode not in ('screen','printer') then
    raise exception 'Modo de salida inválido';
  end if;

  select * into v_location
  from public.locations
  where id=p_location_id
    and active=true;

  if not found then raise exception 'La sucursal no existe o está inactiva'; end if;

  v_station_name := case p_station_type
    when 'kitchen' then 'Cocina'
    when 'bar' then 'Bar'
    when 'dessert' then 'Postres'
    when 'coffee' then 'Café'
    else 'Otra estación'
  end;

  v_display_order := case p_station_type
    when 'kitchen' then 10
    when 'bar' then 20
    when 'dessert' then 30
    when 'coffee' then 40
    else 50
  end;

  if not coalesce(p_active,false) then
    select count(*),string_agg(p.name, ', ' order by p.name)
    into v_product_count,v_product_names
    from public.products p
    join public.product_locations pl
      on pl.product_id=p.id
     and pl.restaurant_id=p.restaurant_id
    where pl.location_id=p_location_id
      and pl.active=true
      and p.active=true
      and p.preparation_station_type=p_station_type;

    if coalesce(v_product_count,0)>0 then
      raise exception 'No puedes apagar %. La sucursal "%" tiene % producto(s) activo(s) asignado(s): %. Reasígnalos o retíralos de esta sucursal desde el Catálogo maestro.',
        v_station_name,v_location.name,v_product_count,left(coalesce(v_product_names,''),350);
    end if;
  end if;

  insert into public.kitchen_stations(
    location_id,name,station_type,display_order,active,output_mode,updated_at
  )
  values(
    p_location_id,v_station_name,p_station_type,v_display_order,
    coalesce(p_active,false),p_output_mode,now()
  )
  on conflict(location_id,station_type)
  do update set
    name=excluded.name,
    display_order=excluded.display_order,
    active=excluded.active,
    output_mode=excluded.output_mode,
    updated_at=now()
  returning * into v_station;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_location.restaurant_id,v_actor,'preparation_station',v_station.id,
    'station.setting_changed',
    jsonb_build_object(
      'locationId',p_location_id,
      'locationName',v_location.name,
      'stationType',p_station_type,
      'stationName',v_station_name,
      'active',v_station.active,
      'outputMode',v_station.output_mode
    )
  );

  return jsonb_build_object(
    'id',v_station.id,
    'locationId',v_station.location_id,
    'name',v_station.name,
    'stationType',v_station.station_type,
    'displayOrder',v_station.display_order,
    'active',v_station.active,
    'outputMode',v_station.output_mode
  );
end;
$function$;

create or replace function public.save_branch_station_setting(
  p_location_id uuid,
  p_station_type text,
  p_active boolean,
  p_output_mode text
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.save_branch_station_setting(
    p_location_id,p_station_type,p_active,p_output_mode
  );
$function$;

revoke all on function private.save_branch_station_setting(uuid,text,boolean,text)
  from public,anon,authenticated;
grant execute on function private.save_branch_station_setting(uuid,text,boolean,text)
  to authenticated;

revoke all on function public.save_branch_station_setting(uuid,text,boolean,text)
  from public,anon;
grant execute on function public.save_branch_station_setting(uuid,text,boolean,text)
  to authenticated;

create or replace function private.save_product_location_configuration(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_locations jsonb,
  p_station_type text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_entry jsonb;
  v_location_id uuid;
  v_location_name text;
  v_active boolean;
  v_price_override numeric;
  v_station_id uuid;
  v_station_label text;
  v_count integer := 0;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'products.branch.assign') then
    raise exception 'Not allowed to assign products to branches';
  end if;

  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Invalid station type';
  end if;

  v_station_label := case p_station_type
    when 'kitchen' then 'Cocina'
    when 'bar' then 'Bar'
    when 'dessert' then 'Postres'
    when 'coffee' then 'Café'
    else 'Otra estación'
  end;

  if not exists (
    select 1 from public.products p
    where p.id=p_product_id
      and p.restaurant_id=p_restaurant_id
  ) then
    raise exception 'Product not found or not authorized';
  end if;

  p_locations := coalesce(p_locations,'[]'::jsonb);
  if jsonb_typeof(p_locations)<>'array' then
    raise exception 'Invalid product location configuration';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_locations) e
    group by e->>'locationId'
    having count(*)>1
  ) then
    raise exception 'Duplicate product location configuration';
  end if;

  for v_entry in select value from jsonb_array_elements(p_locations)
  loop
    begin
      v_location_id := nullif(v_entry->>'locationId','')::uuid;
    exception when others then
      raise exception 'Invalid location identifier';
    end;

    if v_location_id is null then raise exception 'Location identifier is required'; end if;

    select l.name into v_location_name
    from public.locations l
    where l.id=v_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true;

    if not found then
      raise exception 'Location does not belong to this company or is inactive';
    end if;

    begin
      v_active := coalesce((v_entry->>'active')::boolean,false);
    exception when others then
      raise exception 'Invalid location active value';
    end;

    if nullif(btrim(coalesce(v_entry->>'priceOverride','')),'') is null then
      v_price_override := null;
    else
      begin
        v_price_override := (v_entry->>'priceOverride')::numeric;
      exception when others then
        raise exception 'Invalid location price override';
      end;
      if v_price_override<0 then
        raise exception 'Location price override cannot be negative';
      end if;
    end if;

    if v_active then
      select ks.id into v_station_id
      from public.kitchen_stations ks
      where ks.location_id=v_location_id
        and ks.station_type=p_station_type
        and ks.active=true
      order by ks.display_order,ks.created_at
      limit 1;

      if v_station_id is null then
        raise exception 'La sucursal "%" no tiene activa la estación "%". Actívala en Configuración > Estaciones de preparación antes de asignar este producto.',
          v_location_name,v_station_label;
      end if;
    end if;

    insert into public.product_locations(
      product_id,location_id,restaurant_id,active,price_override
    )
    values(p_product_id,v_location_id,p_restaurant_id,v_active,v_price_override)
    on conflict(product_id,location_id)
    do update set
      active=excluded.active,
      price_override=excluded.price_override,
      updated_at=now();

    if v_active then
      insert into public.product_station_routes(product_id,location_id,station_id)
      values(p_product_id,v_location_id,v_station_id)
      on conflict(product_id,location_id)
      do update set station_id=excluded.station_id;
    end if;

    v_count := v_count+1;
  end loop;

  update public.product_locations pl
  set active=false,
      price_override=null,
      updated_at=now()
  where pl.product_id=p_product_id
    and pl.restaurant_id=p_restaurant_id
    and not exists (
      select 1 from jsonb_array_elements(p_locations) e
      where nullif(e->>'locationId','')::uuid=pl.location_id
    );

  update public.products
  set preparation_station_type=p_station_type,
      updated_at=now()
  where id=p_product_id
    and restaurant_id=p_restaurant_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product',p_product_id,'locations_update',
    jsonb_build_object('locations',p_locations,'stationType',p_station_type)
  );

  return jsonb_build_object(
    'productId',p_product_id,
    'configuredLocations',v_count,
    'stationType',p_station_type
  );
end;
$function$;
