-- RestOS+ paid invoice cancellation flow.
-- A paid invoice is never deleted: the original sale, payments and audit remain immutable.

create sequence if not exists private.invoice_number_seq;

create or replace function private.assign_invoice_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.payment_status = 'paid' and new.invoice_number is null then
    new.invoice_number := 'FAC-' || lpad(nextval('private.invoice_number_seq'::regclass)::text, 6, '0');
    new.invoice_issued_at := coalesce(new.invoice_issued_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists orders_assign_invoice_number on public.orders;
create trigger orders_assign_invoice_number
before insert or update of payment_status on public.orders
for each row execute function private.assign_invoice_number();

update public.orders
set invoice_number = 'FAC-' || lpad(nextval('private.invoice_number_seq'::regclass)::text, 6, '0'),
    invoice_issued_at = coalesce(invoice_issued_at, closed_at, now())
where payment_status = 'paid'
  and invoice_number is null;

create unique index if not exists orders_restaurant_invoice_number_uidx
  on public.orders (restaurant_id, upper(invoice_number))
  where invoice_number is not null;

alter table public.void_authorization_requests
  add column if not exists order_id uuid references public.orders(id) on delete restrict,
  add column if not exists invoice_number text,
  add column if not exists comment text;

alter table public.account_void_audit
  add column if not exists order_id uuid references public.orders(id) on delete restrict,
  add column if not exists invoice_number text,
  add column if not exists comment text;

create index if not exists void_authorization_requests_order_idx
  on public.void_authorization_requests(order_id, created_at desc);

create unique index if not exists void_authorization_one_pending_invoice_idx
  on public.void_authorization_requests(order_id)
  where status = 'pending' and line_ref = 'PAID_INVOICE';

create or replace function private.find_paid_invoice_for_void(
  p_restaurant_id uuid,
  p_invoice_number text,
  p_user_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_table_label text;
  v_items jsonb;
  v_payments jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.user_id = p_user_id
      and m.restaurant_id = p_restaurant_id
      and m.status = 'active'
      and rp.permission_code in ('payments.create', 'orders.account_void.paid')
  ) then
    raise exception 'No tienes permiso para solicitar la anulación de facturas';
  end if;

  select * into v_order
  from public.orders
  where restaurant_id = p_restaurant_id
    and upper(invoice_number) = upper(btrim(p_invoice_number))
  limit 1;

  if not found then raise exception 'No encontramos una factura con ese número'; end if;
  if v_order.account_voided_at is not null or v_order.invoice_voided_at is not null then
    raise exception 'Esta factura ya fue anulada';
  end if;
  if v_order.payment_status <> 'paid' or v_order.paid_total + 0.005 < v_order.total then
    raise exception 'La factura no está pagada al 100 %%';
  end if;

  select string_agg(coalesce(t.name, t.code), ' + ' order by l.is_primary desc, t.name)
  into v_table_label
  from public.order_table_links l
  join public.dining_tables t on t.id = l.table_id
  where l.order_id = v_order.id and l.unlinked_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'name', i.product_name,
    'quantity', i.quantity,
    'unitPrice', i.unit_price,
    'amount', i.line_total
  ) order by i.created_at), '[]'::jsonb)
  into v_items
  from public.order_items i
  where i.order_id = v_order.id and i.status <> 'cancelled';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'method', p.method,
    'amount', p.amount,
    'paidAt', p.paid_at,
    'reference', p.reference
  ) order by p.paid_at), '[]'::jsonb)
  into v_payments
  from public.payments p
  where p.order_id = v_order.id and p.status = 'completed';

  return jsonb_build_object(
    'orderId', v_order.id,
    'orderNumber', v_order.order_number,
    'invoiceNumber', v_order.invoice_number,
    'issuedAt', v_order.invoice_issued_at,
    'tableLabel', v_table_label,
    'subtotal', v_order.subtotal,
    'discountTotal', v_order.discount_total,
    'taxTotal', v_order.tax_total,
    'total', v_order.total,
    'paidTotal', v_order.paid_total,
    'items', v_items,
    'payments', v_payments
  );
end;
$$;

