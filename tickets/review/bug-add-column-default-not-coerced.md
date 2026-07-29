---
description: When you add a new column to an existing table and give it a default value, the rows that were already there stored that default as raw text instead of converting it to the column's declared type. Fixed — backfilled rows now hold the same value a fresh insert would.
files:
  - packages/quereus/src/types/validation.ts                        # new foldDefaultToType helper
  - packages/quereus/src/types/index.ts                             # re-export
  - packages/quereus/src/index.ts                                   # public re-export
  - packages/quereus/src/planner/building/alter-table.ts            # buildAddColumnBackfill — computes coerceTo
  - packages/quereus/src/planner/nodes/alter-table-node.ts          # AddColumnBackfill.coerceTo
  - packages/quereus/src/runtime/emit/alter-table.ts                # foldedDefault, backfillEvaluator, alterColumnEventValueRemap
  - packages/quereus/src/vtab/memory/layer/manager.ts               # addColumn literal fold
  - packages/quereus/src/vtab/memory/layer/alter-column.ts          # planTightenNotNull
  - packages/quereus-store/src/common/store-module-alter.ts         # alterAddColumn literal fold
  - packages/quereus-store/src/common/store-module-alter-column.ts  # alterColumnSetNotNull
  - packages/quereus-isolation/src/alter-migration.ts               # deriveAddColumnBackfill, deriveSetNotNullBackfill
  - packages/quereus/test/logic/41.12-alter-default-coercion.sqllogic  # new sqllogic (memory + store)
  - packages/quereus/test/type-system.spec.ts                       # foldDefaultToType unit tests
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # overlay/store agreement tests
  - docs/types.md                                                   # "Where coercion happens" — ALTER backfill paragraph
  - docs/sql-ddl.md                                                 # ADD COLUMN / SET NOT NULL bullets
difficulty: medium
---

# What was wrong

Every ordinary write converted each cell to its column's declared logical type before
storage. The ALTER backfill paths did not: they took the DEFAULT expression from the
AST, folded it to a literal, and stored that literal raw. So an old row and a new row
under the *same* default held different-looking values:

```sql
alter table t add column n integer default '7';
insert into t (a, b) values (2, 20);
-- backfilled row: n = '7'  (text)
-- inserted row:   n = 7    (integer)
```

Eight independent sites did this, and they all agreed *with each other* on the wrong
value, so nothing caught it.

# What changed

## One shared helper

`foldDefaultToType(expr, logicalType, columnName)` in
`packages/quereus/src/types/validation.ts`, re-exported from `types/index.ts` and the
package root (the store and isolation packages import it from `@quereus/quereus`).
It folds a DEFAULT expression to a literal via the existing `tryFoldLiteral` **and**
runs `validateAndParse` against the column's declared type. Returns `undefined` when
the expression does not fold (the caller's per-row evaluator path owns that),
`null` when it folds to NULL, and throws `MISMATCH` when the literal cannot convert —
with the same message text the INSERT path produces.

All eight sites now route through it: memory `addColumn`, store `alterAddColumn`,
isolation `deriveAddColumnBackfill`, the emitter's `foldedDefault` (batched
data-change events), memory `planTightenNotNull`, store `alterColumnSetNotNull`,
isolation `deriveSetNotNullBackfill`, and the emitter's `alterColumnEventValueRemap`.

## The evaluator path carries an identity guard

`AddColumnBackfill` gained `coerceTo?: LogicalType`, set in `buildAddColumnBackfill`
only when the default expression's static `logicalType` is **not** (by object
identity) the new column's type. `runAddColumn`'s `backfillEvaluator` converts via
`validateAndParse` when it is set, **before** the per-row CHECK predicates see the
value — matching `emitInsert`, which coerces at the top of the DML pipeline.

