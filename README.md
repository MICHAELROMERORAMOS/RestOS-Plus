# RestOS+

Restaurant operating system / POS prototype migrated from the original single-file HTML into a maintainable React + Vite application prepared for Supabase.

## What is included

RestOS+ currently preserves the complete functional scope agreed during the prototype phase:

- Authentication shell: email/password login, registration, email OTP verification, password recovery, Google OAuth entry point, pending approval state and design/demo mode.
- Role-aware navigation using restaurant permissions.
- Dashboard with operational KPIs, table status and activity.
- Visual table/floor workflow.
- Table-service ordering with open tabs and multiple rounds/comandas.
- Quick-service/prepaid ordering with order/turn/pager identifiers.
- Draft items editable before send; sent items locked and voided through an explicit action rather than deleted.
- Independent Kitchen and Bar preparation states.
- Cashier with partial/full payments and account closure.
- Order history.
- Inventory, products, customers, reservations, staff/roles, reports, TV/public display and restaurant settings modules.
- Local demo persistence for development before all production RLS policies and data services are connected.
- Supabase schema baseline and setup documentation.
- A legacy snapshot of the original HTML under `legacy/restaurant_app.html`.

## Stack

- React 19
- Vite 8
- Supabase JavaScript SDK
- Plain CSS retained from the prototype and progressively componentized

## Development

Requirements: Node.js 22+ is recommended for the current Vite toolchain.

```bash
npm install
cp .env.example .env
npm run dev
```

Open the local Vite URL, normally `http://localhost:5173`.

If Supabase Auth has not been configured yet, use **Entrar en modo diseño**. The application remains fully navigable and operational with local demo data.

## Environment variables

Only public browser-safe Supabase values belong in the frontend:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Never put a Supabase secret/service-role key in this repository or in a Vite `VITE_*` variable.

## Project structure

```text
src/
  components/layout/      Shared application shell
  config/                 Navigation and role presets
  context/                Auth and restaurant/demo state
  data/                   Demo catalog and initial state
  features/auth/          Login/register/recovery UI
  lib/                    Supabase client and helpers
  pages/                  Restaurant modules
  services/               Supabase-facing services
  styles/                 Global migrated styles
supabase/
  migrations/             Reproducible database baseline
legacy/
  restaurant_app.html     Original prototype snapshot
docs/
  ARCHITECTURE.md
  SUPABASE_SETUP.md
  ROADMAP.md
```

## Data strategy

The application deliberately has two modes while development continues:

1. **Design/demo mode** uses localStorage so every screen and the end-to-end restaurant workflow can be tested without backend configuration.
2. **Supabase mode** already handles authentication and permission bootstrap. Operational modules will be moved from demo persistence to repository/service functions incrementally, without changing the UI domain model.

See `docs/ARCHITECTURE.md` for the domain model and `docs/SUPABASE_SETUP.md` for the exact Auth configuration still required in the Supabase dashboard.

## Security model

Registration does not grant restaurant access. A verified user remains `pending` until an administrator assigns an active membership and role. Authorization is modeled using restaurant memberships, roles, permissions and RLS; UI hiding is only a convenience and is not considered a security boundary.

## Current Supabase project

The development project is **RestOS+**. The repository stores only its public project URL/publishable key template. Sensitive credentials must remain outside Git.
