# RestOS+ architecture

## Core domain model

RestOS+ separates the restaurant account from each preparation send:

- **Order / pedido**: the complete account/tab. In table service it stays open while the table is occupied and can receive many later sends.
- **Round / comanda**: one batch of new products submitted to preparation.
- **Order item**: one product line inside a round.
- **Preparation station**: Kitchen, Bar and future stations such as Dessert or Coffee.
- **Payment**: independent transaction; several payments may be allocated to one order.

This separation is intentional. Pressing **Enviar** never closes the account and never resends previous products.

## Table-service lifecycle

```text
Free table
  -> open account
  -> add draft items
  -> send round 1
  -> Kitchen / Bar preparation
  -> add later draft items
  -> send round 2
  -> ...
  -> partial or full payment
  -> close account
  -> release table
```

Draft items can be edited or removed. Once sent, an item becomes immutable for normal editing. If it must be withdrawn, RestOS+ records a void/cancellation event rather than deleting history.

## Quick-service lifecycle

```text
New quick order
  -> add items
  -> identify by order number / turn / pager / customer name
  -> collect payment
  -> send to preparation
  -> ready
  -> delivered / collected
```

The demo implementation enforces the key rule: quick-service products cannot be sent before payment.

## Preparation state

Preparation status is tracked per item rather than globally on the whole order. This allows the same comanda to contain, for example, two drinks routed to Bar and one burger routed to Kitchen.

Typical item lifecycle:

```text
new -> preparing -> ready -> delivered
                     \
                      -> cancelled/voided (authorized flow)
```

Kitchen and Bar update only their own items.

## Payments

Payments are append-only operational records. RestOS+ supports partial payment in the frontend model, and the database contains `payments` plus `payment_allocations` for future item-level split bills.

A table is released only when the account is considered closed. Preparation data remains available to KDS even when a prepaid order is already financially closed.

## Authentication and authorization

Identity and authorization are different concerns:

```text
Supabase Auth identity
  -> public.profiles
  -> profile access_status
  -> membership
  -> restaurant
  -> optional location scope
  -> role
  -> role_permissions
  -> RLS + UI permissions
```

New identities are created as `pending`. The supported profile/membership workflow is:

```text
pending -> active
        -> rejected
active  -> suspended
```

Verifying an email or authenticating through Google does **not** make a user active.

## Seven initial role presets

- Owner / Super Admin
- Manager / Supervisor
- Waiter / Mesero
- Cashier / Caja
- Kitchen / Cocina
- Bar
- Inventory / Store

These are presets. A restaurant can later receive its own role rows and customize permissions without changing another restaurant.

## Multi-restaurant / multi-location boundaries

Operational records are scoped through `restaurant_id` and, where relevant, `location_id`. A user receives access through a membership and can either have all locations or explicit rows in `membership_locations`.

No frontend filter should ever be trusted as the security boundary. Production protection belongs in PostgreSQL RLS policies.

## Frontend state during migration

The frontend still uses a `RestaurantContext` local demo adapter for operational data. This is deliberate: it allows the full UX to remain testable while real repositories/RLS are implemented module by module.

The intended future service boundaries are:

```text
authService
orderService
kdsService
paymentService
catalogService
inventoryService
reservationService
staffService
reportingService
```

The React pages should consume these services through contexts/hooks rather than issuing arbitrary Supabase queries directly from presentational components.
