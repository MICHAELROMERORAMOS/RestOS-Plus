CREATE OR REPLACE FUNCTION public.authorize_qr_attention(p_location_id uuid, p_qr_token uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 perform pg_advisory_xact_lock(hashtextextended(tid::text,1));
 if (select count(*) from public.qr_attention_sessions s where s.table_id=tid and s.location_id=p_location_id and s.created_at>now()-interval '5 minutes')>=12
 or (select count(*) from public.qr_attention_sessions s where s.location_id=p_location_id and s.created_at>now()-interval '1 minute')>=60
 then return jsonb_build_object('ok',false,'message','Demasiados accesos recientes. Intenta de nuevo en unos minutos.');end if;
 raw_token:=gen_random_uuid();
 insert into public.qr_attention_sessions(restaurant_id,location_id,table_id,token_hash)
 values(rid,p_location_id,tid,extensions.digest(raw_token::text,'sha256'));
 return jsonb_build_object('ok',true,'token',raw_token,'expiresInHours',4,
  'actions',jsonb_build_object('call_waiter',cfg.call_waiter,'request_drink',cfg.request_drink,
  'request_bill',cfg.request_bill,'order_status',cfg.order_status));
end $function$
;
CREATE OR REPLACE FUNCTION public.qr_attention_customer_action(p_location_id uuid, p_qr_token uuid, p_session_token uuid, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform pg_advisory_xact_lock(hashtextextended(tid::text,2));
  if (select count(*) from public.qr_attention_requests r where r.table_id=tid and r.location_id=p_location_id and r.created_at>now()-interval '1 minute')>=6
  then return jsonb_build_object('ok',false,'message','Esta mesa ya ha enviado varias solicitudes. Espera un momento.');end if;
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
end $function$
;