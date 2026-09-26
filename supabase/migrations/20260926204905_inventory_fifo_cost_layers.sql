
create table if not exists private.inventory_fifo_layers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  source_movement_id uuid unique references public.inventory_movements(id) on delete set null,
  original_quantity numeric not null check (original_quantity > 0),
  remaining_quantity numeric not null check (remaining_quantity >= 0),
  unit_cost numeric not null check (unit_cost >= 0),
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (remaining_quantity <= original_quantity)
);
create index if not exists inventory_fifo_layers_open_idx
on private.inventory_fifo_layers(location_id, inventory_item_id, received_at, id)
where remaining_quantity > 0;

create table if not exists private.inventory_fifo_allocations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  movement_id uuid not null references public.inventory_movements(id) on delete cascade,
  fifo_layer_id uuid references private.inventory_fifo_layers(id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  unit_cost numeric not null check (unit_cost >= 0),
  reversed_quantity numeric not null default 0 check (reversed_quantity >= 0 and reversed_quantity <= quantity),
  created_at timestamptz not null default now()
);
create index if not exists inventory_fifo_allocations_order_item_idx
on private.inventory_fifo_allocations(order_item_id, inventory_item_id, created_at);
create index if not exists inventory_fifo_allocations_movement_idx
on private.inventory_fifo_allocations(movement_id);

-- Existing stock becomes one opening FIFO layer at its current carrying cost.
insert into private.inventory_fifo_layers(
  restaurant_id, location_id, inventory_item_id, original_quantity, remaining_quantity, unit_cost, received_at
)
select i.restaurant_id, m.location_id, i.id, sum(m.quantity_delta), sum(m.quantity_delta),
       i.average_cost, now()
from public.inventory_items i
join public.inventory_movements m on m.inventory_item_id=i.id
group by i.restaurant_id,m.location_id,i.id,i.average_cost
having sum(m.quantity_delta) > 0
and not exists (
  select 1 from private.inventory_fifo_layers l
  where l.location_id=m.location_id and l.inventory_item_id=i.id
);

