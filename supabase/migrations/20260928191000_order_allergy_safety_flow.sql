-- Order-level allergy declarations, safety snapshots, audit trail and KDS context.

create table if not exists public.order_allergies (
  order_id uuid not null references public.orders(id) on delete cascade,
  allergen_id uuid not null references public.allergen_groups(id) on delete restrict,
  declared_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(order_id, allergen_id)
);

create table if not exists public.order_allergy_subtypes (
  order_id uuid not null references public.orders(id) on delete cascade,
  allergen_id uuid not null references public.allergen_groups(id) on delete restrict,
  subtype_id uuid not null references public.allergen_subtypes(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(order_id, allergen_id, subtype_id),
  foreign key(order_id, allergen_id)
    references public.order_allergies(order_id, allergen_id)
    on delete cascade
);

create table if not exists public.order_allergy_audit (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  changed_by uuid,
  source text not null default 'order_entry',
  previous_allergies jsonb not null default '[]'::jsonb,
  next_allergies jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_allergies_allergen_order_idx
  on public.order_allergies(allergen_id, order_id);

create index if not exists order_allergy_audit_order_created_idx
  on public.order_allergy_audit(order_id, created_at desc);

alter table public.order_items
  add column if not exists allergy_context jsonb not null default '{}'::jsonb;

alter table public.order_allergies enable row level security;
alter table public.order_allergy_subtypes enable row level security;
alter table public.order_allergy_audit enable row level security;

revoke all on table public.order_allergies from anon, authenticated;
revoke all on table public.order_allergy_subtypes from anon, authenticated;
revoke all on table public.order_allergy_audit from anon, authenticated;

create or replace function private.render_order_allergies(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'allergenId', ag.id,
        'code', ag.code,
        'nameEs', ag.name_es,
        'nameEn', ag.name_en,
        'icon', ag.icon,
        'subtypeIds', coalesce((
          select jsonb_agg(oas.subtype_id order by st.display_order, st.name_es)
          from public.order_allergy_subtypes oas
          join public.allergen_subtypes st on st.id=oas.subtype_id
          where oas.order_id=oa.order_id
            and oas.allergen_id=oa.allergen_id
        ), '[]'::jsonb),
        'subtypes', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', st.id,
              'code', st.code,
              'nameEs', st.name_es,
              'nameEn', st.name_en
            )
            order by st.display_order, st.name_es
          )
          from public.order_allergy_subtypes oas
          join public.allergen_subtypes st on st.id=oas.subtype_id
          where oas.order_id=oa.order_id
            and oas.allergen_id=oa.allergen_id
        ), '[]'::jsonb)
      )
      order by ag.display_order, ag.name_es
    ),
    '[]'::jsonb
  )
  from public.order_allergies oa
  join public.allergen_groups ag on ag.id=oa.allergen_id
  where oa.order_id=p_order_id
    and ag.active=true;
$function$;

create or replace function private.build_item_allergy_context(
  p_order_id uuid,
  p_product_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with declared as (
    select
      oa.allergen_id,
      ag.code,
      ag.name_es,
      ag.name_en,
      ag.icon,
      ag.display_order,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', st.id,
            'code', st.code,
            'nameEs', st.name_es,
            'nameEn', st.name_en
          )
          order by st.display_order, st.name_es
        )
        from public.order_allergy_subtypes oas
        join public.allergen_subtypes st on st.id=oas.subtype_id
        where oas.order_id=oa.order_id
          and oas.allergen_id=oa.allergen_id
      ), '[]'::jsonb) as subtypes
    from public.order_allergies oa
    join public.allergen_groups ag on ag.id=oa.allergen_id
    where oa.order_id=p_order_id
      and ag.active=true
  ),
  conflicts as (
    select
      d.allergen_id,
      d.code,
      d.name_es,
      d.name_en,
      d.icon,
      d.display_order,
      pa.exposure_level
    from declared d
    join public.product_allergens pa
      on pa.product_id=p_product_id
     and pa.allergen_id=d.allergen_id
  )
  select jsonb_build_object(
    'declared',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'allergenId', d.allergen_id,
          'code', d.code,
          'nameEs', d.name_es,
          'nameEn', d.name_en,
          'icon', d.icon,
          'subtypes', d.subtypes
        )
        order by d.display_order, d.name_es
      )
      from declared d
    ), '[]'::jsonb),
    'conflicts',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'allergenId', c.allergen_id,
          'code', c.code,
          'nameEs', c.name_es,
          'nameEn', c.name_en,
          'icon', c.icon,
          'productLevel', c.exposure_level
        )
        order by
          case when c.exposure_level='contains' then 0 else 1 end,
          c.display_order,
          c.name_es
      )
      from conflicts c
    ), '[]'::jsonb),
    'hasConflict', exists(select 1 from conflicts),
    'generatedAt', now()
  );