The guard is not optional. `add column k json default (new.j)` over a column that is
already `json` was **already correct** before this fix, because the raw copy happened
to be right. A blanket coercion would break it: JSON's `parse` reads a plain JS string
as JSON *source*, so re-parsing stored `abc` throws and stored `9` silently becomes
the number 9. This mirrors the identity skip `buildRowCoercion` already makes.

## Two deliberate behavior changes

**1. An unconvertible literal DEFAULT now rejects the ALTER** (this was the decision
recorded in the implement ticket). `alter table u add column n integer default 'abc'`
used to be accepted and store the text `'abc'`; it now fails with `MISMATCH`, the same
error the equivalent INSERT gives, **whether or not the table has rows**. Rationale:
DDL acceptance that depends on how many rows happen to be present is more surprising
than a uniform rejection.

**2. The same uniform rule was extended to `alter column … set not null`.** This one
was *not* spelled out in the implement ticket and the reviewer should weigh it. The
three legs folded the DEFAULT at different points relative to their NULL scan — memory
after, store and isolation before — so a straight in-place substitution would have made
memory reject an unconvertible default only when the table held a NULL while store and
isolation rejected it unconditionally. I made all three eager (memory's fold moved
above its `hasNullValue` scan) so the legs cannot disagree.

The cost: `alter column b set not null` on a column with a pre-existing unconvertible
DEFAULT (e.g. `b integer default 'abc'`, which `CREATE TABLE` still accepts) now fails
with `MISMATCH` even when the column holds no NULLs and the default would never have
been used. The alternative — make all three lazy — preserves that acceptance but needs
real plumbing in the isolation layer: its context is derived once, before the underlying
mutation, and the conversion would have to be deferred into `validateOverlayMigration`
to keep the throw pre-mutation and atomic. I chose the smaller, uniform option. **If the
reviewer prefers laziness, that is the change to make, and it is isolated to
`deriveSetNotNullBackfill` + `validateOverlayMigration` + the two underlyings' fold
placement.**

## Adjacent inconsistency fixed

`store-module-alter-column.ts` `alterColumnSetNotNull` detected its literal DEFAULT
with a hand-rolled `expr.type === 'literal'` check, so a signed numeric default
(`default -5`, a `UnaryExpr` in the AST) was invisible to the store and the ALTER
rejected where the memory module backfilled. It now goes through the shared helper
like the other seven.

# Use cases for testing / validation

## New sqllogic — `packages/quereus/test/logic/41.12-alter-default-coercion.sqllogic`

Runs under both the memory module (`yarn test`) and the store module
(`yarn test:store`); assertions read back through `typeof(...)`, which is
module-agnostic. Sections:

1. **Literal default, type mismatch** — `add column n integer default '7'`; the
   backfilled row and a row inserted *after* the ALTER (same default applies) must
   agree on value and `typeof`. Plus a signed-numeric `default -123.0` on a REAL column
   (a `UnaryExpr`, exercising the `tryFoldLiteral` unary branch).
2. **Literal default on a JSON column** — `default '"abc"'` must store the parsed
   scalar `abc`, not the raw source text `'"abc"'`.
3. **Per-row `new.<col>` evaluator across types** — `add column n integer default
   (new.b)` where `b` is `text`.
4. **Identity regression guard** — `add column k json default (new.j)` over an existing
   `json` column must leave `'abc'` and `9` untouched. This is the case a blanket
   coercion breaks; it is the reason `coerceTo` exists.
5. **`alter column … set not null`** with a mismatched literal DEFAULT backfills the
   converted value, and matches what a later insert under the same DEFAULT stores.
6. **Unconvertible literal rejects** — on a non-empty table (asserting the column was
   *not* added) and on an empty one.

## Unit — `packages/quereus/test/type-system.spec.ts` (`describe('foldDefaultToType')`)

Missing default → `undefined`; `new.<col>` → `undefined`; `default null` → `null`;
`'7'` on INTEGER → `7`; `'"abc"'` on JSON → `'abc'`; `-123.0` on REAL → `-123`;
`'abc'` on INTEGER → throws `QuereusError` with code `MISMATCH` and the message
`Type conversion failed for column 'n'`.

