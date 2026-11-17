
create table if not exists public.qr_attention_settings (
 location_id uuid primary key references public.locations(id) on delete cascade,
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 enabled boolean not null default false,
 call_waiter boolean not null default true,
 request_drink boolean not null default true,
 request_bill boolean not null default true,
 order_status boolean not null default true,
 updated_at timestamptz not null default now()
);
alter table public.qr_attention_settings enable row level security;
revoke all on public.qr_attention_settings from public,anon,authenticated;

create table if not exists public.qr_attention_codes (
 location_id uuid primary key references public.locations(id) on delete cascade,
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 code text not null check (code ~ '^[0-9]{6}$'),
 expires_at timestamptz not null,
 failed_attempts integer not null default 0,
 attempt_window timestamptz not null default now(),
 locked_until timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.qr_attention_codes enable row level security;
revoke all on public.qr_attention_codes from public,anon,authenticated;

create table if not exists public.qr_attention_sessions (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 location_id uuid not null references public.locations(id) on delete cascade,
 table_id uuid not null references public.dining_tables(id) on delete cascade,
 token_hash bytea not null unique,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now()+interval '4 hours'),
 revoked_at timestamptz
);
create index if not exists qr_attention_sessions_lookup on public.qr_attention_sessions(location_id,table_id,expires_at);
alter table public.qr_attention_sessions enable row level security;
revoke all on public.qr_attention_sessions from public,anon,authenticated;

create table if not exists public.qr_attention_requests (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id) on delete cascade,
 location_id uuid not null references public.locations(id) on delete cascade,
 table_id uuid not null references public.dining_tables(id) on delete cascade,
 session_id uuid not null references public.qr_attention_sessions(id) on delete cascade,
 action text not null check(action in ('call_waiter','request_drink','request_bill')),
 status text not null default 'pending' check(status in ('pending','acknowledged','completed','cancelled')),
 created_at timestamptz not null default now(),
 acknowledged_at timestamptz,
 completed_at timestamptz,
 handled_by uuid
);
create index if not exists qr_attention_requests_location_status on public.qr_attention_requests(location_id,status,created_at desc);
create index if not exists qr_attention_requests_session on public.qr_attention_requests(session_id,created_at desc);
alter table public.qr_attention_requests enable row level security;
revoke all on public.qr_attention_requests from public,anon,authenticated;

-- Only branch members with order/table permissions can subscribe to private staff alerts.
create policy qr_attention_staff_select on public.qr_attention_requests
 for select to authenticated using (
 exists (
  select 1 from public.memberships m
  where m.user_id=(select auth.uid()) and m.restaurant_id=qr_attention_requests.restaurant_id and m.status='active'
   and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=qr_attention_requests.location_id))
   and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','payments.create','settings.manage'))
 )
);
grant select on public.qr_attention_requests to authenticated;

create or replace function public.manage_qr_attention_settings(p_location_id uuid, p_changes jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; can_change boolean; s public.qr_attention_settings%rowtype;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active;
 if rid is null then raise exception 'Sucursal no encontrada' using errcode='42501';end if;
 select exists(select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
  and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
  and (exists(select 1 from public.restaurants r where r.id=rid and r.owner_user_id=(select auth.uid()))
   or exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code='settings.manage')))
 into can_change;
 if not can_change then raise exception 'No autorizado para administrar esta sucursal' using errcode='42501';end if;
 if p_changes is not null then
  if jsonb_typeof(p_changes)<>'object' or exists(select 1 from jsonb_object_keys(p_changes) k where k not in ('enabled','call_waiter','request_drink','request_bill','order_status'))
  then raise exception 'Configuración inválida';end if;
  if exists(select 1 from jsonb_each(p_changes) entry where jsonb_typeof(entry.value)<>'boolean') then raise exception 'Cada opción debe ser verdadero o falso';end if;
  insert into public.qr_attention_settings(location_id,restaurant_id,enabled,call_waiter,request_drink,request_bill,order_status)
  values(p_location_id,rid,coalesce((p_changes->>'enabled')::boolean,false),
   coalesce((p_changes->>'call_waiter')::boolean,true),
   coalesce((p_changes->>'request_drink')::boolean,true),
   coalesce((p_changes->>'request_bill')::boolean,true),
   coalesce((p_changes->>'order_status')::boolean,true))
  on conflict(location_id) do update set
   enabled=coalesce((p_changes->>'enabled')::boolean,qr_attention_settings.enabled),
   call_waiter=coalesce((p_changes->>'call_waiter')::boolean,qr_attention_settings.call_waiter),
   request_drink=coalesce((p_changes->>'request_drink')::boolean,qr_attention_settings.request_drink),
   request_bill=coalesce((p_changes->>'request_bill')::boolean,qr_attention_settings.request_bill),
   order_status=coalesce((p_changes->>'order_status')::boolean,qr_attention_settings.order_status),
   updated_at=now()
  where qr_attention_settings.restaurant_id=excluded.restaurant_id;
 end if;
 select * into s from public.qr_attention_settings where location_id=p_location_id;
 return jsonb_build_object('enabled',coalesce(s.enabled,false),'call_waiter',coalesce(s.call_waiter,true),
 'request_drink',coalesce(s.request_drink,true),'request_bill',coalesce(s.request_bill,true),
 'order_status',coalesce(s.order_status,true));