create or replace function public.find_paid_invoice_for_void(
  p_restaurant_id uuid,
  p_invoice_number text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.find_paid_invoice_for_void(p_restaurant_id, p_invoice_number, auth.uid());
$$;

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
set search_path = ''
as $$
declare
  v_invoice jsonb;
  v_request_id uuid;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'Invalid authorization code'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'El motivo es obligatorio'; end if;
  if length(btrim(coalesce(p_comment, ''))) < 5 then raise exception 'La observación es obligatoria'; end if;

  v_invoice := private.find_paid_invoice_for_void(p_restaurant_id, p_invoice_number, p_requested_by);

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    join public.profiles p on p.id = m.user_id
    where m.restaurant_id = p_restaurant_id
      and m.status = 'active'
      and rp.permission_code = 'orders.void.approve'
      and p.email is not null
  ) then
    raise exception 'No hay un owner activo con correo configurado';
  end if;

  update public.void_authorization_requests as var
  set status = 'cancelled'
  where var.order_id = (v_invoice->>'orderId')::uuid
    and var.line_ref = 'PAID_INVOICE'
    and var.status = 'pending';

  insert into public.void_authorization_requests(
    restaurant_id, requested_by, order_ref, line_ref, item_name, amount,
    reason, code_hash, expires_at, order_id, invoice_number, comment
  ) values (
    p_restaurant_id, p_requested_by, v_invoice->>'orderId', 'PAID_INVOICE',
    'Factura pagada completa', (v_invoice->>'paidTotal')::numeric,
    btrim(p_reason), extensions.crypt(p_code, extensions.gen_salt('bf', 8)),
    v_expires, (v_invoice->>'orderId')::uuid, v_invoice->>'invoiceNumber', btrim(p_comment)
  ) returning id into v_request_id;

  return query select
    v_request_id,
    v_expires,
    (v_invoice->>'orderId')::uuid,
    v_invoice->>'invoiceNumber',
    (v_invoice->>'orderNumber')::bigint,
    v_invoice->>'tableLabel',
    (v_invoice->>'paidTotal')::numeric,
    v_invoice->'items';
end;
$$;

