-- Cover the restaurant foreign key used by membership and cleanup queries.
create index if not exists inventory_availability_events_restaurant_idx
  on public.inventory_availability_events (restaurant_id);
