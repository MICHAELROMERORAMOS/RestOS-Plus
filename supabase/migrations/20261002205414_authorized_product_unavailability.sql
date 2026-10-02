create table if not exists public.product_unavailability_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  duration_minutes integer not null,
  status text not null default 'pending'
    check (status in ('pending','approved','cancelled','expired')),
  code_hash text not null,
  authorization_expires_at timestamptz not null,
  unavailable_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint product_unavailability_duration_check
    check (duration_minutes between 15 and 1440),
  constraint product_unavailability_reason_check
    check (char_length(btrim(reason)) between 5 and 500)
);

create index if not exists product_unavailability_active_idx
  on public.product_unavailability_requests(location_id,product_id,unavailable_until)
  where status='approved';

create index if not exists product_unavailability_pending_idx
  on public.product_unavailability_requests(restaurant_id,requested_by,created_at desc)
  where status='pending';

alter table public.product_unavailability_requests enable row level security;

revoke all on table public.product_unavailability_requests from anon, authenticated;
grant select on table public.product_unavailability_requests to authenticated;
grant select,insert,update,delete on table public.product_unavailability_requests to service_role;

drop policy if exists product_unavailability_select_authorized
  on public.product_unavailability_requests;
create policy product_unavailability_select_authorized
on public.product_unavailability_requests
for select
to authenticated
using (
  (select private.user_has_location_permission(location_id,'products.view'))
  or requested_by=(select auth.uid())
  or (select private.user_has_restaurant_permission(restaurant_id,'products.availability.approve'))
);

create or replace function public.create_product_unavailability_authorization_internal(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_requested_by uuid,
  p_reason text,
  p_duration_minutes integer,
  p_code text
)
returns table(
  request_id uuid,
  authorization_expires_at timestamptz,
  product_name text,
  location_name text,
  duration_minutes integer
)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_request_id uuid;
  v_auth_expires timestamptz := now()+interval '10 minutes';
  v_product_name text;
  v_location_name text;
  v_reason text := btrim(coalesce(p_reason,''));
begin
  if p_code !~ '^[0-9]{6}$' then
    raise exception 'Invalid authorization code';
  end if;
  if char_length(v_reason)<5 or char_length(v_reason)>500 then
    raise exception 'El motivo debe tener entre 5 y 500 caracteres';
  end if;
  if p_duration_minutes<15 or p_duration_minutes>1440 then
    raise exception 'La duración debe estar entre 15 minutos y 24 horas';
  end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    where m.restaurant_id=p_restaurant_id
      and m.user_id=p_requested_by
      and m.status='active'
      and rp.permission_code='products.availability.request'
      and (
        m.all_locations
        or exists (
          select 1
          from public.membership_locations ml
          where ml.membership_id=m.id
            and ml.location_id=p_location_id
        )
      )
  ) then
    raise exception 'Not authorized to request product unavailability for this branch';
  end if;

  select p.name,l.name
  into v_product_name,v_location_name
  from public.products p
  join public.product_locations pl
    on pl.product_id=p.id
   and pl.restaurant_id=p.restaurant_id
  join public.locations l
    on l.id=pl.location_id
   and l.restaurant_id=p.restaurant_id
  where p.id=p_product_id
    and p.restaurant_id=p_restaurant_id
    and p.active=true
    and l.id=p_location_id
    and l.active=true
    and pl.active=true;

  if not found then
    raise exception 'El producto no está activo en esta sucursal';
  end if;

  if exists (
    select 1
    from public.product_unavailability_requests pur
    where pur.restaurant_id=p_restaurant_id
      and pur.location_id=p_location_id
      and pur.product_id=p_product_id
      and pur.status='approved'
      and pur.unavailable_until>now()
  ) then
    raise exception 'El producto ya tiene una indisponibilidad temporal activa';
  end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    join public.profiles p on p.id=m.user_id
    where m.restaurant_id=p_restaurant_id
      and m.status='active'
      and rp.permission_code='products.availability.approve'
      and p.email is not null
  ) then
    raise exception 'No hay un aprobador corporativo activo con correo configurado';
  end if;

  update public.product_unavailability_requests pur
  set status='cancelled'
  where pur.restaurant_id=p_restaurant_id
    and pur.location_id=p_location_id
    and pur.product_id=p_product_id
    and pur.requested_by=p_requested_by
    and pur.status='pending';

  insert into public.product_unavailability_requests(
    restaurant_id,location_id,product_id,requested_by,reason,duration_minutes,
    status,code_hash,authorization_expires_at
  )
  values(
    p_restaurant_id,p_location_id,p_product_id,p_requested_by,v_reason,p_duration_minutes,
    'pending',extensions.crypt(p_code,extensions.gen_salt('bf',8)),v_auth_expires
  )
  returning id into v_request_id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,p_requested_by,'product',p_product_id,'availability.requested',
    jsonb_build_object(
      'requestId',v_request_id,
      'locationId',p_location_id,
      'reason',v_reason,
      'durationMinutes',p_duration_minutes
    )
  );

  return query
  select v_request_id,v_auth_expires,v_product_name,v_location_name,p_duration_minutes;
end;
$function$;

create or replace function public.list_product_availability_approvers_internal(
  p_restaurant_id uuid
)
returns table(email text,full_name text)
language sql
stable
security definer
set search_path=''
as $function$
  select distinct p.email::text,p.full_name
  from public.memberships m
  join public.role_permissions rp on rp.role_id=m.role_id
  join public.profiles p on p.id=m.user_id
  where m.restaurant_id=p_restaurant_id
    and m.status='active'
    and rp.permission_code='products.availability.approve'
    and p.email is not null
  order by p.email::text;