$function$;

create or replace function private.replace_order_allergies(
  p_order_id uuid,
  p_allergies jsonb,
  p_actor uuid,
  p_source text default 'order_entry'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_previous jsonb;
  v_next jsonb;
  v_entry jsonb;
  v_allergen_id uuid;
  v_subtype_text text;
  v_subtype_id uuid;
begin
  select * into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;
  if v_order.status not in ('draft','open','awaiting_payment') then
    raise exception 'Order is not open';
  end if;

  if p_allergies is null then p_allergies := '[]'::jsonb; end if;
  if jsonb_typeof(p_allergies) <> 'array' then
    raise exception 'Invalid allergy declaration';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_allergies) e
    group by e->>'allergenId'
    having count(*) > 1
  ) then
    raise exception 'Duplicate allergy declaration';
  end if;

  v_previous := private.render_order_allergies(p_order_id);

  delete from public.order_allergy_subtypes where order_id=p_order_id;
  delete from public.order_allergies where order_id=p_order_id;

  for v_entry in
    select value from jsonb_array_elements(p_allergies)
  loop
    begin
      v_allergen_id := nullif(v_entry->>'allergenId','')::uuid;
    exception when others then
      raise exception 'Invalid allergen identifier';
    end;

    if not exists (
      select 1
      from public.allergen_groups ag
      where ag.id=v_allergen_id
        and ag.active=true
    ) then
      raise exception 'Allergen not found';
    end if;

    insert into public.order_allergies(
      order_id,allergen_id,declared_by,updated_at
    )
    values(
      p_order_id,v_allergen_id,p_actor,now()
    );

    if v_entry ? 'subtypeIds' then
      if jsonb_typeof(v_entry->'subtypeIds') <> 'array' then
        raise exception 'Invalid allergy subtype declaration';
      end if;

      for v_subtype_text in
        select value from jsonb_array_elements_text(v_entry->'subtypeIds')
      loop
        begin
          v_subtype_id := nullif(v_subtype_text,'')::uuid;
        exception when others then
          raise exception 'Invalid allergy subtype identifier';
        end;

        if not exists (
          select 1
          from public.allergen_subtypes st
          where st.id=v_subtype_id
            and st.allergen_id=v_allergen_id
            and st.active=true
        ) then
          raise exception 'Allergy subtype does not belong to selected allergen';
        end if;

        insert into public.order_allergy_subtypes(
          order_id,allergen_id,subtype_id
        )
        values(
          p_order_id,v_allergen_id,v_subtype_id
        )
        on conflict do nothing;
      end loop;
    end if;
  end loop;

  v_next := private.render_order_allergies(p_order_id);

  if v_previous is distinct from v_next then
    insert into public.order_allergy_audit(
      restaurant_id,order_id,changed_by,source,previous_allergies,next_allergies
    )
    values(
      v_order.restaurant_id,p_order_id,p_actor,
      coalesce(nullif(btrim(coalesce(p_source,'')),''),'order_entry'),
      coalesce(v_previous,'[]'::jsonb),
      coalesce(v_next,'[]'::jsonb)
    );
  end if;

  update public.order_items oi
  set allergy_context=private.build_item_allergy_context(p_order_id,oi.product_id)
  where oi.order_id=p_order_id
    and oi.status<>'cancelled';

  return coalesce(v_next,'[]'::jsonb);
end;
$function$;

