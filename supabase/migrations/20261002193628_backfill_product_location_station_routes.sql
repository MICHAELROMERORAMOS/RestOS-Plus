with preferred_station_type as (
  select distinct on (psr.product_id)
    psr.product_id,
    ks.station_type
  from public.product_station_routes psr
  join public.kitchen_stations ks
    on ks.id = psr.station_id
  where ks.active = true
  order by psr.product_id, psr.location_id
),
missing_routes as (
  select
    pl.product_id,
    pl.location_id,
    coalesce(pref.station_type, 'kitchen') as station_type
  from public.product_locations pl
  join public.products p
    on p.id = pl.product_id
  left join public.product_station_routes psr
    on psr.product_id = pl.product_id
   and psr.location_id = pl.location_id
  left join preferred_station_type pref
    on pref.product_id = pl.product_id
  where p.active = true
    and pl.active = true
    and psr.product_id is null
),
resolved_routes as (
  select
    mr.product_id,
    mr.location_id,
    (
      select ks.id
      from public.kitchen_stations ks
      where ks.location_id = mr.location_id
        and ks.station_type = mr.station_type
        and ks.active = true
      order by ks.display_order, ks.created_at
      limit 1
    ) as station_id
  from missing_routes mr
)
insert into public.product_station_routes(product_id, location_id, station_id)
select product_id, location_id, station_id
from resolved_routes
where station_id is not null
on conflict(product_id, location_id)
do update set station_id = excluded.station_id;
