create index if not exists item_void_audit_actor_user_idx
  on public.item_void_audit (actor_user_id);

create index if not exists item_void_audit_authorization_request_idx
  on public.item_void_audit (authorization_request_id);

create index if not exists kitchen_void_requests_reviewed_by_idx
  on public.kitchen_void_requests (reviewed_by);

create index if not exists order_allergy_audit_restaurant_idx
  on public.order_allergy_audit (restaurant_id);

create index if not exists order_allergy_subtypes_allergen_idx
  on public.order_allergy_subtypes (allergen_id);

create index if not exists order_allergy_subtypes_subtype_idx
  on public.order_allergy_subtypes (subtype_id);

create index if not exists role_preset_permissions_permission_code_idx
  on public.role_preset_permissions (permission_code);

create index if not exists sales_invoices_created_by_idx
  on public.sales_invoices (created_by);

create index if not exists sales_invoices_voided_by_idx
  on public.sales_invoices (voided_by);

create index if not exists void_authorization_requests_used_by_idx
  on public.void_authorization_requests (used_by);
