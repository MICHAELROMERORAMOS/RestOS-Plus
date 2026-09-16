-- RestOS+ baseline schema
-- Snapshot of the schema already created in the RestOS+ Supabase project.
-- Access lifecycle normalized to: pending -> active -> suspended/rejected.

create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email citext,
  phone text,
  username citext,
  avatar_url text,
  access_status text not null default 'pending' check (access_status in ('pending','active','rejected','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_username_unique on public.profiles (lower(username::text)) where username is not null;
create index if not exists profiles_email_idx on public.profiles (lower(email::text));

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  tax_id text,
  email citext,
  phone text,
  currency_code char(3) not null default 'EUR',
  timezone text not null default 'Europe/Malta',
  logo_url text,
  status text not null default 'active' check (status in ('active','inactive','suspended')),
  owner_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists restaurants_owner_user_idx on public.restaurants(owner_user_id);

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  code text,
  address_line1 text,
  address_line2 text,
  city text,
  country text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,name),
  unique (restaurant_id,code)
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  description text,
  is_system boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists roles_restaurant_name_unique on public.roles(restaurant_id,lower(name));

create table if not exists public.permissions (
  code text primary key,
  module text not null,
  description text not null
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_id,permission_code)
);
create index if not exists role_permissions_permission_idx on public.role_permissions(permission_code);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid references public.roles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','active','rejected','suspended')),
  all_locations boolean not null default false,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,user_id)
);
create index if not exists memberships_user_idx on public.memberships(user_id);
create index if not exists memberships_role_idx on public.memberships(role_id);
create index if not exists memberships_approved_by_idx on public.memberships(approved_by);

create table if not exists public.membership_locations (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  primary key (membership_id,location_id)
);
create index if not exists membership_locations_location_idx on public.membership_locations(location_id);

create table if not exists public.restaurant_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  default_service_mode text not null default 'table' check (default_service_mode in ('table','counter','takeaway','delivery','kiosk')),
  default_payment_timing text not null default 'postpaid' check (default_payment_timing in ('prepaid','postpaid')),
  pager_enabled boolean not null default false,
  order_number_prefix text not null default '',
  tax_inclusive boolean not null default true,
  service_charge_pct numeric(6,3) not null default 0 check (service_charge_pct >= 0),
  allow_split_bill boolean not null default true,
  allow_merge_tables boolean not null default true,
  allow_table_transfer boolean not null default true,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.dining_zones (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  display_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (location_id,name)
);

create table if not exists public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  zone_id uuid references public.dining_zones(id) on delete set null,
  code text not null,
  name text,
  capacity integer not null default 2 check (capacity > 0),
  pos_x numeric(8,3),
  pos_y numeric(8,3),
  shape text not null default 'square' check (shape in ('square','round','rectangle')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id,code)
);
create index if not exists dining_tables_zone_idx on public.dining_tables(zone_id);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  full_name text not null,
  email citext,
  phone text,
  birth_date date,
  notes text,
  marketing_opt_in boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_created_by_idx on public.customers(created_by);
create index if not exists customers_restaurant_email_idx on public.customers(restaurant_id,lower(email::text));
create index if not exists customers_restaurant_phone_idx on public.customers(restaurant_id,phone);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  table_id uuid references public.dining_tables(id) on delete set null,
  customer_name text not null,
  customer_phone text,
  party_size integer not null check (party_size > 0),
  reserved_for timestamptz not null,
  duration_minutes integer not null default 90 check (duration_minutes > 0),
  status text not null default 'pending' check (status in ('pending','confirmed','seated','completed','cancelled','no_show')),
  source text not null default 'manual' check (source in ('manual','phone','web','walk_in','other')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reservations_location_time_idx on public.reservations(location_id,reserved_for);
create index if not exists reservations_restaurant_idx on public.reservations(restaurant_id);
create index if not exists reservations_customer_idx on public.reservations(customer_id);
create index if not exists reservations_table_idx on public.reservations(table_id);
create index if not exists reservations_created_by_idx on public.reservations(created_by);

create table if not exists public.kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  station_type text not null default 'kitchen' check (station_type in ('kitchen','bar','dessert','coffee','other')),
  display_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (location_id,name)
);

