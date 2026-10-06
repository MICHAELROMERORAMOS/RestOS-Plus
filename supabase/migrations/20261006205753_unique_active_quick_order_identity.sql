create or replace function private.normalize_quick_pager(p_value text)
returns text
language sql
immutable
strict
set search_path=''
as $function$
  select case
    when btrim(p_value) ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(btrim(p_value),'0'),''),'0')
    else lower(btrim(p_value))
  end;
$function$;

create or replace function private.normalize_quick_customer(p_value text)
returns text
language sql
immutable
strict
set search_path=''
as $function$
  select lower(regexp_replace(btrim(p_value),'\s+',' ','g'));
$function$;

create or replace function private.enforce_active_quick_identity_unique()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_pager text;
  v_customer text;
begin
  if new.service_mode <> 'counter'
     or new.status in ('closed','cancelled','merged') then
    return new;
  end if;

  if nullif(btrim(coalesce(new.pager_number,'')),'') is not null then
    v_pager := private.normalize_quick_pager(new.pager_number);

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('quick-pager|' || new.location_id::text || '|' || v_pager,0)
    );

    if exists (
      select 1
      from public.orders o
      where o.location_id=new.location_id
        and o.service_mode='counter'
        and o.status not in ('closed','cancelled','merged')
        and o.id<>new.id
        and nullif(btrim(coalesce(o.pager_number,'')),'') is not null
        and private.normalize_quick_pager(o.pager_number)=v_pager
    ) then
      raise exception 'Ya existe un pedido rápido activo con este PAGER/TURNO. Cierra el pedido anterior antes de reutilizar este número.';
    end if;
  end if;

  if nullif(btrim(coalesce(new.customer_name,'')),'') is not null then
    v_customer := private.normalize_quick_customer(new.customer_name);

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('quick-name|' || new.location_id::text || '|' || v_customer,0)
    );

    if exists (
      select 1
      from public.orders o
      where o.location_id=new.location_id
        and o.service_mode='counter'
        and o.status not in ('closed','cancelled','merged')
        and o.id<>new.id
        and nullif(btrim(coalesce(o.customer_name,'')),'') is not null
        and private.normalize_quick_customer(o.customer_name)=v_customer
    ) then
      raise exception 'Ya existe un pedido rápido activo con este nombre. Cierra el pedido anterior antes de reutilizarlo.';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists orders_enforce_active_quick_identity_unique on public.orders;

create trigger orders_enforce_active_quick_identity_unique
before insert or update of pager_number,customer_name,status,service_mode,location_id
on public.orders
for each row
execute function private.enforce_active_quick_identity_unique();

drop index if exists public.orders_active_quick_pager_unique;
create unique index orders_active_quick_pager_unique
on public.orders(
  location_id,
  (
    case
      when btrim(pager_number) ~ '^[0-9]+$'
        then coalesce(nullif(ltrim(btrim(pager_number),'0'),''),'0')
      else lower(btrim(pager_number))
    end
  )
)
where service_mode='counter'
  and status not in ('closed','cancelled','merged')
  and nullif(btrim(pager_number),'') is not null;

drop index if exists public.orders_active_quick_customer_unique;
create unique index orders_active_quick_customer_unique
on public.orders(
  location_id,
  lower(regexp_replace(btrim(customer_name),'\s+',' ','g'))
)
where service_mode='counter'
  and status not in ('closed','cancelled','merged')
  and nullif(btrim(customer_name),'') is not null;

create or replace function private.update_quick_order_identity(
  p_order_id uuid,
  p_pager_number text,
  p_customer_name text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_pager text := nullif(btrim(coalesce(p_pager_number, '')), '');
  v_customer text := nullif(regexp_replace(btrim(coalesce(p_customer_name, '')), '\s+', ' ', 'g'), '');
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if v_pager is not null and v_customer is not null then
    raise exception 'Usa PAGER o nombre del cliente, no ambos.';
  end if;

  select *
  into v_order
  from public.orders
  where id = p_order_id
    and service_mode = 'counter'
    and status in ('draft', 'open', 'awaiting_payment')
  for update;

  if not found then
    raise exception 'Quick order not found';
  end if;

  if v_order.opened_by <> v_user
     and not private.user_has_location_permission(v_order.location_id, 'orders.update') then
    raise exception 'Not allowed to update this order';
  end if;

  update public.orders
  set pager_number = v_pager,
      customer_name = v_customer
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'pager_number', v_order.pager_number,
    'customer_name', v_order.customer_name
  );
end;
$function$;
