-- Dining areas and tables are configuration entities with stable UUID identities.
-- Names are editable labels; orders continue to reference dining_tables.id.

alter table public.dining_zones
  add column if not exists updated_at timestamptz not null default now();

alter table public.dining_zones
  drop constraint if exists dining_zones_location_id_name_key;

alter table public.dining_zones
  drop constraint if exists dining_zones_name_not_blank;

alter table public.dining_zones
  add constraint dining_zones_name_not_blank check (btrim(name) <> '');

create unique index if not exists dining_zones_location_name_active_uidx
  on public.dining_zones (location_id, lower(btrim(name)))
  where active;

alter table public.dining_zones
  drop constraint if exists dining_zones_id_location_id_key;

alter table public.dining_zones
  add constraint dining_zones_id_location_id_key unique (id, location_id);

alter table public.dining_tables
  drop constraint if exists dining_tables_location_id_code_key;

alter table public.dining_tables
  alter column zone_id set not null;

alter table public.dining_tables
  drop constraint if exists dining_tables_code_not_blank;

alter table public.dining_tables
  add constraint dining_tables_code_not_blank check (btrim(code) <> '');

alter table public.dining_tables
  drop constraint if exists dining_tables_zone_id_fkey;

alter table public.dining_tables
  add constraint dining_tables_zone_location_fkey
  foreign key (zone_id, location_id)
  references public.dining_zones(id, location_id)
  on delete restrict;

create unique index if not exists dining_tables_zone_code_active_uidx
  on public.dining_tables (zone_id, lower(btrim(code)))
  where active;

drop trigger if exists set_dining_zones_updated_at on public.dining_zones;
create trigger set_dining_zones_updated_at
before update on public.dining_zones
for each row execute function public.set_updated_at();