end $$;
revoke all on function public.manage_qr_attention_settings(uuid,jsonb) from public,anon;
grant execute on function public.manage_qr_attention_settings(uuid,jsonb) to authenticated;

create or replace function public.get_qr_attention_public_settings(p_location_id uuid,p_qr_token uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'enabled',s.enabled,'call_waiter',s.call_waiter,'request_drink',s.request_drink,
  'request_bill',s.request_bill,'order_status',s.order_status)
 from public.qr_attention_settings s
 join public.table_qr_codes q on q.location_id=s.location_id and q.restaurant_id=s.restaurant_id
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active=true
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active=true
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 where q.location_id=p_location_id and q.token=p_qr_token
 limit 1;
$$;
revoke all on function public.get_qr_attention_public_settings(uuid,uuid) from public;
grant execute on function public.get_qr_attention_public_settings(uuid,uuid) to anon,authenticated;

create or replace function public.get_qr_attention_display(p_location_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; c public.qr_attention_codes%rowtype; active boolean;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active;
 if rid is null or not exists (
 select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
 and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','payments.create','settings.manage'))
 ) then raise exception 'Pantalla no autorizada' using errcode='42501';end if;
 select enabled into active from public.qr_attention_settings where location_id=p_location_id and restaurant_id=rid;
 if not coalesce(active,false) then return jsonb_build_object('enabled',false);end if;
 insert into public.qr_attention_codes(location_id,restaurant_id,code,expires_at)
 values (p_location_id,rid,lpad((floor(random()*1000000))::int::text,6,'0'),now()+interval '20 minutes')
 on conflict(location_id) do update set
 code=case when qr_attention_codes.expires_at<=now() then excluded.code else qr_attention_codes.code end,
 expires_at=case when qr_attention_codes.expires_at<=now() then excluded.expires_at else qr_attention_codes.expires_at end,
 failed_attempts=case when qr_attention_codes.expires_at<=now() then 0 else qr_attention_codes.failed_attempts end,
 locked_until=case when qr_attention_codes.expires_at<=now() then null else qr_attention_codes.locked_until end,
 updated_at=now()
 where qr_attention_codes.restaurant_id=excluded.restaurant_id;
 select * into c from public.qr_attention_codes where location_id=p_location_id;
 return jsonb_build_object('enabled',true,'code',c.code,'expiresAt',c.expires_at,'serverNow',now());
end $$;
revoke all on function public.get_qr_attention_display(uuid) from public,anon;
grant execute on function public.get_qr_attention_display(uuid) to authenticated;

create or replace function public.authorize_qr_attention(p_location_id uuid,p_qr_token uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; tid uuid; cfg public.qr_attention_settings%rowtype; c public.qr_attention_codes%rowtype; raw_token uuid;
begin
 if p_code is null or p_code !~ '^[0-9]{6}$' then return jsonb_build_object('ok',false,'message','Introduce los seis números del código');end if;
 select q.restaurant_id,q.table_id into rid,tid from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 where q.token=p_qr_token and q.location_id=p_location_id;
 if tid is null then return jsonb_build_object('ok',false,'message','Mesa no disponible');end if;
 select * into cfg from public.qr_attention_settings where location_id=p_location_id and restaurant_id=rid;
 if not coalesce(cfg.enabled,false) then return jsonb_build_object('ok',false,'message','Servicio no disponible');end if;
 select * into c from public.qr_attention_codes where location_id=p_location_id and restaurant_id=rid for update;
 if not found or c.expires_at<=now() then return jsonb_build_object('ok',false,'message','Código expirado. Consulta la pantalla del restaurante.');end if;
 if c.locked_until>now() then return jsonb_build_object('ok',false,'message','Demasiados intentos. Intenta más tarde.');end if;
 if c.code<>p_code then
  update public.qr_attention_codes set
   failed_attempts=case when attempt_window<now()-interval '1 minute' then 1 else failed_attempts+1 end,
   attempt_window=case when attempt_window<now()-interval '1 minute' then now() else attempt_window end,
   locked_until=case when attempt_window>=now()-interval '1 minute' and failed_attempts>=19 then now()+interval '2 minutes' else null end
  where location_id=p_location_id;
  return jsonb_build_object('ok',false,'message','Código incorrecto');
 end if;
 raw_token:=gen_random_uuid();
 insert into public.qr_attention_sessions(restaurant_id,location_id,table_id,token_hash)
 values(rid,p_location_id,tid,extensions.digest(raw_token::text,'sha256'));
 return jsonb_build_object('ok',true,'token',raw_token,'expiresInHours',4,
  'actions',jsonb_build_object('call_waiter',cfg.call_waiter,'request_drink',cfg.request_drink,
  'request_bill',cfg.request_bill,'order_status',cfg.order_status));
end $$;
revoke all on function public.authorize_qr_attention(uuid,uuid,text) from public;
grant execute on function public.authorize_qr_attention(uuid,uuid,text) to anon,authenticated;

create or replace function public.qr_attention_customer_action(p_location_id uuid,p_qr_token uuid,p_session_token uuid,p_action text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid;tid uuid;rid uuid;cfg public.qr_attention_settings%rowtype; request_id uuid;
begin
 select s.id,s.table_id,s.restaurant_id into sid,tid,rid
 from public.qr_attention_sessions s
 join public.table_qr_codes q on q.table_id=s.table_id and q.location_id=s.location_id and q.restaurant_id=s.restaurant_id
 where q.token=p_qr_token and q.location_id=p_location_id and s.location_id=p_location_id
 and s.token_hash=extensions.digest(p_session_token::text,'sha256') and s.expires_at>now() and s.revoked_at is null;
 if sid is null then return jsonb_build_object('ok',false,'message','Acceso expirado o inválido');end if;
 select * into cfg from public.qr_attention_settings where location_id=p_location_id and restaurant_id=rid;
 if not coalesce(cfg.enabled,false) then return jsonb_build_object('ok',false,'message','Servicio desactivado');end if;
 if p_action is not null then
  if p_action not in ('call_waiter','request_drink','request_bill') or
   (p_action='call_waiter' and not cfg.call_waiter) or
   (p_action='request_drink' and not cfg.request_drink) or
   (p_action='request_bill' and not cfg.request_bill)
  then return jsonb_build_object('ok',false,'message','Esta opción no está disponible');end if;
  perform pg_advisory_xact_lock(hashtextextended(sid::text,0));
  if (select count(*) from public.qr_attention_requests where session_id=sid and created_at>now()-interval '1 minute')>=3
  then return jsonb_build_object('ok',false,'message','Espera un momento antes de enviar otra solicitud');end if;
  if exists(select 1 from public.qr_attention_requests where session_id=sid and action=p_action and status in ('pending','acknowledged'))
  then return jsonb_build_object('ok',false,'message','Ya tienes una solicitud de este tipo en curso');end if;
  insert into public.qr_attention_requests(restaurant_id,location_id,table_id,session_id,action)
  values(rid,p_location_id,tid,sid,p_action) returning id into request_id;
 end if;
 return jsonb_build_object('ok',true,'requestId',request_id,'actions',
 jsonb_build_object('call_waiter',cfg.call_waiter,'request_drink',cfg.request_drink,
 'request_bill',cfg.request_bill,'order_status',cfg.order_status),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'action',r.action,'status',r.status,'createdAt',r.created_at)
 order by r.created_at desc) from public.qr_attention_requests r where r.session_id=sid),'[]'::jsonb));
