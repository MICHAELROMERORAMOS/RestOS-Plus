-- Cover the foreign keys used by the invoice cancellation audit trail.
create index if not exists account_void_audit_order_id_idx
  on public.account_void_audit (order_id);

create index if not exists account_void_audit_actor_user_id_idx
  on public.account_void_audit (actor_user_id);

create index if not exists account_void_audit_authorization_request_id_idx
  on public.account_void_audit (authorization_request_id);
