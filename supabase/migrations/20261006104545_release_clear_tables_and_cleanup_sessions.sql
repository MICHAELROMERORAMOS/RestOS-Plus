create or replace function private.release_order_tables(
  p_order_id uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_table_ids uuid[];
begin
  select coalesce(array_agg(otl.table_id),'{}'::uuid[])
  into v_table_ids
  from public.order_table_links otl
  where otl.order_id=p_order_id
    and otl.unlinked_at is null;

  if cardinality(v_table_ids)>0 then
    delete from public.table_order_sessions tos
    where tos.table_id=any(v_table_ids);
  end if;

  update public.order_table_links
  set unlinked_at=coalesce(unlinked_at,now())
  where order_id=p_order_id
    and unlinked_at is null;
end;
$function$;

revoke all on function private.release_order_tables(uuid)
from public,anon,authenticated;

create or replace function private.release_table_if_clear(
  p_table_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_table public.dining_tables%rowtype;
  v_restaurant_id uuid;
  v_order_id uuid;
  v_order public.orders%rowtype;
  v_active_items integer;
  v_pending_service boolean;
  v_balance numeric(14,2);
  v_can_manage boolean := false;
  v_claimed_by_me boolean := false;
  v_owns_active_order boolean := false;
  v_released_orders integer := 0;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  select t.*
  into v_table
  from public.dining_tables t
  join public.locations l on l.id=t.location_id
  where t.id=p_table_id
    and t.active=true
    and l.active=true
  for update of t;

  if not found then
    raise exception 'Mesa inválida o inactiva';
  end if;

  select l.restaurant_id
  into v_restaurant_id
  from public.locations l
  where l.id=v_table.location_id;

  v_can_manage := private.user_has_location_permission(v_table.location_id,'tables.manage');

  select exists(
    select 1
    from public.table_order_sessions tos
    where tos.table_id=p_table_id
      and tos.claimed_by=v_user
  ) into v_claimed_by_me;

  select exists(
    select 1
    from public.order_table_links otl
    join public.orders o on o.id=otl.order_id
    where otl.table_id=p_table_id
      and otl.unlinked_at is null
      and o.status in ('draft','open','awaiting_payment')
      and o.opened_by=v_user
  ) into v_owns_active_order;

  if not (v_can_manage or v_claimed_by_me or v_owns_active_order) then
    raise exception 'No tienes permiso para liberar esta mesa';
  end if;

  for v_order_id in
    select distinct o.id
    from public.order_table_links otl
    join public.orders o on o.id=otl.order_id
    where otl.table_id=p_table_id
      and otl.unlinked_at is null
      and o.status in ('draft','open','awaiting_payment')
    order by o.id
  loop
    perform 1
    from public.orders
    where id=v_order_id
    for update;

    perform private.recalculate_order_financials(v_order_id);

    select *
    into v_order
    from public.orders
    where id=v_order_id;

    select
      count(*) filter (where oi.status<>'cancelled'),
      exists(
        select 1
        from public.order_items pending
        where pending.order_id=v_order_id
          and pending.status not in ('served','cancelled')
      )
    into v_active_items,v_pending_service
    from public.order_items oi
    where oi.order_id=v_order_id;

    v_balance := greatest(coalesce(v_order.total,0)-coalesce(v_order.paid_total,0),0);

    if v_pending_service then
      return jsonb_build_object(
        'ok',false,
        'code','PREPARATION_PENDING',
        'message','La mesa todavía tiene productos pendientes de preparación o entrega.'
      );
    end if;

    if v_balance>0.005 then
      return jsonb_build_object(
        'ok',false,
        'code','PAYMENT_PENDING',
        'message','La mesa todavía tiene un saldo pendiente por cobrar.',
        'balance',v_balance
      );
    end if;

    if v_active_items=0
       and coalesce(v_order.paid_total,0)>0.005
       and coalesce(v_order.refund_due,0)<=0.005 then
      return jsonb_build_object(
        'ok',false,
        'code','FINANCIAL_REVIEW',
        'message','La orden no tiene productos activos, pero registra pagos sin un reembolso pendiente asociado. Revisa la cuenta antes de liberar la mesa.'
      );
    end if;

    if v_active_items=0 then
      update public.orders
      set status='cancelled',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user,opened_by)
      where id=v_order_id;
    else
      update public.orders
      set status='closed',
          closed_at=coalesce(closed_at,now()),
          closed_by=coalesce(closed_by,v_user,opened_by)
      where id=v_order_id;
    end if;

    perform private.release_order_tables(v_order_id);
    v_released_orders := v_released_orders+1;
  end loop;

  update public.order_table_links otl
  set unlinked_at=coalesce(otl.unlinked_at,now())
  from public.orders o
  where otl.table_id=p_table_id
    and otl.order_id=o.id
    and otl.unlinked_at is null
    and o.status in ('closed','cancelled','merged');

  delete from public.table_order_sessions
  where table_id=p_table_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_restaurant_id,
    v_user,
    'dining_table',
    p_table_id,
    'table.release_if_clear',
    jsonb_build_object(
      'locationId',v_table.location_id,
      'tableName',v_table.name,
      'releasedOrders',v_released_orders
    )
  );

  return jsonb_build_object(
    'ok',true,
    'tableId',p_table_id,
    'releasedOrders',v_released_orders
  );
end;
$function$;

create or replace function public.release_table_if_clear(
  p_table_id uuid
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.release_table_if_clear(p_table_id);
$function$;

revoke all on function private.release_table_if_clear(uuid)
from public,anon,authenticated;
grant execute on function private.release_table_if_clear(uuid)
to authenticated;

revoke all on function public.release_table_if_clear(uuid)
from public,anon;
grant execute on function public.release_table_if_clear(uuid)
to authenticated;

create or replace function private.release_terminal_table_order()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.service_mode='table'
     and new.status in ('closed','cancelled','merged')
     and old.status is distinct from new.status then
    perform private.release_order_tables(new.id);
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_release_terminal_table_order
on public.orders;

create trigger trg_release_terminal_table_order
after update of status
on public.orders
for each row
execute function private.release_terminal_table_order();

delete from public.table_order_sessions tos
where tos.last_seen_at < now()-interval '5 minutes'
  and not exists (
    select 1
    from public.order_table_links otl
    join public.orders o on o.id=otl.order_id
    where otl.table_id=tos.table_id
      and otl.unlinked_at is null
      and o.status in ('draft','open','awaiting_payment')
  );