end $$;
revoke all on function public.qr_attention_customer_action(uuid,uuid,uuid,text) from public;
grant execute on function public.qr_attention_customer_action(uuid,uuid,uuid,text) to anon,authenticated;

create or replace function public.manage_qr_attention_requests(p_location_id uuid,p_request_id uuid default null,p_status text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 select restaurant_id into rid from public.locations where id=p_location_id and active;
 if rid is null or not exists (
 select 1 from public.memberships m where m.restaurant_id=rid and m.user_id=(select auth.uid()) and m.status='active'
 and (m.all_locations or exists(select 1 from public.membership_locations ml where ml.membership_id=m.id and ml.location_id=p_location_id))
 and exists(select 1 from public.role_permissions rp where rp.role_id=m.role_id and rp.permission_code in ('orders.create','tables.manage','payments.create','settings.manage'))
 ) then raise exception 'No autorizado' using errcode='42501';end if;
 if p_request_id is not null then
  if p_status not in ('acknowledged','completed','cancelled') then raise exception 'Estado inválido';end if;
  update public.qr_attention_requests set status=p_status,
   acknowledged_at=case when p_status='acknowledged' then now() else acknowledged_at end,
   completed_at=case when p_status in ('completed','cancelled') then now() else completed_at end,
   handled_by=(select auth.uid())
  where id=p_request_id and location_id=p_location_id and restaurant_id=rid
    and (status='pending' or (status='acknowledged' and p_status in ('completed','cancelled')));
  if not found then raise exception 'Solicitud no disponible o ya atendida';end if;
 end if;
 return jsonb_build_object('requests',coalesce((
 select jsonb_agg(jsonb_build_object('id',r.id,'action',r.action,'status',r.status,'createdAt',r.created_at,'tableName',t.name,'zoneName',z.name)
 order by r.created_at desc)
 from public.qr_attention_requests r join public.dining_tables t on t.id=r.table_id
 left join public.dining_zones z on z.id=t.zone_id
 where r.location_id=p_location_id and r.restaurant_id=rid and r.created_at>now()-interval '24 hours'
 and r.status in ('pending','acknowledged')
 ),'[]'::jsonb));
end $$;
revoke all on function public.manage_qr_attention_requests(uuid,uuid,text) from public,anon;
grant execute on function public.manage_qr_attention_requests(uuid,uuid,text) to authenticated;

-- Realtime broadcasts only authenticated branch-scoped rows through the SELECT policy.
do $$ begin
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='qr_attention_requests') then
  alter publication supabase_realtime add table public.qr_attention_requests;
 end if;
end $$;
