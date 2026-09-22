-- Inventory workspace for supplies, ledger movements, recipes and automatic
-- consumption when an order becomes fully paid.

alter table public.inventory_items
  drop constraint if exists inventory_items_average_cost_check,
  drop constraint if exists inventory_items_min_stock_check,
  drop constraint if exists inventory_items_max_stock_check;

alter table public.inventory_items
  add constraint inventory_items_average_cost_check check (average_cost >= 0),
  add constraint inventory_items_min_stock_check check (min_stock >= 0),
  add constraint inventory_items_max_stock_check check (max_stock is null or max_stock >= min_stock);

create index if not exists inventory_items_restaurant_active_name_idx
  on public.inventory_items (restaurant_id, active, name);

create index if not exists orders_invoice_register_idx
  on public.orders (restaurant_id, invoice_issued_at desc)
  where payment_status = 'paid' and invoice_number is not null;

create unique index if not exists inventory_sale_reference_uq
  on public.inventory_movements (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'sale'
    and reference_type = 'order'
    and reference_id is not null;

drop trigger if exists set_inventory_items_updated_at on public.inventory_items;
create trigger set_inventory_items_updated_at
before update on public.inventory_items
for each row execute function public.set_updated_at();

-- Read access is available only to active members with inventory permissions.
-- All writes go through the validated RPCs below.
drop policy if exists "inventory items visible to inventory roles" on public.inventory_items;
create policy "inventory items visible to inventory roles"
on public.inventory_items
for select
to authenticated
using (
  private.user_has_restaurant_permission(restaurant_id, 'inventory.view')
  or private.user_has_restaurant_permission(restaurant_id, 'inventory.manage')
);

drop policy if exists "inventory movements visible to inventory roles" on public.inventory_movements;
create policy "inventory movements visible to inventory roles"
on public.inventory_movements
for select
to authenticated
using (
  private.user_has_restaurant_permission(restaurant_id, 'inventory.view')
  or private.user_has_restaurant_permission(restaurant_id, 'inventory.manage')
);

drop policy if exists "product recipes visible to inventory roles" on public.product_recipes;
create policy "product recipes visible to inventory roles"
on public.product_recipes
for select
to authenticated
using (
  exists (
    select 1
    from public.products p
    where p.id = product_recipes.product_id
      and (
        private.user_has_restaurant_permission(p.restaurant_id, 'inventory.view')
        or private.user_has_restaurant_permission(p.restaurant_id, 'inventory.manage')
      )
  )
);

revoke all on table public.inventory_items from anon, authenticated;
revoke all on table public.inventory_movements from anon, authenticated;
revoke all on table public.product_recipes from anon, authenticated;
grant select on table public.inventory_items to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.product_recipes to authenticated;
grant all on table public.inventory_items to service_role;
grant all on table public.inventory_movements to service_role;
grant all on table public.product_recipes to service_role;

create or replace function private.get_inventory_workspace_impl(
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
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not (
    private.user_has_location_permission(p_location_id, 'inventory.view')
    or private.user_has_location_permission(p_location_id, 'inventory.manage')
  ) then
    raise exception 'Not allowed to view inventory';
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

  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'sku', i.sku,
          'name', i.name,
          'unit', i.unit,
          'averageCost', i.average_cost,
          'minStock', i.min_stock,
          'maxStock', i.max_stock,
          'active', i.active,
          'stock', coalesce(s.stock, 0),
          'stockValue', round(coalesce(s.stock, 0) * i.average_cost, 2),
          'updatedAt', i.updated_at
        )
        order by i.active desc, i.name
      )
      from public.inventory_items i
      left join lateral (
        select coalesce(sum(m.quantity_delta), 0) as stock
        from public.inventory_movements m
        where m.inventory_item_id = i.id
          and m.location_id = p_location_id
      ) s on true
      where i.restaurant_id = p_restaurant_id
    ), '[]'::jsonb),
    'recipes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'productId', pr.product_id,
          'inventoryItemId', pr.inventory_item_id,
          'quantityRequired', pr.quantity_required
        )
        order by p.name, i.name
      )
      from public.product_recipes pr
      join public.products p on p.id = pr.product_id
      join public.inventory_items i on i.id = pr.inventory_item_id
      where p.restaurant_id = p_restaurant_id
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(x.payload order by x.created_at desc)
      from (
        select
          m.created_at,
          jsonb_build_object(
            'id', m.id,
            'inventoryItemId', m.inventory_item_id,
            'itemName', i.name,
            'unit', i.unit,
            'movementType', m.movement_type,
            'quantityDelta', m.quantity_delta,
            'unitCost', m.unit_cost,
            'referenceType', m.reference_type,
            'referenceId', m.reference_id,
            'note', m.note,
            'createdByName', p.full_name,
            'createdAt', m.created_at
          ) as payload
        from public.inventory_movements m
        join public.inventory_items i on i.id = m.inventory_item_id
        left join public.profiles p on p.id = m.created_by
        where m.restaurant_id = p_restaurant_id
          and m.location_id = p_location_id
        order by m.created_at desc
        limit 150
      ) x
    ), '[]'::jsonb),
    'generatedAt', now()
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.get_inventory_workspace(
  p_restaurant_id uuid,
  p_location_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.get_inventory_workspace_impl(p_restaurant_id, p_location_id);
$$;

create or replace function private.save_inventory_item_impl(
  p_item_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_name text,
  p_sku text,
  p_unit text,
  p_average_cost numeric,
  p_min_stock numeric,
  p_max_stock numeric,
  p_active boolean,
  p_opening_stock numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_item public.inventory_items%rowtype;
  v_is_new boolean := p_item_id is null;
  v_name text := btrim(coalesce(p_name, ''));
  v_sku text := nullif(upper(btrim(coalesce(p_sku, ''))), '');
  v_unit text := lower(btrim(coalesce(p_unit, '')));
  v_average_cost numeric := coalesce(p_average_cost, 0);
  v_min_stock numeric := coalesce(p_min_stock, 0);
  v_opening_stock numeric := coalesce(p_opening_stock, 0);
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id, 'inventory.manage') then
    raise exception 'Not allowed to manage inventory';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Location does not belong to this restaurant';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 140 then
    raise exception 'Inventory item name must contain between 2 and 140 characters';
  end if;

  if v_unit not in ('unidad', 'g', 'kg', 'ml', 'l', 'porcion') then
    raise exception 'Invalid inventory unit';
  end if;

  if v_average_cost < 0 or v_min_stock < 0 or v_opening_stock < 0 then
    raise exception 'Inventory values cannot be negative';
  end if;

  if p_max_stock is not null and p_max_stock < v_min_stock then
    raise exception 'Maximum stock cannot be lower than minimum stock';
  end if;

  if v_is_new then
    insert into public.inventory_items (
      restaurant_id, sku, name, unit, average_cost, min_stock, max_stock, active
    ) values (
      p_restaurant_id, v_sku, v_name, v_unit, v_average_cost,
      v_min_stock, p_max_stock, coalesce(p_active, true)
    )
    returning * into v_item;

    if v_opening_stock > 0 then
      insert into public.inventory_movements (
        restaurant_id, location_id, inventory_item_id, movement_type,
        quantity_delta, unit_cost, reference_type, note, created_by
      ) values (
        p_restaurant_id, p_location_id, v_item.id, 'opening',
        v_opening_stock, v_average_cost, 'manual_opening',
        'Existencia inicial', v_actor
      );
    end if;
  else
    update public.inventory_items
    set sku = v_sku,
        name = v_name,
        unit = v_unit,
        average_cost = v_average_cost,
        min_stock = v_min_stock,
        max_stock = p_max_stock,
        active = coalesce(p_active, true)
    where id = p_item_id
      and restaurant_id = p_restaurant_id
    returning * into v_item;

    if not found then
      raise exception 'Inventory item not found';
    end if;
  end if;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, entity_type, entity_id, action, details
  ) values (
    p_restaurant_id,
    v_actor,
    'inventory_item',
    v_item.id,
    case when v_is_new then 'create' else 'update' end,
    jsonb_build_object('name', v_item.name, 'unit', v_item.unit, 'sku', v_item.sku)
  );

  return jsonb_build_object('id', v_item.id, 'created', v_is_new);
