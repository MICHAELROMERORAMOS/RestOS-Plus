drop trigger if exists trg_enforce_location_station_invariants
  on public.kitchen_stations;

alter table public.kitchen_stations
  add column if not exists is_default boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='public.kitchen_stations'::regclass
      and conname='kitchen_stations_default_requires_active'
  ) then
    alter table public.kitchen_stations
      add constraint kitchen_stations_default_requires_active
      check (not is_default or active);
  end if;
end $$;

create unique index if not exists kitchen_stations_one_default_per_location_uidx
  on public.kitchen_stations(location_id)
  where is_default=true;

with ranked as (
  select
    ks.id,
    row_number() over (
      partition by ks.location_id
      order by
        case when ks.station_type='kitchen' then 0 else 1 end,
        ks.display_order,
        ks.created_at,
        ks.id
    ) as rn
  from public.kitchen_stations ks
  where ks.active=true
)
update public.kitchen_stations ks
set is_default=(ranked.rn=1),
    updated_at=now()
from ranked
where ks.id=ranked.id;

update public.kitchen_stations
set is_default=false,
    updated_at=now()
where active=false
  and is_default=true;

create or replace function private.ensure_default_location_stations(
  p_location_id uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
begin
  insert into public.kitchen_stations(
    location_id,name,station_type,display_order,active,output_mode,is_default
  )
  values
    (p_location_id,'Cocina','kitchen',10,true,'screen',true),
    (p_location_id,'Bar','bar',20,true,'screen',false),
    (p_location_id,'Postres','dessert',30,false,'screen',false),
    (p_location_id,'Café','coffee',40,false,'screen',false),
    (p_location_id,'Otra estación','other',50,false,'screen',false)
  on conflict(location_id,station_type)
  do update set
    name=excluded.name,
    display_order=excluded.display_order,
    output_mode=coalesce(public.kitchen_stations.output_mode,excluded.output_mode),
    is_default=case
      when public.kitchen_stations.station_type='kitchen'
        and not exists (
          select 1
          from public.kitchen_stations x
          where x.location_id=p_location_id
            and x.is_default=true
        )
      then true
      else public.kitchen_stations.is_default
    end;

  if not exists (
    select 1
    from public.kitchen_stations ks
    where ks.location_id=p_location_id
      and ks.active=true
      and ks.is_default=true
  ) then
    update public.kitchen_stations ks
    set is_default=true,
        active=true,
        updated_at=now()
    where ks.id=(
      select x.id
      from public.kitchen_stations x
      where x.location_id=p_location_id
        and x.active=true
      order by
        case when x.station_type='kitchen' then 0 else 1 end,
        x.display_order,
        x.created_at,
        x.id
      limit 1
    );
  end if;
end;
$function$;

create or replace function private.enforce_location_station_invariants()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_location_id uuid;
  v_active_count integer;
  v_default_count integer;
begin
  if tg_op='DELETE' then
    v_location_id := old.location_id;
  else
    v_location_id := new.location_id;
  end if;

  if v_location_id is null then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;

  if not exists (
    select 1 from public.locations l where l.id=v_location_id
  ) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;

  select
    count(*) filter (where ks.active=true),
    count(*) filter (where ks.active=true and ks.is_default=true)
  into v_active_count,v_default_count
  from public.kitchen_stations ks
  where ks.location_id=v_location_id;

  if v_active_count<1 then
    raise exception 'Cada sucursal debe conservar al menos una estación activa.';
  end if;

  if v_default_count<>1 then
    raise exception 'Cada sucursal debe tener exactamente una estación predeterminada activa.';
  end if;

  if tg_op='DELETE' then return old; else return new; end if;
end;
$function$;

create or replace function private.set_default_branch_station(
  p_location_id uuid,
  p_station_type text
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
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id,'settings.manage') then
    raise exception 'Tu usuario no puede modificar las estaciones de esta sucursal';
  end if;

  select *
  into v_location
  from public.locations
  where id=p_location_id
    and active=true;

  if not found then
    raise exception 'La sucursal no existe o está inactiva';
  end if;

  perform 1
  from public.kitchen_stations
  where location_id=p_location_id
  for update;

  select *
  into v_station
  from public.kitchen_stations ks
  where ks.location_id=p_location_id
    and ks.station_type=p_station_type
    and ks.active=true;

  if not found then
    raise exception 'Solo una estación activa puede ser predeterminada';
  end if;

  update public.kitchen_stations
  set is_default=false,
      updated_at=now()
  where location_id=p_location_id
    and is_default=true;

  update public.kitchen_stations
  set is_default=true,
      updated_at=now()
  where id=v_station.id
  returning * into v_station;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_location.restaurant_id,
    v_actor,
    'preparation_station',
    v_station.id,
    'station.default_changed',
    jsonb_build_object(
      'locationId',p_location_id,
      'locationName',v_location.name,
      'stationType',v_station.station_type,
      'stationName',v_station.name
    )
  );

  return jsonb_build_object(
    'id',v_station.id,
    'locationId',v_station.location_id,
    'name',v_station.name,
    'stationType',v_station.station_type,
    'active',v_station.active,
    'outputMode',v_station.output_mode,
    'isDefault',v_station.is_default
  );
