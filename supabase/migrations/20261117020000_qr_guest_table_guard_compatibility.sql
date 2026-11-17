-- Preserve the POS table-session guard while allowing a verified QR visitor to create ONLY its own first table link.
-- No caller can write qr_guest_sessions or order_table_links directly as anon.
CREATE OR REPLACE FUNCTION private.enforce_table_order_session_on_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  v_claimed_by uuid;
  v_is_initial_link boolean := false;
begin
  perform 1
  from public.dining_tables t
  where t.id = new.table_id
  for update;

  delete from public.table_order_sessions
  where table_id = new.table_id
    and last_seen_at < now() - interval '5 minutes';

  -- Only a validated, still-live guest QR session may establish its own first table link.
  -- Anonymous callers cannot write qr_guest_sessions or order_table_links directly.
  if exists (
    select 1 from public.qr_guest_sessions s
    join public.orders o on o.id=s.order_id
    where s.table_id=new.table_id and s.order_id=new.order_id
      and s.status='active' and s.claimed_at is not null and s.expires_at>now()
      and o.restaurant_id=s.restaurant_id and o.location_id=s.location_id
      and o.status='draft' and o.payment_status='unpaid'
      and not exists(select 1 from public.order_table_links l where l.order_id=new.order_id and l.unlinked_at is null)
  ) then return new; end if;

  select claimed_by
  into v_claimed_by
  from public.table_order_sessions
  where table_id = new.table_id
  for update;

  if found then
    if v_user is null or v_claimed_by <> v_user then
      raise exception 'Table is being opened by another user';
    end if;

    delete from public.table_order_sessions
    where table_id = new.table_id
      and claimed_by = v_user;

    return new;
  end if;

  select
    not exists (
      select 1
      from public.order_rounds r
      where r.order_id = new.order_id
    )
    and not exists (
      select 1
      from public.order_table_links l
      where l.order_id = new.order_id
        and l.unlinked_at is null
    )
  into v_is_initial_link;

  if v_is_initial_link then
    raise exception 'Table session is no longer active. Open the table again before sending the order';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_qr_guest_table(p_location_id uuid, p_qr_token uuid, p_access_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_table uuid;v_restaurant uuid;v_session public.qr_guest_sessions%rowtype;v_order uuid;
begin
 if p_access_code !~ '^[0-9]{4}$' then raise exception 'Introduce un código de 4 dígitos';end if;
 select q.table_id,q.restaurant_id into v_table,v_restaurant
 from public.table_qr_codes q
 join public.dining_tables t on t.id=q.table_id and t.location_id=q.location_id and t.active=true
 join public.locations l on l.id=q.location_id and l.restaurant_id=q.restaurant_id and l.active=true
 join public.restaurants r on r.id=q.restaurant_id and r.status='active'
 join public.qr_menu_settings ms on ms.location_id=q.location_id and ms.restaurant_id=q.restaurant_id and ms.enabled=true
 where q.token=p_qr_token and q.location_id=p_location_id;
 if v_table is null then raise exception 'Código QR inválido';end if;
 perform 1 from public.dining_tables where id=v_table for update;
 select * into v_session from public.qr_guest_sessions
 where table_id=v_table and location_id=p_location_id and restaurant_id=v_restaurant
 and status='active' and expires_at>now() order by created_at desc limit 1 for update;
 if not found then raise exception 'Solicita al personal el código de esta mesa';end if;
 if v_session.locked_until>now() then raise exception 'Demasiados intentos. Solicita ayuda al personal';end if;
 if v_session.access_code<>p_access_code then
  update public.qr_guest_sessions
   set failed_attempts=case when failed_attempts>=4 then 0 else failed_attempts+1 end,
       locked_until=case when failed_attempts>=4 then now()+interval '5 minutes' else null end
   where id=v_session.id;
  return jsonb_build_object('ok',false,'message','Código incorrecto');
 end if;
 update public.qr_guest_sessions set failed_attempts=0,locked_until=null where id=v_session.id;
 if v_session.claimed_at is not null then
  if not exists(select 1 from public.orders where id=v_session.order_id and status in ('draft','open','awaiting_payment') and payment_status<>'paid')
  then raise exception 'La cuenta está cerrada';end if;
  return jsonb_build_object('ok',true,'tableId',v_table,'orderId',v_session.order_id);
 end if;
 if exists(select 1 from public.table_order_sessions where table_id=v_table) or exists(
  select 1 from public.order_table_links ol join public.orders o on o.id=ol.order_id
  where ol.table_id=v_table and ol.unlinked_at is null and o.status in ('draft','open','awaiting_payment')
 ) then raise exception 'Esta mesa ya se encuentra ocupada';end if;
 insert into public.orders(restaurant_id,location_id,service_mode,payment_timing,status,customer_name)
 values(v_restaurant,p_location_id,'table','postpaid','draft','Pedido QR')
 returning id into v_order;
 update public.qr_guest_sessions set claimed_at=now(),order_id=v_order where id=v_session.id;
 insert into public.order_table_links(order_id,table_id,is_primary) values(v_order,v_table,true);
 return jsonb_build_object('ok',true,'tableId',v_table,'orderId',v_order);
end $function$
;
revoke all on function public.claim_qr_guest_table(uuid,uuid,text) from public;
grant execute on function public.claim_qr_guest_table(uuid,uuid,text) to anon,authenticated;
