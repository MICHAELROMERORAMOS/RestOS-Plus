create or replace function private.apply_order_item_inventory()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_paid boolean:=false;
begin
  if tg_op='INSERT' then
    if new.status in ('sent','preparing','ready') then
      perform private.consume_inventory_for_order_item(new.id,new.created_by);
    end if;
    return new;
  end if;
  if old.status='draft' and new.status in ('sent','preparing','ready') then
    perform private.consume_inventory_for_order_item(new.id,new.created_by);
  elsif new.status='cancelled' and old.status in ('sent','preparing','ready') then
    select (o.payment_status='paid') into v_paid from public.orders o where o.id=new.order_id;
    if not coalesce(v_paid,false) then
      perform private.restore_inventory_for_order_item(new.id,new.cancelled_by);
    end if;
  end if;
  return new;
end $$;