create or replace function private.create_fifo_layer_for_positive_movement()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.quantity_delta > 0
     and not (new.movement_type='return' and new.reference_type='order_item') then
    insert into private.inventory_fifo_layers(
      restaurant_id,location_id,inventory_item_id,source_movement_id,
      original_quantity,remaining_quantity,unit_cost,received_at
    ) values (
      new.restaurant_id,new.location_id,new.inventory_item_id,new.id,
      new.quantity_delta,new.quantity_delta,coalesce(new.unit_cost,0),new.created_at
    ) on conflict (source_movement_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists inventory_movements_create_fifo_layer on public.inventory_movements;
create trigger inventory_movements_create_fifo_layer
after insert on public.inventory_movements
for each row execute function private.create_fifo_layer_for_positive_movement();

create or replace function private.consume_fifo_for_movement(
  p_movement_id uuid,
  p_quantity numeric,
  p_order_item_id uuid default null
) returns numeric
language plpgsql security definer set search_path='' as $$
declare
  v_m public.inventory_movements%rowtype;
  v_layer private.inventory_fifo_layers%rowtype;
  v_remaining numeric := abs(coalesce(p_quantity,0));
  v_take numeric;
  v_total numeric := 0;
  v_fallback numeric := 0;
begin
  if v_remaining <= 0 then return 0; end if;
  select * into v_m from public.inventory_movements where id=p_movement_id for update;
  if not found then raise exception 'Inventory movement not found'; end if;

  select average_cost into v_fallback from public.inventory_items where id=v_m.inventory_item_id;

  for v_layer in
    select * from private.inventory_fifo_layers
    where location_id=v_m.location_id
      and inventory_item_id=v_m.inventory_item_id
      and remaining_quantity > 0
    order by received_at,id
    for update
  loop
    exit when v_remaining <= 0.0000001;
    v_take := least(v_remaining,v_layer.remaining_quantity);
    update private.inventory_fifo_layers
      set remaining_quantity=remaining_quantity-v_take
      where id=v_layer.id;
    insert into private.inventory_fifo_allocations(
      restaurant_id,location_id,inventory_item_id,order_item_id,movement_id,
      fifo_layer_id,quantity,unit_cost
    ) values (
      v_m.restaurant_id,v_m.location_id,v_m.inventory_item_id,p_order_item_id,p_movement_id,
      v_layer.id,v_take,v_layer.unit_cost
    );
    v_total := v_total + v_take*v_layer.unit_cost;
    v_remaining := v_remaining-v_take;
  end loop;

  if v_remaining > 0.0000001 then
    insert into private.inventory_fifo_allocations(
      restaurant_id,location_id,inventory_item_id,order_item_id,movement_id,
      fifo_layer_id,quantity,unit_cost
    ) values (
      v_m.restaurant_id,v_m.location_id,v_m.inventory_item_id,p_order_item_id,p_movement_id,
      null,v_remaining,coalesce(v_fallback,0)
    );
    v_total := v_total + v_remaining*coalesce(v_fallback,0);
  end if;

  update public.inventory_movements
  set unit_cost=round(v_total/abs(p_quantity),4)
  where id=p_movement_id;

  return round(v_total,4);
end $$;

create or replace function private.consume_inventory_for_order_item(
  p_order_item_id uuid, p_actor uuid default null
) returns void language plpgsql security definer set search_path='' as $$
declare
  v_line record;
  v_enforce boolean;
  v_shortage record;
  v_recipe record;
  v_movement_id uuid;
begin
  select oi.id,oi.product_id,oi.product_name,oi.quantity,o.id order_id,o.order_number,
         o.restaurant_id,o.location_id,o.opened_by,p.track_inventory
  into v_line
  from public.order_items oi join public.orders o on o.id=oi.order_id
  left join public.products p on p.id=oi.product_id
  where oi.id=p_order_item_id;

  if not found or v_line.product_id is null or coalesce(v_line.track_inventory,false)=false then return; end if;
  if not exists(select 1 from public.product_recipes pr where pr.product_id=v_line.product_id) then return; end if;

  perform 1 from public.inventory_items i
  join public.product_recipes pr on pr.inventory_item_id=i.id
  where pr.product_id=v_line.product_id and i.restaurant_id=v_line.restaurant_id
  order by i.id for update of i;

  select coalesce(s.block_insufficient_inventory,true) into v_enforce
  from public.restaurant_settings s where s.restaurant_id=v_line.restaurant_id;
  v_enforce:=coalesce(v_enforce,true);

  if v_enforce then
    select i.name,i.unit,pr.quantity_required*v_line.quantity required_quantity,
      coalesce((select sum(m.quantity_delta) from public.inventory_movements m
        where m.inventory_item_id=i.id and m.location_id=v_line.location_id),0) available_quantity
    into v_shortage
    from public.product_recipes pr join public.inventory_items i on i.id=pr.inventory_item_id
    where pr.product_id=v_line.product_id
      and coalesce((select sum(m.quantity_delta) from public.inventory_movements m
        where m.inventory_item_id=i.id and m.location_id=v_line.location_id),0)+0.000001
        < pr.quantity_required*v_line.quantity
    order by i.name limit 1;
    if found then
      raise exception 'No se puede preparar "%": inventario insuficiente de %. Disponible: % %; requerido: % %.',
        v_line.product_name,v_shortage.name,round(v_shortage.available_quantity,3),v_shortage.unit,
        round(v_shortage.required_quantity,3),v_shortage.unit;
    end if;
  end if;

  for v_recipe in
    select pr.inventory_item_id,pr.quantity_required*v_line.quantity qty,i.average_cost
    from public.product_recipes pr join public.inventory_items i on i.id=pr.inventory_item_id
    where pr.product_id=v_line.product_id and pr.quantity_required*v_line.quantity>0
    order by pr.inventory_item_id
  loop
    insert into public.inventory_movements(
      restaurant_id,location_id,inventory_item_id,movement_type,quantity_delta,unit_cost,
      reference_type,reference_id,note,created_by
    ) values (
      v_line.restaurant_id,v_line.location_id,v_recipe.inventory_item_id,'sale',-v_recipe.qty,
      v_recipe.average_cost,'order_item',v_line.id,
      'Preparación automática · Orden #'||v_line.order_number||' · '||v_line.product_name,
      coalesce(p_actor,(select auth.uid()),v_line.opened_by)
    )
    on conflict (location_id,inventory_item_id,reference_type,reference_id,movement_type)
    where movement_type='sale' and reference_type='order_item' and reference_id is not null
    do nothing returning id into v_movement_id;

    if v_movement_id is not null then
      perform private.consume_fifo_for_movement(v_movement_id,v_recipe.qty,v_line.id);
    end if;
    v_movement_id:=null;
  end loop;
end $$;

create or replace function private.restore_inventory_for_order_item(
  p_order_item_id uuid, p_actor uuid default null
) returns void language plpgsql security definer set search_path='' as $$
declare
  v_line record;
  v_consumed public.inventory_movements%rowtype;
  v_alloc private.inventory_fifo_allocations%rowtype;
  v_return_id uuid;
begin
  select oi.id,oi.product_name,o.order_number,o.opened_by
  into v_line from public.order_items oi join public.orders o on o.id=oi.order_id
  where oi.id=p_order_item_id;
  if not found then return; end if;

  for v_consumed in
    select * from public.inventory_movements
    where reference_type='order_item' and reference_id=p_order_item_id
      and movement_type='sale' and quantity_delta<0
    order by inventory_item_id
  loop
    perform 1 from public.inventory_items where id=v_consumed.inventory_item_id for update;

    insert into public.inventory_movements(
      restaurant_id,location_id,inventory_item_id,movement_type,quantity_delta,unit_cost,
      reference_type,reference_id,note,created_by
    ) values (
      v_consumed.restaurant_id,v_consumed.location_id,v_consumed.inventory_item_id,'return',
      -v_consumed.quantity_delta,v_consumed.unit_cost,'order_item',p_order_item_id,
      'Reposición por anulación · Orden #'||v_line.order_number||' · '||v_line.product_name,
      coalesce(p_actor,(select auth.uid()),v_line.opened_by)
    )
    on conflict (location_id,inventory_item_id,reference_type,reference_id,movement_type)
    where movement_type='return' and reference_type='order_item' and reference_id is not null
    do nothing returning id into v_return_id;

    if v_return_id is not null then
      for v_alloc in
        select * from private.inventory_fifo_allocations
        where movement_id=v_consumed.id and reversed_quantity<quantity
        order by created_at,id for update
      loop
        if v_alloc.fifo_layer_id is not null then
          update private.inventory_fifo_layers
          set remaining_quantity=remaining_quantity+(v_alloc.quantity-v_alloc.reversed_quantity)
          where id=v_alloc.fifo_layer_id;
        else
          insert into private.inventory_fifo_layers(
            restaurant_id,location_id,inventory_item_id,source_movement_id,
            original_quantity,remaining_quantity,unit_cost,received_at
          ) values (
            v_alloc.restaurant_id,v_alloc.location_id,v_alloc.inventory_item_id,v_return_id,
            v_alloc.quantity-v_alloc.reversed_quantity,v_alloc.quantity-v_alloc.reversed_quantity,
            v_alloc.unit_cost,now()
          ) on conflict(source_movement_id) do nothing;
        end if;
        update private.inventory_fifo_allocations
        set reversed_quantity=quantity where id=v_alloc.id;
      end loop;
    end if;
    v_return_id:=null;
  end loop;
end $$;

create or replace function private.record_inventory_movement_impl(
  p_restaurant_id uuid,p_location_id uuid,p_inventory_item_id uuid,p_movement_type text,
  p_quantity numeric,p_unit_cost numeric,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_item public.inventory_items%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_type text:=lower(btrim(coalesce(p_movement_type,'')));
  v_quantity numeric:=coalesce(p_quantity,0);
  v_delta numeric; v_stock numeric; v_new_cost numeric;
  v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not private.user_has_location_permission(p_location_id,'inventory.manage') then raise exception 'Not allowed to manage inventory'; end if;
  if not exists(select 1 from public.locations l where l.id=p_location_id and l.restaurant_id=p_restaurant_id and l.active=true) then raise exception 'Location does not belong to this restaurant'; end if;
  select * into v_item from public.inventory_items i where i.id=p_inventory_item_id and i.restaurant_id=p_restaurant_id for update;
  if not found then raise exception 'Inventory item not found'; end if;
  if v_type not in ('purchase','waste','adjustment','return') then raise exception 'Invalid inventory movement type'; end if;
  if v_quantity=0 then raise exception 'Movement quantity cannot be zero'; end if;
  if v_type in ('purchase','return') then v_delta:=abs(v_quantity);
  elsif v_type='waste' then v_delta:=-abs(v_quantity); if v_note is null then raise exception 'Waste reason is required'; end if;
  else v_delta:=v_quantity; if v_note is null then raise exception 'Adjustment reason is required'; end if;
  end if;
  if p_unit_cost is not null and p_unit_cost<0 then raise exception 'Unit cost cannot be negative'; end if;
  if v_note is not null and char_length(v_note)>500 then raise exception 'Movement note is too long'; end if;

  select coalesce(sum(m.quantity_delta),0) into v_stock from public.inventory_movements m
  where m.inventory_item_id=v_item.id and m.location_id=p_location_id;

  insert into public.inventory_movements(
    restaurant_id,location_id,inventory_item_id,movement_type,quantity_delta,unit_cost,reference_type,note,created_by
  ) values (
    p_restaurant_id,p_location_id,v_item.id,v_type,v_delta,coalesce(p_unit_cost,v_item.average_cost),'manual',v_note,v_actor
  ) returning * into v_movement;

  if v_delta<0 then
    perform private.consume_fifo_for_movement(v_movement.id,abs(v_delta),null);
  end if;

  if v_type in ('purchase','return') and p_unit_cost is not null then
    v_new_cost:=case when v_stock>0 then ((v_stock*v_item.average_cost)+(v_delta*p_unit_cost))/(v_stock+v_delta) else p_unit_cost end;
    update public.inventory_items set average_cost=round(v_new_cost,4) where id=v_item.id;
  end if;

  insert into public.audit_logs(restaurant_id,actor_user_id,entity_type,entity_id,action,details)
  values(p_restaurant_id,v_actor,'inventory_movement',v_movement.id,v_type,
    jsonb_build_object('inventoryItemId',v_item.id,'quantityDelta',v_delta,'unitCost',
      (select unit_cost from public.inventory_movements where id=v_movement.id)));

  return jsonb_build_object('id',v_movement.id,'quantityDelta',v_delta,'stockAfter',v_stock+v_delta);
end $$;