create or replace function private.consume_invoice_void_authorization(
  p_request_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_req public.void_authorization_requests%rowtype;
  v_order public.orders%rowtype;
  v_audit_id uuid;
  v_items jsonb;
  v_table_label text;
  v_attempts integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_req
  from public.void_authorization_requests
  where id = p_request_id
  for update;

  if not found or v_req.line_ref <> 'PAID_INVOICE' then
    raise exception 'Solicitud de autorización no encontrada';
  end if;
  if v_req.requested_by <> v_user then raise exception 'La autorización pertenece a otro usuario'; end if;

  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.user_id = v_user
      and m.restaurant_id = v_req.restaurant_id
      and m.status = 'active'
      and rp.permission_code in ('payments.create', 'orders.account_void.paid')
  ) then
    raise exception 'No tienes permiso para anular esta factura';
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'message', 'La autorización ya no está activa');
  end if;
  if v_req.expires_at <= now() then
    update public.void_authorization_requests set status = 'expired' where id = v_req.id;
    return jsonb_build_object('ok', false, 'message', 'El código venció');
  end if;
  if v_req.attempts >= 5 then
    update public.void_authorization_requests set status = 'cancelled' where id = v_req.id;
    return jsonb_build_object('ok', false, 'message', 'El código fue bloqueado');
  end if;

  if extensions.crypt(p_code, v_req.code_hash) <> v_req.code_hash then
    v_attempts := v_req.attempts + 1;
    update public.void_authorization_requests
    set attempts = v_attempts,
        status = case when v_attempts >= 5 then 'cancelled' else status end
    where id = v_req.id;
    return jsonb_build_object(
      'ok', false,
      'message', case when v_attempts >= 5 then 'Código bloqueado después de cinco intentos' else 'Código incorrecto' end,
      'attemptsRemaining', greatest(0, 5 - v_attempts)
    );
  end if;

  select * into v_order from public.orders where id = v_req.order_id for update;
  if not found then raise exception 'La factura ya no existe'; end if;
  if v_order.invoice_number <> v_req.invoice_number then raise exception 'La autorización no corresponde a esta factura'; end if;
  if v_order.account_voided_at is not null or v_order.invoice_voided_at is not null then raise exception 'La factura ya fue anulada'; end if;
  if v_order.payment_status <> 'paid' or v_order.paid_total + 0.005 < v_order.total then
    raise exception 'La factura ya no está pagada al 100 %%';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'name', i.product_name,
    'quantity', i.quantity,
    'unitPrice', i.unit_price,
    'amount', i.line_total
  ) order by i.created_at), '[]'::jsonb)
  into v_items
  from public.order_items i
  where i.order_id = v_order.id and i.status <> 'cancelled';

  select string_agg(coalesce(t.name, t.code), ' + ' order by l.is_primary desc, t.name)
  into v_table_label
  from public.order_table_links l
  join public.dining_tables t on t.id = l.table_id
  where l.order_id = v_order.id and l.unlinked_at is null;

  insert into public.account_void_audit(
    restaurant_id, actor_user_id, authorization_request_id, order_ref, table_label,
    items, reason, amount_paid, refund_due, void_scope, order_id, invoice_number, comment
  ) values (
    v_order.restaurant_id, v_user, v_req.id, v_order.id::text, v_table_label,
    v_items, v_req.reason, v_order.paid_total, v_order.paid_total, 'paid',
    v_order.id, v_order.invoice_number, v_req.comment
  ) returning id into v_audit_id;

  update public.order_items
  set status = 'cancelled',
      cancel_reason = v_req.reason,
      cancelled_by = v_user,
      cancelled_at = coalesce(cancelled_at, now())
  where order_id = v_order.id and status <> 'cancelled';

  update public.orders
  set status = 'cancelled',
      refund_due = paid_total,
      account_void_reason = v_req.reason,
      account_voided_at = now(),
      account_void_audit_id = v_audit_id,
      account_void_scope = 'paid',
      invoice_voided_at = now(),
      fiscal_correction_required = true,
      closed_at = coalesce(closed_at, now()),
      closed_by = coalesce(closed_by, v_user)
  where id = v_order.id;

  update public.void_authorization_requests
  set status = 'used', attempts = attempts + 1, used_by = v_user, used_at = now()
  where id = v_req.id;

  insert into public.audit_logs(restaurant_id, actor_user_id, entity_type, entity_id, action, details)
  values (
    v_order.restaurant_id,
    v_user,
    'invoice',
    v_order.id,
    'invoice_voided',
    jsonb_build_object(
      'invoiceNumber', v_order.invoice_number,
      'reason', v_req.reason,
      'comment', v_req.comment,
      'refundDue', v_order.paid_total,
      'authorizationRequestId', v_req.id,
      'auditId', v_audit_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'auditId', v_audit_id,
    'invoiceNumber', v_order.invoice_number,
    'refundDue', v_order.paid_total
  );
end;
$$;

create or replace function public.consume_invoice_void_authorization(
  p_request_id uuid,
  p_code text
)
returns jsonb
language sql
set search_path = ''
as $$
  select private.consume_invoice_void_authorization(p_request_id, p_code);
$$;

drop function if exists public.get_account_void_email_internal(uuid);

create function public.get_account_void_email_internal(p_audit_id uuid)
returns table(
  restaurant_id uuid,
  order_ref text,
  table_label text,
  items jsonb,
  reason text,
  amount_paid numeric,
  refund_due numeric,
  actor_user_id uuid,
  actor_email text,
  invoice_number text,
  comment text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.restaurant_id, a.order_ref, a.table_label, a.items, a.reason,
         a.amount_paid, a.refund_due, a.actor_user_id, p.email,
         a.invoice_number, a.comment
  from public.account_void_audit a
  join public.profiles p on p.id = a.actor_user_id
  where a.id = p_audit_id;
$$;

revoke all on function public.find_paid_invoice_for_void(uuid, text) from public, anon;
grant execute on function public.find_paid_invoice_for_void(uuid, text) to authenticated;

revoke all on function public.consume_invoice_void_authorization(uuid, text) from public, anon;
grant execute on function public.consume_invoice_void_authorization(uuid, text) to authenticated;

revoke all on function public.create_invoice_void_authorization_internal(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_invoice_void_authorization_internal(uuid, uuid, text, text, text, text) to service_role;

revoke all on function public.get_account_void_email_internal(uuid) from public, anon, authenticated;
grant execute on function public.get_account_void_email_internal(uuid) to service_role;

-- Disable the former client-driven paid/partial account cancellation endpoint.
revoke all on function public.consume_account_void_authorization(uuid, text, text, text, jsonb, text, numeric) from public, anon, authenticated;