create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  parent_id uuid references public.menu_categories(id) on delete set null,
  name text not null,
  description text,
  icon text,
  image_url text,
  display_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,name)
);
create index if not exists menu_categories_parent_idx on public.menu_categories(parent_id);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid references public.menu_categories(id) on delete set null,
  sku text,
  name text not null,
  description text,
  base_price numeric(12,2) not null default 0 check (base_price >= 0),
  tax_rate numeric(6,3) not null default 0 check (tax_rate >= 0),
  image_url text,
  track_inventory boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,sku)
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_restaurant_category_idx on public.products(restaurant_id,category_id);

create table if not exists public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  required boolean not null default false,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id,name),
  check (max_select >= min_select)
);

create table if not exists public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  name text not null,
  price_delta numeric(12,2) not null default 0,
  display_order integer not null default 0,
  active boolean not null default true,
  unique (group_id,name)
);

create table if not exists public.product_modifier_groups (
  product_id uuid not null references public.products(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  display_order integer not null default 0,
  primary key (product_id,group_id)
);
create index if not exists product_modifier_groups_group_idx on public.product_modifier_groups(group_id);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  sku text,
  name text not null,
  unit text not null,
  average_cost numeric(12,4) not null default 0,
  min_stock numeric(14,4) not null default 0,
  max_stock numeric(14,4),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,sku)
);

