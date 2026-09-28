-- Product allergen catalogue and configuration.
-- Canonical EU allergen groups are shared globally; product assignments are restaurant-scoped through products.

create table if not exists public.allergen_groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_es text not null,
  name_en text not null,
  icon text,
  display_order smallint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint allergen_groups_code_not_blank check (length(btrim(code)) > 0),
  constraint allergen_groups_name_es_not_blank check (length(btrim(name_es)) > 0),
  constraint allergen_groups_name_en_not_blank check (length(btrim(name_en)) > 0)
);

create table if not exists public.allergen_subtypes (
  id uuid primary key default gen_random_uuid(),
  allergen_id uuid not null references public.allergen_groups(id) on delete cascade,
  code text not null,
  name_es text not null,
  name_en text not null,
  display_order smallint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint allergen_subtypes_code_not_blank check (length(btrim(code)) > 0),
  constraint allergen_subtypes_name_es_not_blank check (length(btrim(name_es)) > 0),
  constraint allergen_subtypes_name_en_not_blank check (length(btrim(name_en)) > 0),
  constraint allergen_subtypes_group_code_unique unique(allergen_id, code)
);

create table if not exists public.product_allergens (
  product_id uuid not null references public.products(id) on delete cascade,
  allergen_id uuid not null references public.allergen_groups(id) on delete restrict,
  exposure_level text not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(product_id, allergen_id),
  constraint product_allergens_exposure_level_check
    check (exposure_level in ('contains', 'may_contain'))
);

create table if not exists public.product_allergen_subtypes (
  product_id uuid not null references public.products(id) on delete cascade,
  subtype_id uuid not null references public.allergen_subtypes(id) on delete restrict,
  exposure_level text not null,
  created_at timestamptz not null default now(),
  primary key(product_id, subtype_id),
  constraint product_allergen_subtypes_exposure_level_check
    check (exposure_level in ('contains', 'may_contain'))
);

create index if not exists product_allergens_allergen_product_idx
  on public.product_allergens(allergen_id, product_id);

create index if not exists product_allergen_subtypes_subtype_product_idx
  on public.product_allergen_subtypes(subtype_id, product_id);

alter table public.allergen_groups enable row level security;
alter table public.allergen_subtypes enable row level security;
alter table public.product_allergens enable row level security;
alter table public.product_allergen_subtypes enable row level security;

revoke all on table public.allergen_groups from anon, authenticated;
revoke all on table public.allergen_subtypes from anon, authenticated;
revoke all on table public.product_allergens from anon, authenticated;
revoke all on table public.product_allergen_subtypes from anon, authenticated;

insert into public.allergen_groups(code,name_es,name_en,icon,display_order,active)
values
  ('cereals_gluten','Cereales con gluten','Cereals containing gluten','🌾',1,true),
  ('crustaceans','Crustáceos','Crustaceans','🦐',2,true),
  ('eggs','Huevo','Eggs','🥚',3,true),
  ('fish','Pescado','Fish','🐟',4,true),
  ('peanuts','Maní / cacahuete','Peanuts','🥜',5,true),
  ('soybeans','Soja','Soybeans','🫘',6,true),
  ('milk','Leche','Milk','🥛',7,true),
  ('tree_nuts','Frutos secos','Tree nuts','🌰',8,true),
  ('celery','Apio','Celery','🥬',9,true),
  ('mustard','Mostaza','Mustard','🟡',10,true),
  ('sesame','Sésamo','Sesame','⚪',11,true),
  ('sulphites','Sulfitos / dióxido de azufre','Sulphites / sulphur dioxide','🍷',12,true),
  ('lupin','Altramuz / lupin','Lupin','🌼',13,true),
  ('molluscs','Moluscos','Molluscs','🐚',14,true)
on conflict(code) do update
set name_es=excluded.name_es,
    name_en=excluded.name_en,
    icon=excluded.icon,
    display_order=excluded.display_order,
    active=true,
    updated_at=now();