$function$;

create or replace function public.cancel_product_unavailability_authorization_internal(
  p_request_id uuid
)
returns void
language sql
security definer
set search_path=''
as $function$
  update public.product_unavailability_requests
  set status='cancelled'
  where id=p_request_id
    and status='pending';
$function$;

create or replace function public.mark_product_unavailability_email_sent_internal(
  p_request_id uuid
)
returns void
language sql
security definer
set search_path=''
as $function$
  update public.product_unavailability_requests
  set email_sent_at=now()
  where id=p_request_id;
$function$;

revoke all on function public.create_product_unavailability_authorization_internal(
  uuid,uuid,uuid,uuid,text,integer,text
) from public,anon,authenticated;
grant execute on function public.create_product_unavailability_authorization_internal(
  uuid,uuid,uuid,uuid,text,integer,text
) to service_role;

revoke all on function public.list_product_availability_approvers_internal(uuid)
  from public,anon,authenticated;
grant execute on function public.list_product_availability_approvers_internal(uuid)
  to service_role;

revoke all on function public.cancel_product_unavailability_authorization_internal(uuid)
  from public,anon,authenticated;
grant execute on function public.cancel_product_unavailability_authorization_internal(uuid)
  to service_role;

revoke all on function public.mark_product_unavailability_email_sent_internal(uuid)
  from public,anon,authenticated;
grant execute on function public.mark_product_unavailability_email_sent_internal(uuid)
  to service_role;

create or replace function private.consume_product_unavailability_authorization(
  p_request_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_request public.product_unavailability_requests%rowtype;
  v_attempts integer;
  v_until timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_request
  from public.product_unavailability_requests pur
  where pur.id=p_request_id
  for update;

  if not found then
    raise exception 'Solicitud no encontrada';
  end if;

  if v_request.requested_by<>v_actor then
    raise exception 'Esta autorización solo puede ser usada por quien hizo la solicitud';
  end if;

  if not private.user_has_location_permission(
    v_request.location_id,'products.availability.request'
  ) then
    raise exception 'Ya no tienes permiso para completar esta solicitud';
  end if;

  if v_request.status<>'pending' then
    return jsonb_build_object(
      'ok',false,
      'code','NOT_PENDING',
      'message','La solicitud ya no está pendiente'
    );
  end if;

  if v_request.authorization_expires_at<=now() then
    update public.product_unavailability_requests
    set status='expired'
    where id=v_request.id;

    return jsonb_build_object(
      'ok',false,
      'code','EXPIRED',
      'message','El código ha caducado. Solicita uno nuevo.'
    );
  end if;

  if v_request.attempts>=5 then
    update public.product_unavailability_requests
    set status='cancelled'
    where id=v_request.id;

    return jsonb_build_object(
      'ok',false,
      'code','TOO_MANY_ATTEMPTS',
      'message','Se agotaron los intentos. Solicita un código nuevo.'
    );
  end if;

  if extensions.crypt(btrim(coalesce(p_code,'')),v_request.code_hash)<>v_request.code_hash then
    v_attempts := v_request.attempts+1;

    update public.product_unavailability_requests
    set attempts=v_attempts,
        status=case when v_attempts>=5 then 'cancelled' else status end
    where id=v_request.id;

    return jsonb_build_object(
      'ok',false,
      'code',case when v_attempts>=5 then 'TOO_MANY_ATTEMPTS' else 'INVALID_CODE' end,
      'message',case
        when v_attempts>=5 then 'Se agotaron los intentos. Solicita un código nuevo.'
        else 'El código no es correcto.'
      end,
      'attemptsRemaining',greatest(0,5-v_attempts)
    );
  end if;

  if exists (
    select 1
    from public.product_unavailability_requests pur
    where pur.restaurant_id=v_request.restaurant_id
      and pur.location_id=v_request.location_id
      and pur.product_id=v_request.product_id
      and pur.status='approved'
      and pur.unavailable_until>now()
      and pur.id<>v_request.id
  ) then
    update public.product_unavailability_requests
    set status='cancelled'
    where id=v_request.id;

    return jsonb_build_object(
      'ok',false,
      'code','ALREADY_UNAVAILABLE',
      'message','El producto ya tiene una indisponibilidad activa.'
    );
  end if;

  v_until := now()+make_interval(mins=>v_request.duration_minutes);

  update public.product_unavailability_requests
  set status='approved',
      unavailable_until=v_until,
      used_by=v_actor,
      used_at=now()
  where id=v_request.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_request.restaurant_id,v_actor,'product',v_request.product_id,'availability.authorized',
    jsonb_build_object(
      'requestId',v_request.id,
      'locationId',v_request.location_id,
      'reason',v_request.reason,
      'durationMinutes',v_request.duration_minutes,
      'unavailableUntil',v_until
    )
  );

  return jsonb_build_object(
    'ok',true,
    'requestId',v_request.id,
    'productId',v_request.product_id,
    'locationId',v_request.location_id,
    'reason',v_request.reason,
    'unavailableUntil',v_until
  );
end;
$function$;

create or replace function public.consume_product_unavailability_authorization(
  p_request_id uuid,
  p_code text
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.consume_product_unavailability_authorization(p_request_id,p_code);
$function$;

revoke all on function private.consume_product_unavailability_authorization(uuid,text)
  from public,anon,authenticated;
grant execute on function private.consume_product_unavailability_authorization(uuid,text)
  to authenticated;

revoke all on function public.consume_product_unavailability_authorization(uuid,text)
  from public,anon;
grant execute on function public.consume_product_unavailability_authorization(uuid,text)
  to authenticated;
