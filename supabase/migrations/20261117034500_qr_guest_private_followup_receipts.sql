-- Anonymous visitors cannot directly access these rows. Only validated guest RPCs can.
create table if not exists public.qr_guest_view_tokens(
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.qr_guest_sessions(id) on delete cascade,
 token_hash bytea not null unique,
 issued_at timestamptz not null default now(),
 expires_at timestamptz not null default (now()+interval '48 hours')
);
create index if not exists qr_guest_view_tokens_session on public.qr_guest_view_tokens(session_id);
alter table public.qr_guest_view_tokens enable row level security;
revoke all on public.qr_guest_view_tokens from anon,authenticated;
create table if not exists public.qr_guest_request_items(
 request_id uuid not null references public.qr_guest_requests(id) on delete cascade,
 position int not null,
 order_item_id uuid not null unique references public.order_items(id),
 primary key(request_id,position)
);
alter table public.qr_guest_request_items enable row level security;
revoke all on public.qr_guest_request_items from anon,authenticated;
CREATE OR REPLACE FUNCTION public.authorize_qr_guest_view(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session public.qr_guest_sessions%rowtype;v_token uuid;
begin
 if p_access_code !~ '^[0-9]{4}$' then return jsonb_build_object('ok',false,'message','PIN inválido');end if;
 select s.* into v_session
 from public.table_qr_codes q
 join public.qr_guest_sessions s on s.table_id=q.table_id and s.location_id=q.location_id and s.restaurant_id=q.restaurant_id
 join public.qr_menu_settings qm on qm.location_id=q.location_id and qm.restaurant_id=q.restaurant_id and qm.enabled
 join public.orders o on o.id=s.order_id and o.restaurant_id=s.restaurant_id and o.location_id=s.location_id
 where q.location_id=p_location_id and q.token=p_qr_token and s.status='active' and s.expires_at>now()
   and o.status in ('draft','open','awaiting_payment') and o.payment_status<>'paid'
 order by s.created_at desc limit 1 for update of s;
 if not found then return jsonb_build_object('ok',false,'message','Sesión de mesa no disponible');end if;
 if v_session.locked_until>now() then return jsonb_build_object('ok',false,'message','PIN bloqueado temporalmente');end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions
  set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
      locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end
  where id=v_session.id;
  return jsonb_build_object('ok',false,'message','PIN incorrecto');
 end if;
 update public.qr_guest_sessions set failed_attempts=0,locked_until=null where id=v_session.id;
 v_token:=gen_random_uuid();
 insert into public.qr_guest_view_tokens(session_id,token_hash,expires_at)
 values(v_session.id,extensions.digest(v_token::text,'sha256'),now()+interval '48 hours');
 return jsonb_build_object('ok',true,'viewToken',v_token,'validHours',48);
end $function$
;
CREATE OR REPLACE FUNCTION public.get_qr_guest_order_status(p_location_id uuid, p_qr_token uuid, p_view_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_session public.qr_guest_sessions%rowtype;v_status jsonb;v_order_status text;v_paid text;
begin
 select s.* into v_session
 from public.qr_guest_view_tokens v
 join public.qr_guest_sessions s on s.id=v.session_id
 join public.table_qr_codes q on q.table_id=s.table_id and q.location_id=s.location_id and q.restaurant_id=s.restaurant_id
 where q.location_id=p_location_id and q.token=p_qr_token
   and v.token_hash=extensions.digest(p_view_token::text,'sha256') and v.expires_at>now()
 limit 1;
 if not found then return jsonb_build_object('authorized',false);end if;
 select o.status,o.payment_status into v_order_status,v_paid
 from public.orders o where o.id=v_session.order_id and o.restaurant_id=v_session.restaurant_id
 and o.location_id=p_location_id;
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',rq.id,'createdAt',rq.created_at,'status',rq.status,'total',rq.total,
   'items',coalesce((
     select jsonb_agg(jsonb_build_object(
       'name',it.value->>'name','quantity',(it.value->>'quantity')::numeric,
       'unitPrice',(it.value->>'unitPrice')::numeric,
       'status',coalesce(oi.status,case when rq.status='rejected' then 'rejected' else rq.status end),
       'servedQuantity',coalesce(oi.served_quantity,0)
     ) order by it.ordinality)
     from jsonb_array_elements(rq.items) with ordinality as it(value,ordinality)
     left join public.qr_guest_request_items map on map.request_id=rq.id and map.position=it.ordinality
     left join public.order_items oi on oi.id=map.order_item_id and oi.order_id=v_session.order_id
   ),'[]'::jsonb)
 ) order by rq.created_at desc),'[]'::jsonb)
 into v_status
 from public.qr_guest_requests rq where rq.session_id=v_session.id
 and rq.location_id=p_location_id and rq.restaurant_id=v_session.restaurant_id
 and rq.table_id=v_session.table_id;
 return jsonb_build_object(
    'authorized',true,'requests',v_status,
    'canOrder',v_session.status='active' and v_session.expires_at>now() and v_order_status in ('draft','open','awaiting_payment') and coalesce(v_paid,'')<>'paid',
    'orderClosed',v_session.status<>'active' or coalesce(v_paid,'')='paid' or v_order_status in ('closed','cancelled','merged'),
    'updatedAt',now()
 );
end $function$
;
revoke all on function public.authorize_qr_guest_view(uuid,uuid,text) from public;
grant execute on function public.authorize_qr_guest_view(uuid,uuid,text) to anon,authenticated;
revoke all on function public.get_qr_guest_order_status(uuid,uuid,uuid) from public;
grant execute on function public.get_qr_guest_order_status(uuid,uuid,uuid) to anon,authenticated;