end;
$function$;

create or replace function public.set_default_branch_station(
  p_location_id uuid,
  p_station_type text
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.set_default_branch_station(
    p_location_id,p_station_type
  );
$function$;

revoke all on function private.set_default_branch_station(uuid,text)
  from public,anon,authenticated;
grant execute on function private.set_default_branch_station(uuid,text)
  to authenticated;

revoke all on function public.set_default_branch_station(uuid,text)
  from public,anon;
grant execute on function public.set_default_branch_station(uuid,text)
  to authenticated;

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
  v_active_count integer;
  v_default_station_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id,'settings.manage') then
    raise exception 'Tu usuario no puede modificar las estaciones de esta sucursal';
  end if;

  if p_station_type not in ('kitchen','bar','dessert','coffee','other') then
    raise exception 'Tipo de estación inválido';
  end if;

  if p_output_mode not in ('screen','printer') then
    raise exception 'Modo de salida inválido';
  end if;

  select *
  into v_location
  from public.locations
  where id=p_location_id
    and active=true;

  if not found then
    raise exception 'La sucursal no existe o está inactiva';
  end if;

  perform 1
  from public.kitchen_stations
  where location_id=p_location_id
  for update;

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

  select *
  into v_station
  from public.kitchen_stations ks
  where ks.location_id=p_location_id
    and ks.station_type=p_station_type;

  select count(*)
  into v_active_count
  from public.kitchen_stations ks
  where ks.location_id=p_location_id
    and ks.active=true;

  if v_station.id is not null
     and v_station.active=true
     and not coalesce(p_active,false) then
    if v_station.is_default=true then
      raise exception 'Antes de apagar "%", selecciona otra estación activa como predeterminada.',
        v_station.name;
    end if;

    if v_active_count<=1 then
      raise exception 'No puedes apagar la última estación activa. Cada sucursal debe conservar al menos una.';
    end if;

    select ks.id
    into v_default_station_id
    from public.kitchen_stations ks
    where ks.location_id=p_location_id
      and ks.active=true
      and ks.is_default=true
    limit 1;

    if v_default_station_id is null then
      raise exception 'Selecciona una estación predeterminada activa antes de apagar otra estación.';
    end if;
  end if;

  insert into public.kitchen_stations(
    location_id,name,station_type,display_order,active,output_mode,is_default,updated_at
  )
  values(
    p_location_id,
    v_station_name,
    p_station_type,
    v_display_order,
    coalesce(p_active,false),
    p_output_mode,
    false,
    now()
  )
  on conflict(location_id,station_type)
  do update set
    name=excluded.name,
    display_order=excluded.display_order,
    active=excluded.active,
    output_mode=excluded.output_mode,
    updated_at=now()
  returning * into v_station;

  if v_station.active=true then
    insert into public.product_station_routes(
      product_id,location_id,station_id
    )
    select
      p.id,
      p_location_id,
      v_station.id
    from public.products p
    join public.product_locations pl
      on pl.product_id=p.id
     and pl.restaurant_id=p.restaurant_id
    where pl.location_id=p_location_id
      and pl.active=true
      and p.active=true
      and p.preparation_station_type=p_station_type
    on conflict(product_id,location_id)
    do update set station_id=excluded.station_id;
  else
    insert into public.product_station_routes(
      product_id,location_id,station_id
    )
    select
      p.id,
      p_location_id,
      v_default_station_id
    from public.products p
    join public.product_locations pl
      on pl.product_id=p.id
     and pl.restaurant_id=p.restaurant_id
    where pl.location_id=p_location_id
      and pl.active=true
      and p.active=true
      and p.preparation_station_type=p_station_type
    on conflict(product_id,location_id)
    do update set station_id=excluded.station_id;
  end if;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_location.restaurant_id,
    v_actor,
    'preparation_station',
    v_station.id,
    'station.setting_changed',
    jsonb_build_object(
      'locationId',p_location_id,
      'locationName',v_location.name,
      'stationType',p_station_type,
      'stationName',v_station.name,
      'active',v_station.active,
      'outputMode',v_station.output_mode,
      'isDefault',v_station.is_default,
      'fallbackStationId',case when v_station.active then null else v_default_station_id end
    )
  );

  return jsonb_build_object(
    'id',v_station.id,
    'locationId',v_station.location_id,
    'name',v_station.name,
    'stationType',v_station.station_type,
    'displayOrder',v_station.display_order,
    'active',v_station.active,
    'outputMode',v_station.output_mode,
    'isDefault',v_station.is_default
  );
end;
$function$;

revoke insert,update on table public.kitchen_stations from authenticated;

create constraint trigger trg_enforce_location_station_invariants
after insert or update or delete
on public.kitchen_stations
deferrable initially deferred
for each row
execute function private.enforce_location_station_invariants();