exception when unique_violation then
  raise exception 'Inventory SKU is already in use';
end;
$$;

create or replace function public.save_inventory_item(
  p_item_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_name text,
  p_sku text,
  p_unit text,
  p_average_cost numeric,
  p_min_stock numeric,
  p_max_stock numeric,
  p_active boolean,
  p_opening_stock numeric
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.save_inventory_item_impl(
    p_item_id, p_restaurant_id, p_location_id, p_name, p_sku, p_unit,
    p_average_cost, p_min_stock, p_max_stock, p_active, p_opening_stock
  );
$$;

create or replace function private.record_inventory_movement_impl(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_inventory_item_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_item public.inventory_items%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_type text := lower(btrim(coalesce(p_movement_type, '')));
  v_quantity numeric := coalesce(p_quantity, 0);
  v_delta numeric;
  v_stock numeric;
  v_new_cost numeric;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id, 'inventory.manage') then
    raise exception 'Not allowed to manage inventory';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Location does not belong to this restaurant';
  end if;

  select * into v_item
  from public.inventory_items i
  where i.id = p_inventory_item_id
    and i.restaurant_id = p_restaurant_id
  for update;

  if not found then
    raise exception 'Inventory item not found';
  end if;

  if v_type not in ('purchase', 'waste', 'adjustment', 'return') then
    raise exception 'Invalid inventory movement type';
  end if;

  if v_quantity = 0 then
    raise exception 'Movement quantity cannot be zero';
  end if;

  if v_type in ('purchase', 'return') then
    v_delta := abs(v_quantity);
  elsif v_type = 'waste' then
    v_delta := -abs(v_quantity);
    if v_note is null then
      raise exception 'Waste reason is required';
    end if;
  else
    v_delta := v_quantity;
    if v_note is null then
      raise exception 'Adjustment reason is required';
    end if;
  end if;

  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Movement note is too long';
  end if;

  select coalesce(sum(m.quantity_delta), 0)
  into v_stock
  from public.inventory_movements m
  where m.inventory_item_id = v_item.id
    and m.location_id = p_location_id;

  insert into public.inventory_movements (
    restaurant_id, location_id, inventory_item_id, movement_type,
    quantity_delta, unit_cost, reference_type, note, created_by
  ) values (
    p_restaurant_id, p_location_id, v_item.id, v_type,
    v_delta, coalesce(p_unit_cost, v_item.average_cost), 'manual', v_note, v_actor
  )
  returning * into v_movement;

  if v_type in ('purchase', 'return') and p_unit_cost is not null then
    v_new_cost := case
      when v_stock > 0 then
        ((v_stock * v_item.average_cost) + (v_delta * p_unit_cost)) / (v_stock + v_delta)
      else p_unit_cost
    end;

    update public.inventory_items
    set average_cost = round(v_new_cost, 4)
    where id = v_item.id;
  end if;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, entity_type, entity_id, action, details
  ) values (
    p_restaurant_id,
    v_actor,
    'inventory_movement',
    v_movement.id,
    v_type,
    jsonb_build_object(
      'inventoryItemId', v_item.id,
      'quantityDelta', v_delta,
      'unitCost', coalesce(p_unit_cost, v_item.average_cost)
    )
  );

  return jsonb_build_object(
    'id', v_movement.id,
    'quantityDelta', v_delta,
    'stockAfter', v_stock + v_delta
  );