with subtype_seed(group_code,code,name_es,name_en,display_order) as (
  values
    ('cereals_gluten','wheat','Trigo','Wheat',1),
    ('cereals_gluten','rye','Centeno','Rye',2),
    ('cereals_gluten','barley','Cebada','Barley',3),
    ('cereals_gluten','oats','Avena','Oats',4),
    ('cereals_gluten','spelt','Espelta','Spelt',5),
    ('cereals_gluten','khorasan','Trigo khorasan (kamut)','Khorasan wheat (kamut)',6),
    ('tree_nuts','almond','Almendra','Almond',1),
    ('tree_nuts','hazelnut','Avellana','Hazelnut',2),
    ('tree_nuts','walnut','Nuez','Walnut',3),
    ('tree_nuts','cashew','Anacardo / cashew','Cashew',4),
    ('tree_nuts','pecan','Nuez pecana','Pecan',5),
    ('tree_nuts','brazil_nut','Nuez de Brasil','Brazil nut',6),
    ('tree_nuts','pistachio','Pistacho','Pistachio',7),
    ('tree_nuts','macadamia','Macadamia','Macadamia',8)
)
insert into public.allergen_subtypes(
  allergen_id,code,name_es,name_en,display_order,active
)
select
  ag.id,s.code,s.name_es,s.name_en,s.display_order,true
from subtype_seed s
join public.allergen_groups ag on ag.code=s.group_code
on conflict(allergen_id,code) do update
set name_es=excluded.name_es,
    name_en=excluded.name_en,
    display_order=excluded.display_order,
    active=true,
    updated_at=now();

create or replace function private.load_allergen_configuration(
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_catalog jsonb;
  v_products jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_is_restaurant_member(p_restaurant_id) then
    raise exception 'Not allowed to view allergen configuration';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',ag.id,
        'code',ag.code,
        'nameEs',ag.name_es,
        'nameEn',ag.name_en,
        'icon',ag.icon,
        'displayOrder',ag.display_order,
        'subtypes',coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id',st.id,
              'code',st.code,
              'nameEs',st.name_es,
              'nameEn',st.name_en,
              'displayOrder',st.display_order
            )
            order by st.display_order,st.name_es
          )
          from public.allergen_subtypes st
          where st.allergen_id=ag.id and st.active=true
        ),'[]'::jsonb)
      )
      order by ag.display_order,ag.name_es
    ),
    '[]'::jsonb
  )
  into v_catalog
  from public.allergen_groups ag
  where ag.active=true;

  select coalesce(jsonb_object_agg(x.product_id::text,x.entries),'{}'::jsonb)
  into v_products
  from (
    select
      pa.product_id,
      jsonb_agg(
        jsonb_build_object(
          'allergenId',ag.id,
          'code',ag.code,
          'nameEs',ag.name_es,
          'nameEn',ag.name_en,
          'icon',ag.icon,
          'level',pa.exposure_level,
          'subtypes',coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id',st.id,
                'code',st.code,
                'nameEs',st.name_es,
                'nameEn',st.name_en,
                'level',pas.exposure_level
              )
              order by st.display_order,st.name_es
            )
            from public.product_allergen_subtypes pas
            join public.allergen_subtypes st on st.id=pas.subtype_id
            where pas.product_id=pa.product_id
              and st.allergen_id=pa.allergen_id
              and st.active=true
          ),'[]'::jsonb)
        )
        order by ag.display_order,ag.name_es
      ) as entries
    from public.product_allergens pa
    join public.products p on p.id=pa.product_id
    join public.allergen_groups ag on ag.id=pa.allergen_id
    where p.restaurant_id=p_restaurant_id
      and ag.active=true
    group by pa.product_id
  ) x;

  return jsonb_build_object(
    'catalog',coalesce(v_catalog,'[]'::jsonb),
    'productAllergens',coalesce(v_products,'{}'::jsonb)
  );
end;
$function$;

