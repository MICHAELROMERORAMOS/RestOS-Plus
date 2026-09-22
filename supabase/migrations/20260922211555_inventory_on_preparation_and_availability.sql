-- Consume recipe ingredients as each item is sent to preparation, restore
-- them when that preparation is cancelled, and expose lightweight product
-- availability for the order-entry screen.

alter table public.restaurant_settings
  add column if not exists block_insufficient_inventory boolean not null default true;

-- The previous implementation consumed inventory when the whole order became
-- paid. Consumption now happens per order item when it is sent to preparation.
drop trigger if exists orders_consume_inventory_when_paid on public.orders;

create unique index if not exists inventory_order_item_sale_uq
  on public.inventory_movements (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'sale'
    and reference_type = 'order_item'
    and reference_id is not null;

create unique index if not exists inventory_order_item_return_uq
  on public.inventory_movements (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'return'
    and reference_type = 'order_item'
    and reference_id is not null;

-- One small row per location is used only as a Realtime invalidation signal.
-- It avoids exposing costs or the complete inventory ledger to order-entry roles.
create table if not exists public.inventory_availability_events (
  location_id uuid primary key references public.locations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  version bigint not null default 1,
  changed_at timestamptz not null default now()
);

alter table public.inventory_availability_events enable row level security;

drop policy if exists "inventory availability events visible to location members"
  on public.inventory_availability_events;
create policy "inventory availability events visible to location members"
on public.inventory_availability_events
for select
to authenticated
using (
  exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.restaurant_id = inventory_availability_events.restaurant_id
      and m.status = 'active'
      and (
        m.all_locations = true
        or exists (
          select 1
          from public.membership_locations ml
          where ml.membership_id = m.id
            and ml.location_id = inventory_availability_events.location_id
        )
      )
  )
);

revoke all on table public.inventory_availability_events from public, anon, authenticated;
grant select on table public.inventory_availability_events to authenticated;
grant all on table public.inventory_availability_events to service_role;

create or replace function private.touch_inventory_availability_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_restaurant_id uuid;
begin
  if tg_op = 'DELETE' then
    v_location_id := old.location_id;
    v_restaurant_id := old.restaurant_id;
  else
    v_location_id := new.location_id;
    v_restaurant_id := new.restaurant_id;
  end if;

  insert into public.inventory_availability_events (
    location_id, restaurant_id, version, changed_at
  ) values (
    v_location_id, v_restaurant_id, 1, now()
  )
  on conflict (location_id) do update
  set restaurant_id = excluded.restaurant_id,
      version = public.inventory_availability_events.version + 1,
      changed_at = now();

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_movements_touch_availability
  on public.inventory_movements;
create trigger inventory_movements_touch_availability
after insert or update or delete on public.inventory_movements
for each row execute function private.touch_inventory_availability_event();

insert into public.inventory_availability_events (
  location_id, restaurant_id, version, changed_at
)
select m.location_id, m.restaurant_id, 1, max(m.created_at)
from public.inventory_movements m
group by m.location_id, m.restaurant_id
on conflict (location_id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_availability_events'
  ) then
    alter publication supabase_realtime
      add table public.inventory_availability_events;
  end if;
end;
$$;

create or replace function private.get_product_inventory_availability_impl(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_enforcement_enabled boolean;
  v_products jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not (
    private.user_has_location_permission(p_location_id, 'orders.create')
    or private.user_has_location_permission(p_location_id, 'inventory.view')
    or private.user_has_location_permission(p_location_id, 'inventory.manage')
  ) then
    raise exception 'Not allowed to view product availability';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Location does not belong to this restaurant';
  end if;

  select coalesce(s.block_insufficient_inventory, true)
  into v_enforcement_enabled
  from public.restaurant_settings s
  where s.restaurant_id = p_restaurant_id;

  v_enforcement_enabled := coalesce(v_enforcement_enabled, true);

  with stock_by_item as (
    select
      i.id as inventory_item_id,
      coalesce(sum(m.quantity_delta), 0) as stock
    from public.inventory_items i
    left join public.inventory_movements m
      on m.inventory_item_id = i.id
     and m.location_id = p_location_id
    where i.restaurant_id = p_restaurant_id
    group by i.id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'productId', p.id,
      'trackInventory', p.track_inventory,
      'hasRecipe', exists (
        select 1
        from public.product_recipes recipe_check
        where recipe_check.product_id = p.id
      ),
      'maxPreparations', case
        when p.track_inventory and exists (
          select 1
          from public.product_recipes recipe_check
          where recipe_check.product_id = p.id
        ) then (
          select greatest(
            0,
            coalesce(floor(min(
              coalesce(stock.stock, 0) / nullif(recipe.quantity_required, 0)
            )), 0)
          )::bigint
          from public.product_recipes recipe
          left join stock_by_item stock
            on stock.inventory_item_id = recipe.inventory_item_id
          where recipe.product_id = p.id
        )
        else null
      end,
      'ingredients', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'inventoryItemId', item.id,
            'name', item.name,
            'unit', item.unit,
            'quantityRequired', recipe.quantity_required,
            'availableQuantity', coalesce(stock.stock, 0)
          )
          order by item.name
        )
        from public.product_recipes recipe
        join public.inventory_items item
          on item.id = recipe.inventory_item_id
        left join stock_by_item stock
          on stock.inventory_item_id = item.id
        where recipe.product_id = p.id
      ), '[]'::jsonb)
    )
    order by p.name
  ), '[]'::jsonb)
  into v_products
  from public.products p
  where p.restaurant_id = p_restaurant_id
    and p.active = true;

  return jsonb_build_object(
    'enforcementEnabled', v_enforcement_enabled,
    'products', v_products,
    'generatedAt', now()
  );
