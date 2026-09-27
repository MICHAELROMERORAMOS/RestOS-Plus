alter table public.account_void_audit
  drop constraint if exists account_void_audit_scope_check;

alter table public.account_void_audit
  add constraint account_void_audit_scope_check
  check (void_scope in ('partial','paid','invoice'));

create or replace function private.find_paid_invoice_for_void(
  p_restaurant_id uuid,
  p_invoice_number text,
  p_user_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_invoice public.sales_invoices%rowtype;
  v_order public.orders%rowtype;
  v_table_label text;
  v_items jsonb;
  v_payments jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    where m.user_id=p_user_id
      and m.restaurant_id=p_restaurant_id
      and m.status='active'
      and rp.permission_code in ('payments.create','orders.account_void.paid')
  ) then
    raise exception 'No tienes permiso para solicitar la anulación de facturas';
  end if;

  select * into v_invoice
  from public.sales_invoices si
  where si.restaurant_id=p_restaurant_id
    and upper(si.invoice_number)=upper(btrim(p_invoice_number))
  limit 1;

  if not found then raise exception 'No encontramos una factura con ese número'; end if;
  if v_invoice.status='voided' or v_invoice.voided_at is not null then
    raise exception 'Esta factura ya fue anulada';
  end if;

  select * into v_order
  from public.orders
  where id=v_invoice.order_id;

  if not found then raise exception 'El pedido asociado ya no existe'; end if;

  select string_agg(coalesce(t.name,t.code),' + ' order by l.is_primary desc,l.linked_at)
  into v_table_label
  from public.order_table_links l
  join public.dining_tables t on t.id=l.table_id
  where l.order_id=v_order.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',coalesce(sii.order_item_id,sii.id),
    'name',sii.item_name,
    'quantity',sii.quantity,
    'unitPrice',sii.unit_price,
    'amount',sii.amount
  ) order by sii.created_at),'[]'::jsonb)
  into v_items
  from public.sales_invoice_items sii
  where sii.invoice_id=v_invoice.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,
    'method',p.method,
    'amount',p.amount,
    'paidAt',p.paid_at,
    'reference',p.reference
  ) order by p.paid_at),'[]'::jsonb)
  into v_payments
  from public.sales_invoice_payments sip
  join public.payments p on p.id=sip.payment_id
  where sip.invoice_id=v_invoice.id
    and p.status in ('completed','refunded');

  return jsonb_build_object(
    'invoiceId',v_invoice.id,
    'orderId',v_order.id,
    'orderNumber',v_order.order_number,
    'invoiceNumber',v_invoice.invoice_number,
    'issuedAt',v_invoice.issued_at,
    'tableLabel',v_table_label,
    'subtotal',v_invoice.subtotal,
    'discountTotal',0,
    'taxTotal',v_invoice.tax_total,
    'total',v_invoice.total,
    'paidTotal',v_invoice.total,
    'items',v_items,
    'payments',v_payments,
    'legacyOrderInvoice',v_invoice.legacy_order_invoice
  );
end;
$function$;

create or replace function public.create_invoice_void_authorization_internal(
  p_restaurant_id uuid,
  p_requested_by uuid,
  p_invoice_number text,
  p_reason text,
  p_comment text,
  p_code text
)
returns table(
  request_id uuid,
  expires_at timestamptz,
  order_id uuid,
  invoice_number text,
  order_number bigint,
  table_label text,
  amount_paid numeric,
  items jsonb
)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_invoice jsonb;
  v_request_id uuid;
  v_expires timestamptz:=now()+interval '10 minutes';
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'Invalid authorization code'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'El motivo es obligatorio'; end if;
  if length(btrim(coalesce(p_comment,'')))<5 then raise exception 'La observación es obligatoria'; end if;

  v_invoice:=private.find_paid_invoice_for_void(p_restaurant_id,p_invoice_number,p_requested_by);

  if not exists(
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    join public.profiles p on p.id=m.user_id
    where m.restaurant_id=p_restaurant_id
      and m.status='active'
      and rp.permission_code='orders.void.approve'
      and p.email is not null
  ) then
    raise exception 'No hay un owner activo con correo configurado';
  end if;

  update public.void_authorization_requests var
  set status='cancelled'
  where var.restaurant_id=p_restaurant_id
    and upper(coalesce(var.invoice_number,''))=upper(v_invoice->>'invoiceNumber')
    and var.line_ref='PAID_INVOICE'
    and var.status='pending';

  insert into public.void_authorization_requests(
    restaurant_id,requested_by,order_ref,line_ref,item_name,amount,reason,
    code_hash,expires_at,order_id,invoice_number,comment
  )
  values(
    p_restaurant_id,p_requested_by,v_invoice->>'orderId','PAID_INVOICE',
    'Factura pagada',(v_invoice->>'paidTotal')::numeric,btrim(p_reason),
    extensions.crypt(p_code,extensions.gen_salt('bf',8)),v_expires,
    (v_invoice->>'orderId')::uuid,v_invoice->>'invoiceNumber',btrim(p_comment)
  )
  returning id into v_request_id;

  return query
  select
    v_request_id,
    v_expires,
    (v_invoice->>'orderId')::uuid,
    v_invoice->>'invoiceNumber',
    (v_invoice->>'orderNumber')::bigint,
    v_invoice->>'tableLabel',
    (v_invoice->>'paidTotal')::numeric,
    v_invoice->'items';
