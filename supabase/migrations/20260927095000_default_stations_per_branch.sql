create or replace function private.ensure_default_location_stations(p_location_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $function$
begin
  insert into public.kitchen_stations(location_id,name,station_type,display_order,active)
  values
    (p_location_id,'Cocina','kitchen',10,true),
    (p_location_id,'Bar','bar',20,true)
  on conflict (location_id,name) do update
  set
    station_type=excluded.station_type,
    active=true;
end;
$function$;

create or replace function private.seed_default_location_stations()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  perform private.ensure_default_location_stations(new.id);
  return new;
end;
$function$;

drop trigger if exists trg_seed_default_location_stations on public.locations;
create trigger trg_seed_default_location_stations
after insert on public.locations
for each row
execute function private.seed_default_location_stations();

do $$
declare
  v_location record;
begin
  for v_location in
    select l.id
    from public.locations l
  loop
    perform private.ensure_default_location_stations(v_location.id);
  end loop;
end
$$;
