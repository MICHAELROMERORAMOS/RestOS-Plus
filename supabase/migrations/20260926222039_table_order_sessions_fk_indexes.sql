create index if not exists table_order_sessions_restaurant_idx
  on public.table_order_sessions(restaurant_id);

create index if not exists table_order_sessions_claimed_by_idx
  on public.table_order_sessions(claimed_by);
