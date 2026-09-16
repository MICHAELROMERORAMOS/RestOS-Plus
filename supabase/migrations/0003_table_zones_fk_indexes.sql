-- Cover the foreign keys used by dining table configuration and location scoping.
create index if not exists dining_tables_location_idx
  on public.dining_tables(location_id);

create index if not exists dining_tables_zone_location_idx
  on public.dining_tables(zone_id, location_id);
