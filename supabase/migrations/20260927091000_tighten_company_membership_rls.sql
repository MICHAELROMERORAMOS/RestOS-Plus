drop policy if exists restaurants_select_member on public.restaurants;
create policy restaurants_select_member
on public.restaurants
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id=(select auth.uid())
      and m.restaurant_id=restaurants.id
      and m.status='active'
  )
);

drop policy if exists role_permissions_select_assigned on public.role_permissions;
create policy role_permissions_select_assigned
on public.role_permissions
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id=(select auth.uid())
      and m.role_id=role_permissions.role_id
      and m.status='active'
  )
);

drop policy if exists roles_select_authorized on public.roles;
create policy roles_select_authorized
on public.roles
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id=(select auth.uid())
      and m.role_id=roles.id
      and m.status='active'
  )
  or private.user_has_restaurant_permission(roles.restaurant_id,'staff.view')
);
