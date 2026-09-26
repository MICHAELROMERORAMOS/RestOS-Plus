-- On-demand sales reports for the Reports screen.
create or replace function public.get_sales_report(p_location_id uuid,p_start_date date,p_end_date date)
returns jsonb language sql stable security invoker set search_path=''
as $$
with location_scope as (
 select l.id location_id,l.restaurant_id,coalesce(r.timezone,'Europe/Malta') timezone
 from public.locations l join public.restaurants r on r.id=l.restaurant_id
 where l.id=p_location_id and exists (
  select 1 from public.memberships m
  where m.restaurant_id=l.restaurant_id and m.user_id=auth.uid() and m.status='active'
 )
), paid_orders as (
 select o.*,coalesce(o.invoice_issued_at,o.closed_at,o.updated_at) report_at
 from public.orders o join location_scope s on s.location_id=o.location_id and s.restaurant_id=o.restaurant_id
 where o.payment_status='paid' and o.account_voided_at is null and o.invoice_voided_at is null
 and (coalesce(o.invoice_issued_at,o.closed_at,o.updated_at) at time zone s.timezone)::date between p_start_date and p_end_date
), summary as (
 select coalesce(sum(paid_total),0)::numeric sales,count(*)::int tickets,
 coalesce(avg(paid_total),0)::numeric average_ticket,coalesce(sum(refund_due),0)::numeric refunds from paid_orders
), top_products as (
 select oi.product_id,oi.product_name name,sum(oi.quantity)::numeric quantity,sum(oi.line_total)::numeric sales
 from public.order_items oi join paid_orders o on o.id=oi.order_id where oi.status<>'cancelled'
 group by oi.product_id,oi.product_name order by sum(oi.quantity) desc,sum(oi.line_total) desc,oi.product_name limit 10
), payment_methods as (
 select p.method,sum(p.amount)::numeric amount from public.payments p join paid_orders o on o.id=p.order_id
 where p.status='completed' group by p.method order by sum(p.amount) desc,p.method
), daily as (
 select (o.report_at at time zone s.timezone)::date day,sum(o.paid_total)::numeric sales,count(*)::int tickets
 from paid_orders o join location_scope s on true group by 1 order by 1
), hourly as (
 select extract(hour from (o.report_at at time zone s.timezone))::int hour,sum(o.paid_total)::numeric sales,count(*)::int tickets
 from paid_orders o join location_scope s on true group by 1 order by 1
)
select jsonb_build_object(
 'startDate',p_start_date,'endDate',p_end_date,'sales',(select sales from summary),
 'tickets',(select tickets from summary),'averageTicket',(select average_ticket from summary),
 'refunds',(select refunds from summary),
 'topProducts',coalesce((select jsonb_agg(to_jsonb(x)) from top_products x),'[]'::jsonb),
 'paymentMethods',coalesce((select jsonb_agg(to_jsonb(x)) from payment_methods x),'[]'::jsonb),
 'daily',coalesce((select jsonb_agg(to_jsonb(x)) from daily x),'[]'::jsonb),
 'hourly',coalesce((select jsonb_agg(to_jsonb(x)) from hourly x),'[]'::jsonb)
);
$$;
revoke all on function public.get_sales_report(uuid,date,date) from public;
revoke all on function public.get_sales_report(uuid,date,date) from anon;
grant execute on function public.get_sales_report(uuid,date,date) to authenticated;
create index if not exists idx_orders_location_paid_report on public.orders(location_id,payment_status,invoice_issued_at,closed_at) where payment_status='paid' and account_voided_at is null and invoice_voided_at is null;
create index if not exists idx_payments_order_completed on public.payments(order_id,method) where status='completed';
create index if not exists idx_order_items_order_active on public.order_items(order_id,product_id) where status<>'cancelled';