create table if not exists public.product_recipes (
  product_id uuid not null references public.products(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_required numeric(14,4) not null check (quantity_required > 0),
  primary key (product_id,inventory_item_id)
);
create index if not exists product_recipes_inventory_idx on public.product_recipes(inventory_item_id);

create table if not exists public.product_station_routes (
  product_id uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  station_id uuid not null references public.kitchen_stations(id) on delete cascade,
  primary key (product_id,location_id)
);
create index if not exists product_station_routes_location_idx on public.product_station_routes(location_id);
create index if not exists product_station_routes_station_idx on public.product_station_routes(station_id);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated by default as identity unique,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  parent_order_id uuid references public.orders(id) on delete set null,
  service_mode text not null default 'table' check (service_mode in ('table','counter','takeaway','delivery','kiosk')),
  payment_timing text not null default 'postpaid' check (payment_timing in ('prepaid','postpaid')),
  customer_name text,
  pager_number text,
  guest_count integer check (guest_count is null or guest_count > 0),
  status text not null default 'draft' check (status in ('draft','open','awaiting_payment','closed','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid','refunded')),
  subtotal numeric(12,2) not null default 0,
  discount_total numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  service_charge_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  notes text,
  opened_by uuid references public.profiles(id) on delete set null,
  closed_by uuid references public.profiles(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_restaurant_number_idx on public.orders(restaurant_id,order_number);
create index if not exists orders_location_status_idx on public.orders(location_id,status,opened_at desc);
create index if not exists orders_customer_idx on public.orders(customer_id);
create index if not exists orders_parent_idx on public.orders(parent_order_id);
create index if not exists orders_opened_by_idx on public.orders(opened_by);
create index if not exists orders_closed_by_idx on public.orders(closed_by);

create table if not exists public.order_rounds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  round_number integer not null check (round_number > 0),
  status text not null default 'draft' check (status in ('draft','sent','cancelled')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  sent_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (order_id,round_number)
);
create index if not exists order_rounds_created_by_idx on public.order_rounds(created_by);
create index if not exists order_rounds_sent_by_idx on public.order_rounds(sent_by);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  round_id uuid not null references public.order_rounds(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  station_id uuid references public.kitchen_stations(id) on delete set null,
  product_name text not null,
  sku text,
  quantity numeric(10,3) not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null default 0,
  tax_rate numeric(6,3) not null default 0,
  discount_total numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0,
  note text,
  status text not null default 'draft' check (status in ('draft','sent','preparing','ready','served','cancelled')),
  cancel_reason text,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists order_items_order_idx on public.order_items(order_id,status);
create index if not exists order_items_round_idx on public.order_items(round_id);
create index if not exists order_items_product_idx on public.order_items(product_id);
create index if not exists order_items_station_idx on public.order_items(station_id,status);
create index if not exists order_items_created_by_idx on public.order_items(created_by);
create index if not exists order_items_cancelled_by_idx on public.order_items(cancelled_by);

create table if not exists public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  modifier_option_id uuid references public.modifier_options(id) on delete set null,
  group_name text,
  option_name text not null,
  quantity numeric(10,3) not null default 1 check (quantity > 0),
  price_delta numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists order_item_modifiers_item_idx on public.order_item_modifiers(order_item_id);
create index if not exists order_item_modifiers_option_idx on public.order_item_modifiers(modifier_option_id);

create table if not exists public.order_table_links (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  table_id uuid not null references public.dining_tables(id) on delete restrict,
  is_primary boolean not null default false,
  linked_by uuid references public.profiles(id) on delete set null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz
);
create unique index if not exists one_active_order_per_table on public.order_table_links(table_id) where unlinked_at is null;
create index if not exists order_table_links_order_idx on public.order_table_links(order_id,unlinked_at);
create index if not exists order_table_links_linked_by_idx on public.order_table_links(linked_by);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_number bigint generated by default as identity unique,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  method text not null check (method in ('cash','card','bank','voucher','other')),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'completed' check (status in ('pending','completed','voided','refunded')),
  reference text,
  received_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists payments_order_idx on public.payments(order_id,status);
create index if not exists payments_restaurant_idx on public.payments(restaurant_id);
create index if not exists payments_location_idx on public.payments(location_id);
create index if not exists payments_received_by_idx on public.payments(received_by);

create table if not exists public.payment_allocations (
  payment_id uuid not null references public.payments(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  primary key (payment_id,order_item_id)
);
create index if not exists payment_allocations_item_idx on public.payment_allocations(order_item_id);

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events(order_id,created_at desc);
create index if not exists order_events_actor_user_idx on public.order_events(actor_user_id);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  contact_name text,
  email citext,
  phone text,
  address text,
  tax_id text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id,name)
);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number bigint generated by default as identity unique,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','sent','partially_received','received','cancelled')),
  subtotal numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  expected_at timestamptz,
  ordered_at timestamptz,
  received_at timestamptz,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists purchase_orders_restaurant_idx on public.purchase_orders(restaurant_id);
create index if not exists purchase_orders_location_idx on public.purchase_orders(location_id);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders(supplier_id);
create index if not exists purchase_orders_created_by_idx on public.purchase_orders(created_by);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity_ordered numeric(14,4) not null check (quantity_ordered > 0),
  quantity_received numeric(14,4) not null default 0 check (quantity_received >= 0),
  unit_cost numeric(12,4) not null default 0,
  line_total numeric(12,2) not null default 0,
  unique (purchase_order_id,inventory_item_id)
);
create index if not exists purchase_order_items_inventory_idx on public.purchase_order_items(inventory_item_id);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  movement_type text not null check (movement_type in ('opening','purchase','sale','waste','adjustment','transfer_in','transfer_out','return','count')),
  quantity_delta numeric(14,4) not null check (quantity_delta <> 0),
  unit_cost numeric(12,4),
  reference_type text,
  reference_id uuid,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_movements_item_location_idx on public.inventory_movements(inventory_item_id,location_id,created_at);
create index if not exists inventory_movements_restaurant_idx on public.inventory_movements(restaurant_id);
create index if not exists inventory_movements_location_idx on public.inventory_movements(location_id);
create index if not exists inventory_movements_created_by_idx on public.inventory_movements(created_by);

create table if not exists public.display_screens (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  screen_type text not null default 'public' check (screen_type in ('public','kds','bar','queue')),
  active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id,name)
);

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid references public.locations(id) on delete cascade,
  platform text not null check (platform in ('instagram','facebook','tiktok','youtube','other')),
  handle text,
  profile_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_accounts_restaurant_idx on public.social_accounts(restaurant_id);
