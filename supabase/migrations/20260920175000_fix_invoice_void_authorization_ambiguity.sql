-- The function returns an `order_id` column, so qualify the table column used
-- to cancel an older pending request for the same invoice.
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

revoke all on function public.create_invoice_void_authorization_internal(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_invoice_void_authorization_internal(uuid, uuid, text, text, text, text)
  to service_role;