create or replace function public.load_allergen_configuration(
  p_restaurant_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select private.load_allergen_configuration(p_restaurant_id);
$function$;

revoke all on function public.load_allergen_configuration(uuid) from public, anon;
grant execute on function public.load_allergen_configuration(uuid) to authenticated;
revoke all on function private.load_allergen_configuration(uuid) from public, anon;
grant execute on function private.load_allergen_configuration(uuid) to authenticated;

create or replace function private.save_menu_product_configured_with_allergens(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_category_id uuid,
  p_name text,
  p_description text,
  p_base_price numeric,
  p_tax_rate numeric,
  p_sku text,
  p_station_type text,
  p_direct_inventory boolean,
  p_inventory_unit text,
  p_inventory_average_cost numeric,
  p_inventory_min_stock numeric,
  p_inventory_max_stock numeric,
  p_inventory_opening_stock numeric,
  p_active boolean,
  p_allergens jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
  v_product_id uuid;
  v_entry jsonb;
  v_allergen_id uuid;
  v_level text;
  v_subtype_text text;
  v_subtype_id uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;

  if p_allergens is null then
    p_allergens := '[]'::jsonb;
  end if;

  if jsonb_typeof(p_allergens) <> 'array' then
    raise exception 'Invalid allergen configuration';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_allergens) e
    group by e->>'allergenId'
    having count(*) > 1
  ) then
    raise exception 'Duplicate allergen configuration';
  end if;

  v_result := private.save_menu_product_configured(
    p_product_id,p_restaurant_id,p_location_id,p_category_id,p_name,p_description,
    p_base_price,p_tax_rate,p_sku,p_station_type,p_direct_inventory,p_inventory_unit,
    p_inventory_average_cost,p_inventory_min_stock,p_inventory_max_stock,
    p_inventory_opening_stock,p_active
  );

  v_product_id := nullif(v_result->>'productId','')::uuid;
  if v_product_id is null then
    raise exception 'Product save did not return an identifier';
  end if;

  delete from public.product_allergen_subtypes where product_id=v_product_id;
  delete from public.product_allergens where product_id=v_product_id;

  for v_entry in
    select value from jsonb_array_elements(p_allergens)
  loop
    begin
      v_allergen_id := nullif(v_entry->>'allergenId','')::uuid;
    exception when others then
      raise exception 'Invalid allergen identifier';
    end;

    v_level := lower(btrim(coalesce(v_entry->>'level','')));
    if v_level not in ('contains','may_contain') then
      raise exception 'Invalid allergen exposure level';
    end if;

    if not exists (
      select 1 from public.allergen_groups ag
      where ag.id=v_allergen_id and ag.active=true
    ) then
      raise exception 'Allergen not found';
    end if;

    insert into public.product_allergens(
      product_id,allergen_id,exposure_level,updated_by,updated_at
    )
    values(v_product_id,v_allergen_id,v_level,v_actor,now());

    if v_entry ? 'subtypeIds' then
      if jsonb_typeof(v_entry->'subtypeIds') <> 'array' then
        raise exception 'Invalid allergen subtype configuration';
      end if;

      for v_subtype_text in
        select value from jsonb_array_elements_text(v_entry->'subtypeIds')
      loop
        begin
          v_subtype_id := nullif(v_subtype_text,'')::uuid;
        exception when others then
          raise exception 'Invalid allergen subtype identifier';
        end;

        if not exists (
          select 1
          from public.allergen_subtypes st
          where st.id=v_subtype_id
            and st.allergen_id=v_allergen_id
            and st.active=true
        ) then
          raise exception 'Allergen subtype does not belong to selected allergen';
        end if;

        insert into public.product_allergen_subtypes(
          product_id,subtype_id,exposure_level
        )
        values(v_product_id,v_subtype_id,v_level)
        on conflict(product_id,subtype_id)
        do update set exposure_level=excluded.exposure_level;
      end loop;
    end if;
  end loop;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_actor,'product',v_product_id,'allergens_update',
    jsonb_build_object('allergens',p_allergens)
  );

  return v_result || jsonb_build_object(
    'allergenCount',jsonb_array_length(p_allergens)
  );
end;
$function$;

create or replace function public.save_menu_product_configured_with_allergens(
  p_product_id uuid,
  p_restaurant_id uuid,
  p_location_id uuid,
  p_category_id uuid,
  p_name text,
  p_description text,
  p_base_price numeric,
  p_tax_rate numeric,
  p_sku text,
  p_station_type text,
  p_direct_inventory boolean,
  p_inventory_unit text,
  p_inventory_average_cost numeric,
  p_inventory_min_stock numeric,
  p_inventory_max_stock numeric,
  p_inventory_opening_stock numeric,
  p_active boolean,
  p_allergens jsonb
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.save_menu_product_configured_with_allergens(
    p_product_id,p_restaurant_id,p_location_id,p_category_id,p_name,p_description,
    p_base_price,p_tax_rate,p_sku,p_station_type,p_direct_inventory,p_inventory_unit,
    p_inventory_average_cost,p_inventory_min_stock,p_inventory_max_stock,
    p_inventory_opening_stock,p_active,p_allergens
  );
$function$;

revoke all on function public.save_menu_product_configured_with_allergens(
  uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean,jsonb
) from public, anon;
grant execute on function public.save_menu_product_configured_with_allergens(
  uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean,jsonb
) to authenticated;

revoke all on function private.save_menu_product_configured_with_allergens(
  uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean,jsonb
) from public, anon;
grant execute on function private.save_menu_product_configured_with_allergens(
  uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,boolean,text,numeric,numeric,numeric,numeric,boolean,jsonb
) to authenticated;