create index if not exists social_accounts_location_idx on public.social_accounts(location_id);

create table if not exists public.social_metrics (
  id bigint generated by default as identity primary key,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  followers_count bigint,
  likes_count bigint,
  captured_at timestamptz not null default now()
);
create index if not exists social_metrics_account_time_idx on public.social_metrics(social_account_id,captured_at desc);

create table if not exists public.audit_logs (
  id bigint generated by default as identity primary key,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_restaurant_time_idx on public.audit_logs(restaurant_id,created_at desc);
create index if not exists audit_logs_actor_user_idx on public.audit_logs(actor_user_id);

create table if not exists public.role_presets (
  code text primary key,
  name text not null,
  description text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.role_preset_permissions (
  preset_code text not null references public.role_presets(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (preset_code,permission_code)
);

-- Auth profile trigger
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email, phone, username, avatar_url, access_status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.email,
    new.raw_user_meta_data ->> 'phone',
    nullif(new.raw_user_meta_data ->> 'username',''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    'pending'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- updated_at triggers
DO $$
declare t text;
begin
  foreach t in array array['profiles','restaurants','locations','roles','memberships','dining_tables','customers','reservations','menu_categories','products','inventory_items','orders','order_items','suppliers','purchase_orders','display_screens','social_accounts']
  loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I',t,t);
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',t,t);
  end loop;
end $$;

-- Permissions
insert into public.permissions(code,module,description) values
('dashboard.view','dashboard','Ver dashboard'),
('tables.view','tables','Ver mesas'),
('tables.manage','tables','Gestionar mesas y zonas'),
('orders.view','orders','Ver pedidos'),
('orders.create','orders','Crear pedidos'),
('orders.update','orders','Editar pedidos abiertos'),
('orders.cancel','orders','Cancelar pedidos o productos'),
('kitchen.view','kitchen','Ver KDS de cocina'),
('kitchen.update','kitchen','Actualizar estados de cocina'),
('bar.view','bar','Ver KDS de bar'),
('bar.update','bar','Actualizar estados de bar'),
('payments.view','payments','Ver cobros'),
('payments.create','payments','Registrar pagos'),
('payments.refund','payments','Anular o reembolsar pagos'),
('products.view','products','Ver productos y menú'),
('products.manage','products','Gestionar productos, categorías y modificadores'),
('customers.view','customers','Ver clientes'),
('customers.manage','customers','Crear y editar clientes'),
('reservations.view','reservations','Ver reservas'),
('reservations.manage','reservations','Gestionar reservas'),
('inventory.view','inventory','Ver inventario'),
('inventory.manage','inventory','Gestionar inventario y compras'),
('reports.view','reports','Ver reportes'),
('display.view','display','Ver pantallas públicas'),
('display.manage','display','Gestionar pantallas y redes sociales'),
('staff.view','staff','Ver personal y roles'),
('staff.manage','staff','Gestionar usuarios, roles y permisos'),
('settings.view','settings','Ver configuración'),
('settings.manage','settings','Editar configuración')
on conflict (code) do update set module=excluded.module,description=excluded.description;

insert into public.role_presets(code,name,description,sort_order) values
('owner','Owner / Super Admin','Control total del restaurante, usuarios, permisos, configuración, ventas e inventario.',10),
('manager','Manager / Supervisor','Supervisión de la operación diaria, pedidos, caja, incidencias y reportes.',20),
('waiter','Waiter / Mesero','Mesas, toma de pedidos y seguimiento del servicio.',30),
('cashier','Cashier / Caja','Cobros, pagos, división de cuentas y cierre de órdenes.',40),
('kitchen','Kitchen / Cocina','Visualización y actualización de comandas de cocina.',50),
('bar','Bar','Visualización y actualización de comandas de bar.',60),
('inventory','Inventory / Store','Inventario, movimientos, stock, proveedores y compras.',70)
on conflict (code) do update set name=excluded.name,description=excluded.description,sort_order=excluded.sort_order;

-- Preset permissions. Owner receives every permission.
insert into public.role_preset_permissions(preset_code,permission_code)
select 'owner',code from public.permissions
on conflict do nothing;

insert into public.role_preset_permissions(preset_code,permission_code) values
('manager','bar.update'),('manager','bar.view'),('manager','customers.manage'),('manager','customers.view'),('manager','dashboard.view'),('manager','display.manage'),('manager','display.view'),('manager','inventory.view'),('manager','kitchen.update'),('manager','kitchen.view'),('manager','orders.cancel'),('manager','orders.create'),('manager','orders.update'),('manager','orders.view'),('manager','payments.create'),('manager','payments.refund'),('manager','payments.view'),('manager','products.manage'),('manager','products.view'),('manager','reports.view'),('manager','reservations.manage'),('manager','reservations.view'),('manager','settings.view'),('manager','staff.view'),('manager','tables.manage'),('manager','tables.view'),
('waiter','dashboard.view'),('waiter','orders.create'),('waiter','orders.update'),('waiter','orders.view'),('waiter','products.view'),('waiter','tables.view'),
('cashier','customers.view'),('cashier','dashboard.view'),('cashier','orders.view'),('cashier','payments.create'),('cashier','payments.view'),('cashier','products.view'),('cashier','tables.view'),
('kitchen','kitchen.update'),('kitchen','kitchen.view'),('kitchen','orders.view'),('kitchen','products.view'),
('bar','bar.update'),('bar','bar.view'),('bar','orders.view'),('bar','products.view'),
('inventory','inventory.manage'),('inventory','inventory.view'),('inventory','products.view')
on conflict do nothing;

-- RLS: all public tables are protected. Only the bootstrap policies required for authentication are opened here.
DO $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname='public'
  loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end $$;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists memberships_select_self on public.memberships;
create policy memberships_select_self on public.memberships for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists membership_locations_select_self on public.membership_locations;
create policy membership_locations_select_self on public.membership_locations for select to authenticated using (
  exists(select 1 from public.memberships m where m.id=membership_id and m.user_id=(select auth.uid()))
);

drop policy if exists restaurants_select_member on public.restaurants;
create policy restaurants_select_member on public.restaurants for select to authenticated using (
  exists(select 1 from public.memberships m where m.user_id=(select auth.uid()) and m.restaurant_id=restaurants.id)
);

drop policy if exists locations_select_member on public.locations;
create policy locations_select_member on public.locations for select to authenticated using (
  exists(
    select 1 from public.memberships m
    where m.user_id=(select auth.uid()) and m.restaurant_id=locations.restaurant_id
      and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=locations.id))
  )
);

drop policy if exists roles_select_assigned on public.roles;
create policy roles_select_assigned on public.roles for select to authenticated using (
  exists(select 1 from public.memberships m where m.user_id=(select auth.uid()) and m.role_id=roles.id)
);

drop policy if exists role_permissions_select_assigned on public.role_permissions;
create policy role_permissions_select_assigned on public.role_permissions for select to authenticated using (
  exists(select 1 from public.memberships m where m.user_id=(select auth.uid()) and m.role_id=role_permissions.role_id)
);

drop policy if exists permissions_select_authenticated on public.permissions;
create policy permissions_select_authenticated on public.permissions for select to authenticated using (true);

-- Minimal Data API grants needed by the authentication/bootstrap flow.
grant select on public.profiles to authenticated;
grant update (full_name, phone, username, avatar_url) on public.profiles to authenticated;
grant select on public.memberships,public.membership_locations,public.restaurants,public.locations,public.roles,public.role_permissions,public.permissions to authenticated;
