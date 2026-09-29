-- Applied to the RestOS+ Supabase project on 2026-09-29.
-- Adds indexes for tenant composite FKs and optimizes company profile RLS.

create index if not exists memberships_role_restaurant_idx on public.memberships(role_id, restaurant_id);
create index if not exists products_category_restaurant_idx on public.products(category_id, restaurant_id);
create index if not exists orders_location_restaurant_idx on public.orders(location_id, restaurant_id);
create index if not exists inventory_movements_location_restaurant_idx on public.inventory_movements(location_id, restaurant_id);
create index if not exists payments_order_restaurant_idx on public.payments(order_id, restaurant_id);
create index if not exists sales_invoices_order_restaurant_idx on public.sales_invoices(order_id, restaurant_id);

drop policy if exists "company profile members can read" on public.company_profiles;
create policy "company profile members can read"
on public.company_profiles for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.restaurant_id=company_profiles.restaurant_id
    and m.user_id=(select auth.uid())
    and m.status='active'
));

drop policy if exists "company profile managers can write" on public.company_profiles;
create policy "company profile managers can write"
on public.company_profiles for all to authenticated
using (exists (
  select 1 from public.memberships m
  join public.role_permissions rp on rp.role_id=m.role_id
  where m.restaurant_id=company_profiles.restaurant_id
    and m.user_id=(select auth.uid())
    and m.status='active'
    and rp.permission_code='settings.manage'
))
with check (exists (
  select 1 from public.memberships m
  join public.role_permissions rp on rp.role_id=m.role_id
  where m.restaurant_id=company_profiles.restaurant_id
    and m.user_id=(select auth.uid())
    and m.status='active'
    and rp.permission_code='settings.manage'
));