end;
$$;

create or replace function public.get_product_inventory_availability(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.get_product_inventory_availability_impl(
    p_restaurant_id,
    p_location_id
  );
$$;

create or replace function private.consume_inventory_for_order_item(
  p_order_item_id uuid,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_enforce boolean;
  v_shortage record;
begin
  select
    oi.id,
    oi.product_id,
    oi.product_name,
    oi.quantity,
    o.id as order_id,
    o.order_number,
    o.restaurant_id,
    o.location_id,
    o.opened_by,
    p.track_inventory
  into v_line
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.products p on p.id = oi.product_id
  where oi.id = p_order_item_id;

  if not found or v_line.product_id is null or coalesce(v_line.track_inventory, false) = false then
    return;
  end if;

  if not exists (
    select 1
    from public.product_recipes pr
    where pr.product_id = v_line.product_id
  ) then
    return;
  end if;

  -- Every path that changes stock locks the ingredient row first. Ordering the
  -- locks prevents deadlocks when two recipes share multiple ingredients.
  perform 1
  from public.inventory_items i
  join public.product_recipes pr on pr.inventory_item_id = i.id
  where pr.product_id = v_line.product_id
    and i.restaurant_id = v_line.restaurant_id
  order by i.id
  for update of i;

  select coalesce(s.block_insufficient_inventory, true)
  into v_enforce
  from public.restaurant_settings s
  where s.restaurant_id = v_line.restaurant_id;
  v_enforce := coalesce(v_enforce, true);

  if v_enforce then
    select
      i.name,
      i.unit,
      pr.quantity_required * v_line.quantity as required_quantity,
      coalesce((
        select sum(m.quantity_delta)
        from public.inventory_movements m
        where m.inventory_item_id = i.id
          and m.location_id = v_line.location_id
      ), 0) as available_quantity
    into v_shortage
    from public.product_recipes pr
    join public.inventory_items i on i.id = pr.inventory_item_id
    where pr.product_id = v_line.product_id
      and coalesce((
        select sum(m.quantity_delta)
        from public.inventory_movements m
        where m.inventory_item_id = i.id
          and m.location_id = v_line.location_id
      ), 0) + 0.000001 < pr.quantity_required * v_line.quantity
    order by i.name
    limit 1;

    if found then
      raise exception 'No se puede preparar "%": inventario insuficiente de %. Disponible: % %; requerido: % %.',
        v_line.product_name,
        v_shortage.name,
        round(v_shortage.available_quantity, 3),
        v_shortage.unit,
        round(v_shortage.required_quantity, 3),
        v_shortage.unit;
    end if;
  end if;

  insert into public.inventory_movements (
    restaurant_id,
    location_id,
    inventory_item_id,
    movement_type,
    quantity_delta,
    unit_cost,
    reference_type,
    reference_id,
    note,
    created_by
  )
  select
    v_line.restaurant_id,
    v_line.location_id,
    pr.inventory_item_id,
    'sale',
    -(pr.quantity_required * v_line.quantity),
    i.average_cost,
    'order_item',
    v_line.id,
    'Preparación automática · Orden #' || v_line.order_number || ' · ' || v_line.product_name,
    coalesce(p_actor, (select auth.uid()), v_line.opened_by)
  from public.product_recipes pr
  join public.inventory_items i
    on i.id = pr.inventory_item_id
   and i.restaurant_id = v_line.restaurant_id
  where pr.product_id = v_line.product_id
    and pr.quantity_required * v_line.quantity > 0
  on conflict (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'sale'
    and reference_type = 'order_item'
    and reference_id is not null
  do nothing;
end;
$$;

create or replace function private.restore_inventory_for_order_item(
  p_order_item_id uuid,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
begin
  select
    oi.id,
    oi.product_name,
    o.order_number,
    o.opened_by
  into v_line
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id;

  if not found then
    return;
  end if;

  perform 1
  from public.inventory_items i
  join public.inventory_movements consumed
    on consumed.inventory_item_id = i.id
   and consumed.reference_type = 'order_item'
   and consumed.reference_id = p_order_item_id
   and consumed.movement_type = 'sale'
  order by i.id
  for update of i;

  insert into public.inventory_movements (
    restaurant_id,
    location_id,
    inventory_item_id,
    movement_type,
    quantity_delta,
    unit_cost,
    reference_type,
    reference_id,
    note,
    created_by
  )
  select
    consumed.restaurant_id,
    consumed.location_id,
    consumed.inventory_item_id,
    'return',
    -consumed.quantity_delta,
    consumed.unit_cost,
    'order_item',
    p_order_item_id,
    'Reposición por anulación · Orden #' || v_line.order_number || ' · ' || v_line.product_name,
    coalesce(p_actor, (select auth.uid()), v_line.opened_by)
  from public.inventory_movements consumed
  where consumed.reference_type = 'order_item'
    and consumed.reference_id = p_order_item_id
    and consumed.movement_type = 'sale'
    and consumed.quantity_delta < 0
  on conflict (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'return'
    and reference_type = 'order_item'
    and reference_id is not null
  do nothing;
end;
$$;

create or replace function private.apply_order_item_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status in ('sent', 'preparing', 'ready') then
      perform private.consume_inventory_for_order_item(new.id, new.created_by);
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status in ('sent', 'preparing', 'ready') then
    perform private.consume_inventory_for_order_item(new.id, new.created_by);
  elsif new.status = 'cancelled'
    and old.status in ('sent', 'preparing', 'ready') then
    perform private.restore_inventory_for_order_item(new.id, new.cancelled_by);
  end if;

  return new;
end;
$$;

drop trigger if exists order_items_apply_inventory on public.order_items;
create trigger order_items_apply_inventory
after insert or update of status on public.order_items
for each row execute function private.apply_order_item_inventory();

revoke all on function private.touch_inventory_availability_event() from public, anon, authenticated;
revoke all on function private.get_product_inventory_availability_impl(uuid, uuid) from public, anon;
revoke all on function private.consume_inventory_for_order_item(uuid, uuid) from public, anon, authenticated;
revoke all on function private.restore_inventory_for_order_item(uuid, uuid) from public, anon, authenticated;
revoke all on function private.apply_order_item_inventory() from public, anon, authenticated;

grant execute on function private.get_product_inventory_availability_impl(uuid, uuid)
  to authenticated, service_role;

revoke all on function public.get_product_inventory_availability(uuid, uuid)
  from public, anon;
grant execute on function public.get_product_inventory_availability(uuid, uuid)
  to authenticated, service_role;
