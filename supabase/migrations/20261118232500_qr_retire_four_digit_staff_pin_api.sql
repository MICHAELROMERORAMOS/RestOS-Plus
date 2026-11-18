
-- The former per-table four-digit PIN management API is retired.
-- The database retains its internal compatibility field only to preserve
-- existing audited kitchen/inventory ordering logic, never as a customer code.
revoke all on function public.manage_qr_guest_session(uuid,text) from public,anon,authenticated;
