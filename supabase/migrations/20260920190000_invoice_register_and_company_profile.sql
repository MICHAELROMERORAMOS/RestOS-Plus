create table if not exists public.company_profiles (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  legal_name text not null default '',
  trade_name text not null default '',
  nit text not null default '',
  verification_digit text not null default '',
  tax_regime text not null default '',
  tax_responsibilities text not null default '',
  address text not null default '',
  city text not null default '',
  department text not null default '',
  phone text not null default '',
  email text not null default '',
  logo_url text,
  invoice_prefix text not null default 'FAC',
  resolution_number text not null default '',
  resolution_date date,
  resolution_range_start bigint,
  resolution_range_end bigint,
  footer_text text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.company_profiles enable row level security;
create policy "company profile members can read" on public.company_profiles for select to authenticated
  using (exists (select 1 from public.memberships m where m.restaurant_id = company_profiles.restaurant_id and m.user_id = auth.uid() and m.status = 'active'));
create policy "company profile managers can write" on public.company_profiles for all to authenticated
  using (exists (select 1 from public.memberships m join public.role_permissions rp on rp.role_id = m.role_id where m.restaurant_id = company_profiles.restaurant_id and m.user_id = auth.uid() and m.status = 'active' and rp.permission_code = 'settings.manage'))
  with check (exists (select 1 from public.memberships m join public.role_permissions rp on rp.role_id = m.role_id where m.restaurant_id = company_profiles.restaurant_id and m.user_id = auth.uid() and m.status = 'active' and rp.permission_code = 'settings.manage'));

create or replace function public.list_paid_invoices(p_restaurant_id uuid, p_from date default null, p_to date default null, p_voided boolean default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from public.memberships m where m.restaurant_id=p_restaurant_id and m.user_id=auth.uid() and m.status='active') then raise exception 'No autorizado'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'invoiceNumber',q.invoice_number,'issuedAt',q.invoice_issued_at,'orderNumber',q.order_number,'subtotal',q.subtotal,'taxTotal',q.tax_total,'total',q.total,'paidTotal',q.paid_total,'voided',q.voided,'status',case when q.voided then 'voided' else 'valid' end,'items',q.items) order by q.invoice_issued_at desc),'[]'::jsonb) into result
  from (select o.id,o.invoice_number,o.invoice_issued_at,o.order_number,o.subtotal,o.tax_total,o.total,o.paid_total,(o.invoice_voided_at is not null) voided,(select coalesce(jsonb_agg(jsonb_build_object('name',i.product_name,'quantity',i.quantity,'unitPrice',i.unit_price,'taxRate',i.tax_rate,'amount',i.line_total) order by i.created_at),'[]'::jsonb) from public.order_items i where i.order_id=o.id) items from public.orders o where o.restaurant_id=p_restaurant_id and o.payment_status='paid' and o.invoice_number is not null
    and (p_from is null or o.invoice_issued_at::date >= p_from) and (p_to is null or o.invoice_issued_at::date <= p_to)
    and (p_voided is null or (o.invoice_voided_at is not null)=p_voided)) q;
  return result;
end; $$;
grant execute on function public.list_paid_invoices(uuid,date,date,boolean) to authenticated;
