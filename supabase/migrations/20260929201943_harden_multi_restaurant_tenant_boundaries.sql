-- Applied to the RestOS+ Supabase project on 2026-09-29.
-- Adds database-level tenant consistency and closes anonymous RPC execution.

create unique index if not exists locations_id_restaurant_uidx on public.locations(id, restaurant_id);
create unique index if not exists roles_id_restaurant_uidx on public.roles(id, restaurant_id);
create unique index if not exists menu_categories_id_restaurant_uidx on public.menu_categories(id, restaurant_id);
create unique index if not exists orders_id_restaurant_uidx on public.orders(id, restaurant_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='memberships_role_same_restaurant_fk') then
    alter table public.memberships add constraint memberships_role_same_restaurant_fk foreign key (role_id, restaurant_id) references public.roles(id, restaurant_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='products_category_same_restaurant_fk') then
    alter table public.products add constraint products_category_same_restaurant_fk foreign key (category_id, restaurant_id) references public.menu_categories(id, restaurant_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='orders_location_same_restaurant_fk') then
    alter table public.orders add constraint orders_location_same_restaurant_fk foreign key (location_id, restaurant_id) references public.locations(id, restaurant_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_movements_location_same_restaurant_fk') then
    alter table public.inventory_movements add constraint inventory_movements_location_same_restaurant_fk foreign key (location_id, restaurant_id) references public.locations(id, restaurant_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='payments_order_same_restaurant_fk') then
    alter table public.payments add constraint payments_order_same_restaurant_fk foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='sales_invoices_order_same_restaurant_fk') then
    alter table public.sales_invoices add constraint sales_invoices_order_same_restaurant_fk foreign key (order_id, restaurant_id) references public.orders(id, restaurant_id) not valid;
  end if;
end $$;

alter table public.memberships validate constraint memberships_role_same_restaurant_fk;
alter table public.products validate constraint products_category_same_restaurant_fk;
alter table public.orders validate constraint orders_location_same_restaurant_fk;
alter table public.inventory_movements validate constraint inventory_movements_location_same_restaurant_fk;
alter table public.payments validate constraint payments_order_same_restaurant_fk;
alter table public.sales_invoices validate constraint sales_invoices_order_same_restaurant_fk;

do $$
declare r record;
begin
  for r in
    select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
  loop
    execute format('revoke execute on function %I.%I(%s) from public, anon',r.nspname,r.proname,r.args);
    if r.proname not like '%\_internal' escape '\'
       and r.proname not in ('handle_new_user','rls_auto_enable','set_updated_at') then
      execute format('grant execute on function %I.%I(%s) to authenticated',r.nspname,r.proname,r.args);
    end if;
  end loop;
end $$;
