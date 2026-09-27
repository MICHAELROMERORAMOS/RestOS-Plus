drop policy if exists locations_select_member on public.locations;
create policy locations_select_member
on public.locations
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id=(select auth.uid())
      and m.restaurant_id=locations.restaurant_id
      and m.status='active'
      and (
        m.all_locations
        or exists (
          select 1 from public.membership_locations ml
          where ml.membership_id=m.id and ml.location_id=locations.id
        )
      )
  )
);

drop policy if exists "inventory movements visible to inventory roles" on public.inventory_movements;
create policy "inventory movements visible to assigned inventory roles"
on public.inventory_movements
for select
to authenticated
using (
  private.user_has_location_permission(location_id,'inventory.view')
  or private.user_has_location_permission(location_id,'inventory.manage')
);

drop policy if exists "invoice customers visible to billing roles" on public.order_invoice_customers;
create policy "invoice customers visible to assigned billing roles"
on public.order_invoice_customers
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id=order_invoice_customers.order_id
      and (
        private.user_has_location_permission(o.location_id,'reports.view')
        or private.user_has_location_permission(o.location_id,'payments.view')
        or private.user_has_location_permission(o.location_id,'payments.create')
      )
  )
);