create or replace function private.save_order_allergies(
  p_order_id uuid,
  p_allergies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_order public.orders%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_order
  from public.orders
  where id=p_order_id
    and status in ('draft','open','awaiting_payment')
  for update;

  if not found then raise exception 'Order is not open'; end if;

  if not private.user_has_location_permission(v_order.location_id,'orders.create') then
    raise exception 'Not allowed to update order allergies';
  end if;

  return private.replace_order_allergies(
    p_order_id,p_allergies,v_user,'order_entry'
  );
end;
$function$;

create or replace function public.save_order_allergies(
  p_order_id uuid,
  p_allergies jsonb
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.save_order_allergies(p_order_id,p_allergies);
$function$;

revoke all on function public.save_order_allergies(uuid,jsonb) from public, anon;
grant execute on function public.save_order_allergies(uuid,jsonb) to authenticated;
revoke all on function private.save_order_allergies(uuid,jsonb) from public, anon;
grant execute on function private.save_order_allergies(uuid,jsonb) to authenticated;

create or replace function private.send_order_round_with_allergies(
  p_order_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_service_mode text,
  p_payment_timing text,
  p_table_ids uuid[],
  p_customer_id uuid,
  p_customer_name text,
  p_delivery_details jsonb,
  p_pager_number text,
  p_items jsonb,
  p_prepaid boolean,
  p_payment_method text,
  p_allergies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_result jsonb;
  v_order_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  v_result := private.send_order_round(
    p_order_id,p_restaurant_id,p_location_id,p_service_mode,p_payment_timing,
    p_table_ids,p_customer_id,p_customer_name,p_delivery_details,p_pager_number,
    p_items,p_prepaid,p_payment_method
  );

  v_order_id := nullif(v_result->>'order_id','')::uuid;
  if v_order_id is null then raise exception 'Order save did not return an identifier'; end if;

  perform private.replace_order_allergies(
    v_order_id,
    coalesce(p_allergies,'[]'::jsonb),
    v_user,
    'send_round'
  );

  return v_result || jsonb_build_object(
    'allergies',private.render_order_allergies(v_order_id)
  );
end;
$function$;

create or replace function public.send_order_round_with_allergies(
  p_order_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_service_mode text,
  p_payment_timing text,
  p_table_ids uuid[],
  p_customer_id uuid,
  p_customer_name text,
  p_delivery_details jsonb,
  p_pager_number text,
  p_items jsonb,
  p_prepaid boolean,
  p_payment_method text,
  p_allergies jsonb
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.send_order_round_with_allergies(
    p_order_id,p_restaurant_id,p_location_id,p_service_mode,p_payment_timing,
    p_table_ids,p_customer_id,p_customer_name,p_delivery_details,p_pager_number,
    p_items,p_prepaid,p_payment_method,p_allergies
  );
$function$;

revoke all on function public.send_order_round_with_allergies(
  uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text,jsonb
) from public, anon;
grant execute on function public.send_order_round_with_allergies(
  uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text,jsonb
) to authenticated;

revoke all on function private.send_order_round_with_allergies(
  uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text,jsonb
) from public, anon;
grant execute on function private.send_order_round_with_allergies(
  uuid,uuid,uuid,text,text,uuid[],uuid,text,jsonb,text,jsonb,boolean,text,jsonb
) to authenticated;

create or replace function private.load_order_allergy_context(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;

  if not private.can_read_operational_location(p_location_id) then
    raise exception 'Not allowed to view operational data';
  end if;

  if not exists (
    select 1
    from public.locations l
    where l.id=p_location_id
      and l.restaurant_id=p_restaurant_id
      and l.active=true
  ) then
    raise exception 'Invalid restaurant/location';
  end if;

  select coalesce(
    jsonb_object_agg(
      o.id::text,
      jsonb_build_object(
        'allergies',private.render_order_allergies(o.id),
        'items',coalesce((
          select jsonb_object_agg(
            oi.id::text,
            coalesce(oi.allergy_context,'{}'::jsonb)
          )
          from public.order_items oi
          where oi.order_id=o.id
        ),'{}'::jsonb)
      )
    ),
    '{}'::jsonb
  )
  into v_result
  from public.orders o
  where o.restaurant_id=p_restaurant_id
    and o.location_id=p_location_id
    and (
      p_order_ids is null
      or o.id=any(coalesce(p_order_ids,array[]::uuid[]))
    );

  return v_result;
end;
$function$;

create or replace function public.load_order_allergy_context(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_order_ids uuid[] default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select private.load_order_allergy_context(
    p_restaurant_id,p_location_id,p_order_ids
  );
$function$;

revoke all on function public.load_order_allergy_context(uuid,uuid,uuid[]) from public, anon;
grant execute on function public.load_order_allergy_context(uuid,uuid,uuid[]) to authenticated;
revoke all on function private.load_order_allergy_context(uuid,uuid,uuid[]) from public, anon;
grant execute on function private.load_order_allergy_context(uuid,uuid,uuid[]) to authenticated;
