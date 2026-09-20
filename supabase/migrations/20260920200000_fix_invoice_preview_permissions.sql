-- Relax invoice preview location matching while retaining restaurant membership authorization.
create or replace function private.get_invoice_previews_v2(p_order_ids uuid[], p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_user_id is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.memberships m join public.orders o on o.restaurant_id=m.restaurant_id where o.id=any(p_order_ids) and m.user_id=p_user_id and m.status='active') then raise exception 'No tienes permiso para consultar estas facturas'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('orderId',q.id,'orderNumber',q.order_number,'invoiceNumber',q.invoice_number,'issuedAt',q.invoice_issued_at,'restaurantName',q.restaurant_name,'locationName',q.location_name,'tableLabel',q.table_label,'customerName',q.customer_name,'serviceMode',q.service_mode,'subtotal',q.subtotal,'discountTotal',q.discount_total,'taxTotal',q.tax_total,'total',q.total,'paidTotal',q.paid_total,'items',q.items,'payments',q.payments) order by q.invoice_issued_at desc),'[]'::jsonb) into result
 from (select o.id,o.order_number,o.invoice_number,o.invoice_issued_at,r.name restaurant_name,l.name location_name,o.customer_name,o.service_mode,o.subtotal,o.discount_total,o.tax_total,o.total,o.paid_total,
 (select string_agg(coalesce(t.name,t.code),' + ' order by otl.is_primary desc,t.name) from public.order_table_links otl join public.dining_tables t on t.id=otl.table_id where otl.order_id=o.id and otl.unlinked_at is null) table_label,
 (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.product_name,'quantity',i.quantity,'unitPrice',i.unit_price,'taxRate',i.tax_rate,'amount',i.line_total) order by i.created_at),'[]'::jsonb) from public.order_items i where i.order_id=o.id and i.status<>'cancelled') items,
 (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',p.payment_number,'method',p.method,'amount',p.amount,'paidAt',p.paid_at) order by p.paid_at),'[]'::jsonb) from public.payments p where p.order_id=o.id and p.status='completed') payments
 from public.orders o join public.restaurants r on r.id=o.restaurant_id join public.locations l on l.id=o.location_id where o.id=any(p_order_ids) and o.payment_status='paid' and o.invoice_number is not null and o.invoice_voided_at is null) q;
 return result;
end; $$;
create or replace function public.get_invoice_previews(p_order_ids uuid[]) returns jsonb language sql security invoker set search_path='' as $$ select private.get_invoice_previews_v2(p_order_ids,auth.uid()); $$;
grant execute on function private.get_invoice_previews_v2(uuid[],uuid) to authenticated;
revoke all on function public.get_invoice_previews(uuid[]) from public,anon;
grant execute on function public.get_invoice_previews(uuid[]) to authenticated;