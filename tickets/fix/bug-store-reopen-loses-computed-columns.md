---
description: A computed column saved to persistent storage comes back empty after the database is closed and reopened — the rule that computes it is silently thrown away, and every row written afterwards stores nothing in that column.
files:
  - packages/quereus/src/schema/ddl-generator.ts   # formatColumnDef (~497-540) — emits type, NULL, COLLATE, PRIMARY KEY, DEFAULT and tags; never emits GENERATED ALWAYS AS
  - packages/quereus/src/schema/column.ts          # ColumnSchema.generated (line 50), .generatedExpr (52), .generatedStored (54) — the three fields that are dropped
  - packages/quereus/src/schema/catalog.ts         # ~264 — where generateTableDDL produces the text the store persists
  - packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts  # the in-memory KV provider harness a repro/regression test should copy
repro: verified
difficulty: medium
---

# Persisted DDL never records `generated always as`, so computed columns vanish on reopen

## What goes wrong

A store-backed table's schema is persisted as generated `CREATE TABLE` text and re-parsed
when the database is reopened. The function that renders each column —
`formatColumnDef` in `packages/quereus/src/schema/ddl-generator.ts` — emits the column's
type, nullability, `COLLATE`, inline `PRIMARY KEY`, `DEFAULT` and tags. It has no branch
for `GENERATED ALWAYS AS` at all; the string `GENERATED` does not occur anywhere in the
file.

So a computed column round-trips as an ordinary nullable column. The rule that computed it
is gone, existing rows keep whatever value happened to be stored, and every row inserted
after the reopen leaves the column `null` — with no error at any point.

## Verified (in-process, `@quereus/store` over the in-memory KV provider, at `4af957d8`)

```
create table G (id integer primary key, a integer null,
                g integer null generated always as (a + 1)) using store
-- persist, close, fresh Database + StoreModule over the same provider, rehydrateCatalog

rehydrate errors: []                              <- no complaint
G columns after reopen: id(generated=false), a(generated=false), g(generated=false)
                                                  <- generatedExpr is gone entirely
insert into G (id, a) values (1, 5)               -> OK
select * from G                                   -> { id: 1, a: 5, g: null }
                                                  <- should be g = 6
```

No rename or ALTER is involved — a plain create / close / reopen is enough.

## Why this matters more than a missing feature

The failure is silent in both directions. Nothing rejects the `CREATE TABLE`, nothing warns
at persist time, and the rehydrate reports zero errors. A user who declares a computed
column on a persistent table gets correct behaviour for the whole first session and quietly
wrong data from the second one onward. The column also becomes writable by hand after the
reopen, so a subsequent write can put a value in it that the declared rule would never have
produced — leaving rows that disagree with each other about what the column means.

## Expected behaviour

- `generateTableDDL` renders a generated column faithfully, including whether it is
  `STORED` or `VIRTUAL`, so the re-parse reconstructs `generated`, `generatedExpr` and
  `generatedStored` as declared.
- A store-backed table with a computed column behaves identically before and after a
  close/reopen cycle: the same inserts produce the same computed values, and the column
  stays non-writable.
- If some part of the persistence path genuinely cannot support computed columns, the
  `CREATE TABLE` should be refused up front rather than accepted and silently degraded —
  but the round-trip is the outcome to aim for first.

## Scope notes for whoever picks this up

- The generator is shared: `generateTableDDL` also backs the catalog's canonical DDL and
  the schema differ's view of a table, so anything emitted here has to re-parse to the same
  schema it came from. Check what the differ makes of a generated column once the clause
  starts appearing, and whether `generateMaintainedTableDDL` needs the same treatment.
- `formatColumnDef` carries a `NOTE:` about emitting the flattened `logicalType.name`
  rather than `declaredType`. A generated column's rendered type interacts with that —
  worth reading before adding a branch.
- Independent of `bug-column-default-new-qualifier-invisible-to-column-rename`, but the two
  meet in the store's reopen tests: that ticket's store-leg test deliberately asserts on a
  column DEFAULT rather than a computed column, because a computed-column reopen assertion
  fails for the reason described here.
