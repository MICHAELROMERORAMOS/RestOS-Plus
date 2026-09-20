-- Include the order origin and customer/table details in the internal invoice register.
create or replace function public.list_paid_invoices(
  p_restaurant_id uuid,
  p_from date default null,
  p_to date default null,
  p_voided boolean default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not exists (
    select 1
    from public.memberships m
    where m.restaurant_id = p_restaurant_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  ) then
    raise exception 'No autorizado';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'invoiceNumber', q.invoice_number,
        'issuedAt', q.invoice_issued_at,
        'orderNumber', q.order_number,
        'subtotal', q.subtotal,
        'taxTotal', q.tax_total,
        'total', q.total,
        'paidTotal', q.paid_total,
        'voided', q.voided,
        'status', case when q.voided then 'voided' else 'valid' end,
        'serviceMode', q.service_mode,
        'serviceLabel', q.service_label,
        'tableIds', q.table_ids,
        'tables', q.tables,
        'customer', q.customer,
        'delivery', q.delivery,
        'items', q.items
      )
      order by q.invoice_issued_at desc
    ),
    '[]'::jsonb
  ) into result
  from (
    select
      o.id,
      o.invoice_number,
      o.invoice_issued_at,
      o.order_number,
      o.subtotal,
      o.tax_total,
      o.total,
      o.paid_total,
      (o.invoice_voided_at is not null) as voided,
      case when o.service_mode = 'counter' then 'quick' else o.service_mode end as service_mode,
      case
        when o.service_mode = 'table' then 'Mesa'
        when o.service_mode = 'counter' then 'Servicio rÃ¡pido'
        when o.service_mode = 'delivery' then 'Domicilio'
        else coalesce(o.service_mode, 'Pedido')
      end as service_label,
      coalesce(
        (
          select jsonb_agg(to_jsonb(otl.table_id) order by otl.linked_at)
          from public.order_table_links otl
          where otl.order_id = o.id
        ),
        '[]'::jsonb
      ) as table_ids,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', dt.id,
              'code', dt.code,
              'name', coalesce(nullif(dt.name, ''), dt.code)
            ) order by otl.linked_at
          )
          from public.order_table_links otl
          join public.dining_tables dt on dt.id = otl.table_id
          where otl.order_id = o.id
        ),
        '[]'::jsonb
      ) as tables,
      case
        when o.customer_id is not null or o.customer_name is not null then jsonb_build_object(
          'id', o.customer_id,
          'name', coalesce(nullif(o.customer_name, ''), c.full_name),
          'phone', c.phone,
          'email', c.email
        )
        else null
      end as customer,
      o.delivery_details as delivery,
      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'name', i.product_name,
              'quantity', i.quantity,
              'unitPrice', i.unit_price,
              'taxRate', i.tax_rate,
              'amount', i.line_total
            ) order by i.created_at
          ),
          '[]'::jsonb
        )
        from public.order_items i
        where i.order_id = o.id
      ) as items
    from public.orders o
    left join public.customers c on c.id = o.customer_id
    where o.restaurant_id = p_restaurant_id
      and o.payment_status = 'paid'
      and o.invoice_number is not null
      and (p_from is null or o.invoice_issued_at::date >= p_from)
      and (p_to is null or o.invoice_issued_at::date <= p_to)
      and (p_voided is null or (o.invoice_voided_at is not null) = p_voided)
  ) q;

  return result;
end;
$$;

grant execute on function public.list_paid_invoices(uuid, date, date, boolean) to authenticated;
