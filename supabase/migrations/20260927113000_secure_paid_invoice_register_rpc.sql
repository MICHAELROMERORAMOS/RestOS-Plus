alter function public.list_paid_invoices(uuid,date,date,boolean) security definer;
alter function public.list_paid_invoices(uuid,date,date,boolean) set search_path = '';

revoke all on function public.list_paid_invoices(uuid,date,date,boolean) from public, anon;
grant execute on function public.list_paid_invoices(uuid,date,date,boolean) to authenticated;
