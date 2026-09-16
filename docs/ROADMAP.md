# RestOS+ implementation roadmap

## Phase 1 — completed foundation

- Single HTML prototype preserved as legacy reference.
- React/Vite application structure.
- Responsive application shell and all agreed modules.
- Full demo order lifecycle with persistent local state.
- Table and quick/prepaid service modes.
- Multi-round comandas.
- Independent Kitchen and Bar states.
- Partial/full payment model.
- Supabase Auth client flows.
- Pending approval model.
- Role presets and permission-aware navigation.
- Multi-restaurant/multi-location database baseline.

## Phase 2 — access administration

Build `Personal -> Solicitudes de acceso` against Supabase:

- pending user list
- approve/reject/suspend
- restaurant selection
- location scope
- role assignment
- audit log
- RLS for staff administration

## Phase 3 — catalog and floor data

Move demo sources to Supabase:

- locations / dining zones / tables
- categories / products
- modifiers
- station routing
- restaurant settings

Keep a seed/demo command for development rather than hard-coding production data.

## Phase 4 — real ordering

Move the operational order domain to Supabase:

- create/open order
- table links
- draft round
- atomic send-to-preparation transaction
- sent-item void authorization
- transfer/join tables
- Realtime subscriptions for floor/KDS
- order event audit trail

A transaction/RPC should be preferred for operations that must change several related rows atomically.

## Phase 5 — KDS and cashier

- Kitchen/Bar Realtime queues
- preparation timestamps
- ready notifications
- payments
- split bill / item allocations
- cash drawer shifts and reconciliation
- receipt printing integration

## Phase 6 — inventory and purchasing

- recipes/BOM
- automatic stock consumption on sale
- movements and waste
- suppliers
- purchase orders and receiving
- stock counts and variance reports

## Phase 7 — reservations, customers and reporting

- customer history and loyalty foundation
- reservations linked to floor availability
- financial/operational reports
- public TV/queue display
- exports and scheduled reports

## Production hardening

Before production launch:

- complete RLS for every exposed operational table
- add server-side privileged workflows where required
- configure custom SMTP
- configure final HTTPS domain and exact Auth redirects
- enable CAPTCHA/rate-limit review
- remove/disable design mode in production build
- add automated tests and CI
- add error monitoring and backup/recovery procedures