## Isolation — `packages/quereus-isolation/test/isolation-layer.spec.ts`

Two tests in the savepoint/ALTER describe. The overlay writes staged rows with
`preCoerced: true`, so it can *never* pick the conversion up implicitly — these pin
that the overlay and the committed store agree on the **converted** value:

- `ADD COLUMN converts the literal DEFAULT for staged rows, before and after commit` —
  a committed row and a staged row, `add column n integer default '7'` inside the
  transaction, read back pre-commit and post-commit; both must be integer `7`.
- `SET NOT NULL converts the literal DEFAULT when backfilling a staged NULL`.

## Regression surface already covered elsewhere (re-run, still green)

- `03.4-defaults.sqllogic` — the ADD COLUMN NOT NULL per-row backfill rejection
  (`add column doubled integer not null default (new.base * 2)` over a NULL row).
  Confirms the `base.ts` `recreatePrimaryTreeWithNewColumn` NOT NULL check still
  fires: converting `null` yields `null`, so the check is unaffected.
- `15.1.1-json-check-coercion.sqllogic` — JSON default + CHECK coercion.
- `41.8-alter-savepoint-staged-rows.sqllogic`, the isolation savepoint suite.

# Validation run

| Command | Result |
|---|---|
| `yarn build` | clean |
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn test` (root, all workspaces) | 7849 + 344 + … passing, 0 failing |
| `yarn test:store` | 7840 passing, 22 pending, 0 failing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

# Known gaps / what a reviewer should push on

- **`CREATE TABLE` is still lax** — `create table t (a integer primary key, n integer
  default 'abc')` is accepted silently and only fails at the first INSERT. That is now
  a visible asymmetry with ALTER, which rejects. The implement ticket deliberately
  scoped it out and asked the reviewer to decide: **should a follow-up ticket close it
  by making CREATE stricter?** (Not by making ALTER looser — that would reintroduce the
  garbage-storage case.) My read: worth a `backlog/bug-` ticket, but it is a real
  behavior change for existing schemas and belongs to a human's call, not mine.
- **The SET NOT NULL eager-throw** described above under "deliberate behavior changes"
  is the judgement call most worth a second opinion.
- **Coverage floor, not ceiling.** The sqllogic covers INTEGER, REAL and JSON targets.
  Not covered: temporal targets (`add column d date default '2024-06-05T00:00:00Z'`,
  which should canonicalize to `'2024-06-05'` the way `SET DATA TYPE` does), BLOB, and
  the `NUMERIC`/`BOOLEAN` types. Those go through the same `validateAndParse` so they
  are very likely right, but they are untested here.
- **Not covered: the batched data-change-event path.** Sites 4 and 8 (the emitter's
  `foldedDefault` feeding `remapBatchedDataEvents`, and `alterColumnEventValueRemap`)
  are exercised only indirectly. `packages/quereus/test/alter-table-events.spec.ts`
  exists and passes, but I did not add an assertion that a batched event's backfilled
  value is the *converted* one. That is the weakest spot in this change's test coverage.
- **Not covered: `insertAtIndex` (mid-table column insert).** The module API permits it;
  SQL never produces it. The conversion is position-independent, so this should be
  fine, but no test pins it.

# Tripwire parked in code

- `runtime/emit/alter-table.ts` `alterColumnEventValueRemap` — the function is
  documented as TOTAL (an unconvertible historical event image keeps its raw value
  rather than aborting the ALTER), but `foldDefaultToType` throws. It is unreachable
  today because every module folds the same DEFAULT through the same helper up front
  and rejects there first. Left a `NOTE:` at the site saying that if a module ever
  stops folding eagerly, the fix is to catch and return `undefined` rather than abort
  a completed ALTER.
