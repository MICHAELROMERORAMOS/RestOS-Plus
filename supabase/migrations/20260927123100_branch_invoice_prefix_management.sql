create or replace function private.load_company_branches(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_result jsonb;
  v_can_manage boolean;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.view') then
    raise exception 'Not allowed to view branches';
  end if;

  v_can_manage:=private.user_has_restaurant_permission(p_restaurant_id,'branches.manage');

  select jsonb_build_object(
    'company',jsonb_build_object(
      'id',r.id,'name',r.name,'legalName',r.legal_name,'taxId',r.tax_id,
      'email',r.email,'phone',r.phone,'currencyCode',trim(r.currency_code::text),
      'timezone',r.timezone,'status',r.status,
      'joinCode',case when v_can_manage then r.join_code else null end
    ),
    'branches',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',l.id,'name',l.name,'code',l.code,
          'addressLine1',l.address_line1,'addressLine2',l.address_line2,
          'city',l.city,'country',l.country,'phone',l.phone,
          'active',l.active,'createdAt',l.created_at,'updatedAt',l.updated_at,
          'invoicePrefix',l.invoice_prefix,
          'nextInvoiceNumber',l.next_invoice_number,
          'nextInvoice','FAC-'||l.invoice_prefix||'-'||lpad(l.next_invoice_number::text,6,'0'),
          'invoicePrefixLocked',exists(
            select 1 from public.sales_invoices si where si.location_id=l.id
          ),
          'assignedUsers',(
            select count(distinct m.user_id)
            from public.memberships m
            where m.restaurant_id=l.restaurant_id
              and m.status='active'
              and (
                m.all_locations
                or exists(
                  select 1 from public.membership_locations ml
                  where ml.membership_id=m.id and ml.location_id=l.id
                )
              )
          ),
          'openOrders',(
            select count(*)
            from public.orders o
            where o.location_id=l.id
              and o.status not in ('closed','cancelled','merged')
          )
        )
        order by l.active desc,l.created_at,l.name
      )
      from public.locations l
      where l.restaurant_id=r.id
    ),'[]'::jsonb)
  )
  into v_result
  from public.restaurants r
  where r.id=p_restaurant_id
    and r.status='active';

  if v_result is null then raise exception 'Company not found'; end if;
  return v_result;
end;
$function$;

create or replace function private.set_branch_invoice_prefix(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_prefix text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_user uuid:=(select auth.uid());
  v_prefix text;
  v_location public.locations%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  if not private.user_has_restaurant_permission(p_restaurant_id,'branches.manage') then
    raise exception 'Not allowed to manage branches';
  end if;

  v_prefix:=private.normalize_invoice_prefix(p_prefix);
  if v_prefix='' then raise exception 'Invoice prefix is required'; end if;

  select * into v_location
  from public.locations l
  where l.id=p_location_id
    and l.restaurant_id=p_restaurant_id
  for update;

  if not found then raise exception 'Branch not found'; end if;

  if exists(
    select 1 from public.sales_invoices si
    where si.location_id=p_location_id
  ) then
    raise exception 'Invoice prefix is locked after the first invoice';
  end if;

  update public.locations
  set invoice_prefix=v_prefix,
      updated_at=now()
  where id=p_location_id
  returning * into v_location;

  insert into public.audit_logs(
    restaurant_id,actor_user_id,entity_type,entity_id,action,details
  )
  values(
    p_restaurant_id,v_user,'location',p_location_id,'invoice_prefix_updated',
    jsonb_build_object(
      'invoicePrefix',v_location.invoice_prefix,
      'nextInvoiceNumber',v_location.next_invoice_number
    )
  );

  return jsonb_build_object(
    'id',v_location.id,
    'invoicePrefix',v_location.invoice_prefix,
    'nextInvoiceNumber',v_location.next_invoice_number,
    'nextInvoice','FAC-'||v_location.invoice_prefix||'-'||lpad(v_location.next_invoice_number::text,6,'0')
  );
exception
  when unique_violation then
    raise exception 'Invoice prefix is already in use by another branch';
end;
$function$;

create or replace function public.set_branch_invoice_prefix(
  p_restaurant_id uuid,
  p_location_id uuid,
  p_prefix text
)
returns jsonb
language sql
set search_path=''
as $function$
  select private.set_branch_invoice_prefix(p_restaurant_id,p_location_id,p_prefix);
$function$;

revoke all on function public.set_branch_invoice_prefix(uuid,uuid,text) from public,anon;
grant execute on function public.set_branch_invoice_prefix(uuid,uuid,text) to authenticated;
