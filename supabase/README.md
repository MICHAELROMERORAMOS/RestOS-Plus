# Supabase directory

`migrations/0001_restos_baseline.sql` is a reproducible baseline of the RestOS+ database architecture used during the frontend migration.

The **current live RestOS+ project already contains this schema**, so do not blindly run the baseline against that existing database. It is intended for a fresh environment, disaster reconstruction or a future clean migration workflow.

The live project also received a normalization migration so profile and membership authorization states use:

```text
pending | active | rejected | suspended
```

The frontend expects `active` for access.

Future schema changes should be added as new migrations rather than editing an already-applied migration once a formal Supabase CLI deployment flow is established.

For profile self-service, `authenticated` receives column-level UPDATE permission only for `full_name`, `phone`, `username` and `avatar_url`. Authorization fields such as `access_status` are deliberately not self-editable.