end;
$$;

create or replace function public.record_inventory_movement(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_inventory_item_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_note text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.record_inventory_movement_impl(
    p_restaurant_id, p_location_id, p_inventory_item_id,
    p_movement_type, p_quantity, p_unit_cost, p_note
  );
$$;

create or replace function private.save_product_recipe_impl(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_line_count integer;
  v_cost numeric;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  if not private.user_has_location_permission(p_location_id, 'inventory.manage') then
    raise exception 'Not allowed to manage inventory';
  end if;

  if not exists (
    select 1 from public.locations l
    where l.id = p_location_id
      and l.restaurant_id = p_restaurant_id
      and l.active = true
  ) then
    raise exception 'Location does not belong to this restaurant';
  end if;

  if not exists (
    select 1 from public.products p
    where p.id = p_product_id
      and p.restaurant_id = p_restaurant_id
  ) then
    raise exception 'Product does not belong to this restaurant';
  end if;

  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Recipe lines must be an array';
  end if;

  v_line_count := jsonb_array_length(p_lines);

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line(value)
    left join public.inventory_items i
      on i.id = (line.value->>'inventoryItemId')::uuid
     and i.restaurant_id = p_restaurant_id
    where i.id is null
      or coalesce((line.value->>'quantityRequired')::numeric, 0) <= 0
  ) then
    raise exception 'Recipe contains an invalid ingredient or quantity';
  end if;

  delete from public.product_recipes
  where product_id = p_product_id;

  if v_line_count > 0 then
    insert into public.product_recipes (
      product_id, inventory_item_id, quantity_required
    )
    select
      p_product_id,
      (line.value->>'inventoryItemId')::uuid,
      sum((line.value->>'quantityRequired')::numeric)
    from jsonb_array_elements(p_lines) line(value)
    group by (line.value->>'inventoryItemId')::uuid;
  end if;

  update public.products
  set track_inventory = v_line_count > 0
  where id = p_product_id;

  select coalesce(sum(pr.quantity_required * i.average_cost), 0)
  into v_cost
  from public.product_recipes pr
  join public.inventory_items i on i.id = pr.inventory_item_id
  where pr.product_id = p_product_id;

  insert into public.audit_logs (
    restaurant_id, actor_user_id, entity_type, entity_id, action, details
  ) values (
    p_restaurant_id,
    v_actor,
    'product_recipe',
    p_product_id,
    'replace',
    jsonb_build_object('lineCount', v_line_count, 'estimatedCost', v_cost)
  );

  return jsonb_build_object(
    'productId', p_product_id,
    'lineCount', v_line_count,
    'estimatedCost', round(v_cost, 2)
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Recipe contains invalid values';
end;
$$;

create or replace function public.save_product_recipe(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_lines jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.save_product_recipe_impl(
    p_restaurant_id, p_location_id, p_product_id, p_lines
  );
$$;

create or replace function private.consume_inventory_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_actor uuid := (select auth.uid());
begin
  select * into v_order
  from public.orders o
  where o.id = p_order_id;

  if not found or v_order.payment_status <> 'paid' then
    return;
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
    v_order.restaurant_id,
    v_order.location_id,
    pr.inventory_item_id,
    'sale',
    -sum(pr.quantity_required * oi.quantity),
    i.average_cost,
    'order',
    v_order.id,
    'Venta automática · Orden #' || v_order.order_number,
    coalesce(v_actor, v_order.closed_by, v_order.opened_by)
  from public.order_items oi
  join public.products p
    on p.id = oi.product_id
   and p.restaurant_id = v_order.restaurant_id
   and p.track_inventory = true
  join public.product_recipes pr on pr.product_id = p.id
  join public.inventory_items i
    on i.id = pr.inventory_item_id
   and i.restaurant_id = v_order.restaurant_id
  where oi.order_id = v_order.id
    and oi.status <> 'cancelled'
    and oi.quantity > 0
  group by pr.inventory_item_id, i.average_cost
  having sum(pr.quantity_required * oi.quantity) > 0
  on conflict (
    location_id,
    inventory_item_id,
    reference_type,
    reference_id,
    movement_type
  )
  where movement_type = 'sale'
    and reference_type = 'order'
    and reference_id is not null
  do nothing;
end;
$$;

create or replace function private.consume_inventory_for_paid_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.consume_inventory_for_order(new.id);
  return new;
end;
$$;

drop trigger if exists orders_consume_inventory_when_paid on public.orders;
create trigger orders_consume_inventory_when_paid
after update of payment_status on public.orders
for each row
when (
  new.payment_status = 'paid'
  and old.payment_status is distinct from new.payment_status
)
execute function private.consume_inventory_for_paid_order_trigger();

revoke all on function private.get_inventory_workspace_impl(uuid, uuid) from public, anon;
revoke all on function private.save_inventory_item_impl(uuid, uuid, uuid, text, text, text, numeric, numeric, numeric, boolean, numeric) from public, anon;
revoke all on function private.record_inventory_movement_impl(uuid, uuid, uuid, text, numeric, numeric, text) from public, anon;
revoke all on function private.save_product_recipe_impl(uuid, uuid, uuid, jsonb) from public, anon;
revoke all on function private.consume_inventory_for_order(uuid) from public, anon, authenticated;
revoke all on function private.consume_inventory_for_paid_order_trigger() from public, anon, authenticated;

grant execute on function private.get_inventory_workspace_impl(uuid, uuid) to authenticated, service_role;
grant execute on function private.save_inventory_item_impl(uuid, uuid, uuid, text, text, text, numeric, numeric, numeric, boolean, numeric) to authenticated, service_role;
grant execute on function private.record_inventory_movement_impl(uuid, uuid, uuid, text, numeric, numeric, text) to authenticated, service_role;
grant execute on function private.save_product_recipe_impl(uuid, uuid, uuid, jsonb) to authenticated, service_role;

revoke all on function public.get_inventory_workspace(uuid, uuid) from public, anon;
revoke all on function public.save_inventory_item(uuid, uuid, uuid, text, text, text, numeric, numeric, numeric, boolean, numeric) from public, anon;
revoke all on function public.record_inventory_movement(uuid, uuid, uuid, text, numeric, numeric, text) from public, anon;
revoke all on function public.save_product_recipe(uuid, uuid, uuid, jsonb) from public, anon;

grant execute on function public.get_inventory_workspace(uuid, uuid) to authenticated, service_role;
grant execute on function public.save_inventory_item(uuid, uuid, uuid, text, text, text, numeric, numeric, numeric, boolean, numeric) to authenticated, service_role;
grant execute on function public.record_inventory_movement(uuid, uuid, uuid, text, numeric, numeric, text) to authenticated, service_role;
grant execute on function public.save_product_recipe(uuid, uuid, uuid, jsonb) to authenticated, service_role;
