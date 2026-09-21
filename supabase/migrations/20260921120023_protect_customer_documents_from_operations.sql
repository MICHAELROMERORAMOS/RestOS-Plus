-- Delivery and order creators may search a customer by phone, but identification
-- data is only returned to billing, customer-management and reporting roles.
create or replace function private.find_customer_by_phone_impl(
  p_restaurant_id uuid,
  p_phone text
)
returns setof public.customers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_customer_phone(p_phone);
  v_customer public.customers%rowtype;
  v_can_read_documents boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not (
    private.user_has_restaurant_permission(p_restaurant_id, 'customers.view')
    or private.user_has_restaurant_permission(p_restaurant_id, 'customers.manage')
    or private.user_has_restaurant_permission(p_restaurant_id, 'orders.create')
  ) then
    raise exception 'Not authorized to search customers for this restaurant';
  end if;

  if v_phone is null then
    return;
  end if;

  select c.*
  into v_customer
  from public.customers c
  where c.restaurant_id = p_restaurant_id
    and c.phone_normalized = v_phone
    and c.active = true
  limit 1;

  if not found then
    return;
  end if;

  v_can_read_documents :=
    private.user_has_restaurant_permission(p_restaurant_id, 'customers.view')
    or private.user_has_restaurant_permission(p_restaurant_id, 'customers.manage')
    or private.user_has_restaurant_permission(p_restaurant_id, 'payments.view')
    or private.user_has_restaurant_permission(p_restaurant_id, 'payments.create')
    or private.user_has_restaurant_permission(p_restaurant_id, 'reports.view');

  if not v_can_read_documents then
    v_customer.document_type := null;
    v_customer.document_number := null;
    v_customer.document_number_normalized := null;
  end if;

  return next v_customer;
  return;
end;
$$;

revoke all on function private.find_customer_by_phone_impl(uuid, text) from public, anon;
grant execute on function private.find_customer_by_phone_impl(uuid, text) to authenticated, service_role;