end;
$function$;

create or replace function private.consume_invoice_void_authorization(
  p_request_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid:=auth.uid();
  v_req public.void_authorization_requests%rowtype;
  v_invoice public.sales_invoices%rowtype;
  v_order public.orders%rowtype;
  v_audit_id uuid;
  v_items jsonb;
  v_table_label text;
  v_attempts integer;
  v_refund_amount numeric(14,2);
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_req
  from public.void_authorization_requests
  where id=p_request_id
  for update;

  if not found or v_req.line_ref<>'PAID_INVOICE' then
    raise exception 'Solicitud de autorización no encontrada';
  end if;
  if v_req.requested_by<>v_user then raise exception 'La autorización pertenece a otro usuario'; end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id=m.role_id
    where m.user_id=v_user
      and m.restaurant_id=v_req.restaurant_id
      and m.status='active'
      and rp.permission_code in ('payments.create','orders.account_void.paid')
  ) then
    raise exception 'No tienes permiso para anular esta factura';
  end if;

  if v_req.status<>'pending' then
    return jsonb_build_object('ok',false,'message','La autorización ya no está activa');
  end if;

  if v_req.expires_at<=now() then
    update public.void_authorization_requests set status='expired' where id=v_req.id;
    return jsonb_build_object('ok',false,'message','El código venció');
  end if;

  if v_req.attempts>=5 then
    update public.void_authorization_requests set status='cancelled' where id=v_req.id;
    return jsonb_build_object('ok',false,'message','El código fue bloqueado');
  end if;

  if extensions.crypt(p_code,v_req.code_hash)<>v_req.code_hash then
    v_attempts:=v_req.attempts+1;
    update public.void_authorization_requests
    set attempts=v_attempts,
        status=case when v_attempts>=5 then 'cancelled' else status end
    where id=v_req.id;

    return jsonb_build_object(
      'ok',false,
      'message',case when v_attempts>=5 then 'Código bloqueado después de cinco intentos' else 'Código incorrecto' end,
      'attemptsRemaining',greatest(0,5-v_attempts)
    );
  end if;

  select * into v_invoice
  from public.sales_invoices si
  where si.restaurant_id=v_req.restaurant_id
    and upper(si.invoice_number)=upper(v_req.invoice_number)
  for update;

  if not found then raise exception 'La factura ya no existe'; end if;
  if v_invoice.status='voided' or v_invoice.voided_at is not null then
    raise exception 'La factura ya fue anulada';
  end if;

  select * into v_order
  from public.orders
  where id=v_invoice.order_id
  for update;

  if not found then raise exception 'El pedido asociado ya no existe'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',coalesce(sii.order_item_id,sii.id),
    'name',sii.item_name,
    'quantity',sii.quantity,
    'unitPrice',sii.unit_price,
    'amount',sii.amount
  ) order by sii.created_at),'[]'::jsonb)
  into v_items
  from public.sales_invoice_items sii
  where sii.invoice_id=v_invoice.id;

  select string_agg(coalesce(t.name,t.code),' + ' order by l.is_primary desc,l.linked_at)
  into v_table_label
  from public.order_table_links l
  join public.dining_tables t on t.id=l.table_id
  where l.order_id=v_order.id;

  v_refund_amount:=v_invoice.total;

  if v_invoice.legacy_order_invoice then
    if v_order.payment_status<>'paid' or v_order.paid_total+0.005<v_order.total then
      raise exception 'La factura no está pagada al 100 %%';
    end if;

    insert into public.account_void_audit(
      restaurant_id,actor_user_id,authorization_request_id,order_ref,table_label,
      items,reason,amount_paid,refund_due,void_scope,order_id,invoice_number,comment
    )
    values(
      v_order.restaurant_id,v_user,v_req.id,v_order.id::text,v_table_label,
      v_items,v_req.reason,v_order.paid_total,v_order.paid_total,'paid',
      v_order.id,v_invoice.invoice_number,v_req.comment
    )
    returning id into v_audit_id;

    update public.order_items
    set status='cancelled',
        cancel_reason=v_req.reason,
        cancelled_by=v_user,
        cancelled_at=coalesce(cancelled_at,now())
    where order_id=v_order.id and status<>'cancelled';

    update public.orders
    set status='cancelled',
        refund_due=paid_total,
        account_void_reason=v_req.reason,
        account_voided_at=now(),
        account_void_audit_id=v_audit_id,
        account_void_scope='paid',
        invoice_voided_at=now(),
        fiscal_correction_required=true,
        closed_at=coalesce(closed_at,now()),
        closed_by=coalesce(closed_by,v_user)
    where id=v_order.id;

    update public.sales_invoices
    set status='voided',voided_at=now(),voided_by=v_user
    where id=v_invoice.id;
  else
    insert into public.account_void_audit(
      restaurant_id,actor_user_id,authorization_request_id,order_ref,table_label,
      items,reason,amount_paid,refund_due,void_scope,order_id,invoice_number,comment
    )
    values(
      v_order.restaurant_id,v_user,v_req.id,v_order.id::text,v_table_label,
      v_items,v_req.reason,v_invoice.total,v_invoice.total,'invoice',
      v_order.id,v_invoice.invoice_number,v_req.comment
    )
    returning id into v_audit_id;

    update public.sales_invoices
    set status='voided',voided_at=now(),voided_by=v_user
    where id=v_invoice.id;

    update public.orders
    set refund_due=coalesce(refund_due,0)+v_invoice.total,
        fiscal_correction_required=true,
        updated_at=now()
    where id=v_order.id;
  end if;

  update public.void_authorization_requests
  set status='used',attempts=attempts+1,used_by=v_user,used_at=now()
  where id=v_req.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_order.restaurant_id,v_user,'invoice',v_invoice.id,'invoice_voided',
    jsonb_build_object(
      'invoiceNumber',v_invoice.invoice_number,
      'legacyOrderInvoice',v_invoice.legacy_order_invoice,
      'reason',v_req.reason,
      'comment',v_req.comment,
      'refundDue',v_refund_amount,
      'authorizationRequestId',v_req.id,
      'auditId',v_audit_id
    )
  );

  return jsonb_build_object(
    'ok',true,
    'auditId',v_audit_id,
    'invoiceNumber',v_invoice.invoice_number,
    'refundDue',v_refund_amount,
    'orderRefundDue',case
      when v_invoice.legacy_order_invoice then v_order.paid_total
      else coalesce(v_order.refund_due,0)+v_invoice.total
    end,
    'legacyOrderInvoice',v_invoice.legacy_order_invoice
  );
