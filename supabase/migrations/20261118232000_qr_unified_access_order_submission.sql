
create or replace function public.submit_qr_guest_order_with_attention(
 p_location_id uuid,p_qr_token uuid,p_attention_token uuid,p_view_token uuid,p_items jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid;vid uuid;uid uuid;login_mode text; internal_pin text; output jsonb;req_id uuid;
begin
 select s.id,v.id,v.customer_user_id,m.auth_mode,s.access_code
 into sid,vid,uid,login_mode,internal_pin
 from public.qr_guest_view_tokens v
 join public.qr_guest_sessions s on s.id=v.session_id
 join public.table_qr_codes q on q.table_id=s.table_id and q.location_id=s.location_id and q.restaurant_id=s.restaurant_id
 join public.qr_menu_settings m on m.location_id=s.location_id and m.restaurant_id=s.restaurant_id and m.enabled
 join public.qr_attention_settings cfg on cfg.location_id=s.location_id and cfg.restaurant_id=s.restaurant_id and cfg.enabled
 join public.qr_attention_sessions a on a.table_id=s.table_id and a.location_id=s.location_id and a.restaurant_id=s.restaurant_id
  and a.token_hash=extensions.digest(p_attention_token::text,'sha256') and a.expires_at>now() and a.revoked_at is null
 left join public.qr_table_order_settings ts on ts.table_id=s.table_id and ts.location_id=s.location_id and ts.restaurant_id=s.restaurant_id
 where q.token=p_qr_token and q.location_id=p_location_id and s.location_id=p_location_id
 and s.status='active' and s.expires_at>now() and v.expires_at>now()
 and v.token_hash=extensions.digest(p_view_token::text,'sha256') and coalesce(ts.enabled,true);
 if vid is null then raise exception 'No tienes autorización para enviar pedidos en esta mesa' using errcode='42501';end if;
 if login_mode='required' and ((select auth.uid()) is null or coalesce((select auth.jwt()->>'is_anonymous'),'false')='true')
 then raise exception 'Debes iniciar sesión para realizar pedidos' using errcode='42501';end if;
 if uid is not null and uid is distinct from (select auth.uid())
 then raise exception 'La autorización pertenece a otro cliente' using errcode='42501';end if;
 if login_mode='required' and uid is distinct from (select auth.uid())
 then raise exception 'Vuelve a autorizar tus pedidos después de iniciar sesión' using errcode='42501';end if;
 -- Reuse existing audited validation of products, stock, allergies and totals.
 -- Legacy compatibility secret is never sent to the client or accepted as a public credential.
 output:=public.submit_qr_guest_request(p_location_id,p_qr_token,internal_pin,p_items);
 if coalesce((output->>'ok')::boolean,false) then
  req_id:=(output->>'requestId')::uuid;
  update public.qr_guest_requests set view_token_id=vid,
    customer_user_id=case when login_mode='disabled' then null else (select auth.uid()) end
  where id=req_id and session_id=sid and location_id=p_location_id;
  if not found then raise exception 'No se pudo asociar la solicitud al cliente';end if;
 end if;
 return output;
end $$;
revoke all on function public.submit_qr_guest_order_with_attention(uuid,uuid,uuid,uuid,jsonb) from public;
grant execute on function public.submit_qr_guest_order_with_attention(uuid,uuid,uuid,uuid,jsonb) to anon,authenticated;

revoke all on function public.claim_qr_guest_table(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.authorize_qr_guest_view(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.submit_qr_guest_request(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.submit_qr_guest_request(uuid,uuid,text,jsonb,uuid) from public,anon,authenticated;
