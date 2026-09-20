create or replace function private.get_invoice_previews(p_order_ids uuid[], p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_result jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then return '[]'::jsonb; end if;

  if exists (
    select 1
    from public.orders o
    join public.locations l on l.id = o.location_id and l.active = true
    where o.id = any(p_order_ids)
      and not exists (
        select 1
        from public.memberships m
        join public.role_permissions rp
          on rp.role_id = m.role_id and rp.permission_code = 'payments.create'
        where m.user_id = p_user_id
          and m.restaurant_id = o.restaurant_id
          and m.status = 'active'
          and (
            m.all_locations
            or exists (
              select 1 from public.membership_locations ml
              where ml.membership_id = m.id and ml.location_id = o.location_id
            )
          )
      )
  ) then raise exception 'No tienes permiso para consultar estas facturas'; end if;

  select coalesce(jsonb_agg(invoice_data order by invoice_data->>'invoiceNumber'), '[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object(
      'orderId', o.id, 'orderNumber', o.order_number,
      'invoiceNumber', o.invoice_number, 'issuedAt', o.invoice_issued_at,
      'restaurantName', r.name, 'locationName', l.name,
      'tableLabel', (
        select string_agg(coalesce(t.name, t.code), ' + ' order by otl.is_primary desc, t.name)
        from public.order_table_links otl join public.dining_tables t on t.id = otl.table_id
        where otl.order_id = o.id and otl.unlinked_at is null
      ),
      'customerName', o.customer_name, 'serviceMode', o.service_mode,
      'subtotal', o.subtotal, 'discountTotal', o.discount_total,
      'taxTotal', o.tax_total, 'total', o.total, 'paidTotal', o.paid_total,
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', i.id, 'name', i.product_name, 'quantity', i.quantity,
          'unitPrice', i.unit_price, 'taxRate', i.tax_rate, 'amount', i.line_total
        ) order by i.created_at), '[]'::jsonb)
        from public.order_items i where i.order_id = o.id and i.status <> 'cancelled'
      ),
      'payments', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'number', p.payment_number, 'method', p.method,
          'amount', p.amount, 'paidAt', p.paid_at
        ) order by p.paid_at), '[]'::jsonb)
        from public.payments p where p.order_id = o.id and p.status = 'completed'
      )
    ) as invoice_data
    from public.orders o
    join public.restaurants r on r.id = o.restaurant_id
    join public.locations l on l.id = o.location_id
    where o.id = any(p_order_ids)
      and o.payment_status = 'paid'
      and o.invoice_number is not null
      and o.invoice_voided_at is null
  ) invoices;
  return v_result;
end;
$$;

create or replace function public.get_invoice_previews(p_order_ids uuid[])
returns jsonb language sql set search_path = ''
as $$ select private.get_invoice_previews(p_order_ids, auth.uid()); $$;

revoke all on function private.get_invoice_previews(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.get_invoice_previews(uuid[]) from public, anon;
grant execute on function public.get_invoice_previews(uuid[]) to authenticated;