end;
$function$;

create or replace function private.process_order_refund(
  p_order_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid:=(select auth.uid());
  v_order public.orders%rowtype;
  v_amount numeric(14,2):=round(coalesce(p_amount,0),2);
  v_method text:=lower(btrim(coalesce(p_method,'')));
  v_refund_id uuid;
  v_remaining numeric(14,2);
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;

  if not private.user_has_location_permission(v_order.location_id,'payments.create') then
    raise exception 'Not allowed to process refunds';
  end if;

  if coalesce(v_order.refund_due,0)<=0.005 then
    raise exception 'This order has no pending refund';
  end if;

  if v_order.account_voided_at is null
     and v_order.invoice_voided_at is null
     and not exists (
       select 1 from public.sales_invoices si
       where si.order_id=v_order.id and si.status='voided'
     ) then
    raise exception 'Refund is only allowed for a voided account or invoice';
  end if;

  if v_amount<=0 then raise exception 'Refund amount must be greater than zero'; end if;
  if v_amount>coalesce(v_order.refund_due,0)+0.005 then
    raise exception 'Refund amount exceeds pending refund';
  end if;

  if v_method not in ('cash','card','transfer','nequi','other') then
    raise exception 'Invalid refund method';
  end if;

  insert into public.order_refunds(
    restaurant_id,location_id,order_id,amount,method,reference,note,processed_by
  )
  values(
    v_order.restaurant_id,v_order.location_id,v_order.id,v_amount,v_method,
    nullif(btrim(coalesce(p_reference,'')),''),
    nullif(btrim(coalesce(p_note,'')),''),
    v_user
  )
  returning id into v_refund_id;

  v_remaining:=greatest(coalesce(v_order.refund_due,0)-v_amount,0);

  update public.orders
  set refund_due=v_remaining,updated_at=now()
  where id=v_order.id;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    v_order.restaurant_id,v_user,'order_refund',v_refund_id,'refund_processed',
    jsonb_build_object(
      'orderId',v_order.id,'orderNumber',v_order.order_number,
      'amount',v_amount,'method',v_method,
      'reference',nullif(btrim(coalesce(p_reference,'')),''),
      'remainingRefund',v_remaining
    )
  );

  return jsonb_build_object(
    'ok',true,'refund_id',v_refund_id,'order_id',v_order.id,
    'order_number',v_order.order_number,'amount',v_amount,'remaining_refund',v_remaining
  );
end;
$function$;
