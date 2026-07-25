----
description: The new opt-in "strict" mode that blocks schema changes inside a transaction has a hole — it does not cover creating, dropping, or refreshing a materialized view, so those still slip through.
prereq: feat-ddl-transaction-capability
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts   # emitCreateMaterializedView / emitDropMaterializedView / emitRefreshMaterializedView
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts  # assertDdlTransactionPolicy helper to call
----

# Extend the strict DDL-transaction gate to materialized-view statements

## Background

`feat-ddl-transaction-capability` added an opt-in `ddl_transaction_policy = 'strict'`
option. When set, a schema-changing statement that dispatches to a storage module is
refused if it runs inside an explicit `BEGIN … COMMIT` block on a module that cannot roll
schema changes back (which is every built-in module today). The point is to stop schema
changes from silently escaping the surrounding transaction.

That gate was wired into the plain DDL statements: `CREATE TABLE`, `DROP TABLE`,
`CREATE INDEX`, `DROP INDEX`, and every `ALTER TABLE` form (including `ADD CONSTRAINT`).

## The gap

The dedicated materialized-view statements are **not** gated:

- `CREATE MATERIALIZED VIEW …`
- `DROP MATERIALIZED VIEW …`
- `REFRESH MATERIALIZED VIEW …`

A materialized view is backed by a real module (memory or store) table, so creating or
dropping one is a schema change that escapes the transaction exactly like `CREATE TABLE`
does. Under `strict`, running one of these inside an explicit transaction is currently
allowed, which is the very thing strict mode promises to prevent. So strict has a hole for
materialized views.

This only matters to someone who has explicitly turned strict mode on *and* issues
materialized-view DDL inside an explicit transaction — a narrow, brand-new opt-in surface
with no existing callers — which is why it is filed as debt rather than a live bug.

## What to do

Call the existing `assertDdlTransactionPolicy(db, module, moduleName, statementLabel)`
helper at the top of each materialized-view emitter's `run()`, before `_ensureTransaction()`
and before any catalog mutation — mirroring the plain DDL emitters. Resolve the owning
module the same way the create/drop-table emitters do (by name for create, from the
resolved maintained-table schema for drop/refresh). A greppable `NOTE:` marker already sits
at `emitCreateMaterializedView` pointing here.

Decide whether `REFRESH` should gate at all: it rewrites backing rows rather than the
catalog shape, so it is closer to DML than DDL. If refresh is deliberately excluded, say so
in a code comment instead of gating it.

## Tests

Extend `test/logic/10.1.4-ddl-transaction-policy.sqllogic` (or a sibling): under `strict`,
`create materialized view` / `drop materialized view` inside `begin` are refused and the
transaction survives; outside a transaction they succeed; permissive default is unchanged.
