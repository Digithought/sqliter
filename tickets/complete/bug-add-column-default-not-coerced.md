---
description: When you added a new column to an existing table and gave it a default value, the rows that were already there stored that default as raw text instead of converting it to the column's declared type. Fixed — backfilled rows now hold the same value a fresh insert would.
files:
  - packages/quereus/src/types/validation.ts                        # foldDefaultToType helper
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
  - packages/quereus/test/logic/41.12-alter-default-coercion.sqllogic
  - packages/quereus/test/type-system.spec.ts
  - packages/quereus/test/alter-table-events.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/types.md
  - docs/sql-ddl.md
  - docs/module-authoring.md
---

# What was wrong

Every ordinary write converted each cell to its column's declared logical type before
storage. The `ALTER TABLE` backfill paths did not: they took the DEFAULT expression from
the parse tree, folded it to a literal, and stored that literal raw. So an old row and a
new row under the *same* default held different-looking values:

```sql
alter table t add column n integer default '7';
insert into t (a, b) values (2, 20);
-- backfilled row: n = '7'  (text)
-- inserted row:   n = 7    (integer)
```

Eight independent sites did this, and they all agreed *with each other* on the wrong
value, so nothing caught it.

# What was built

**One shared helper.** `foldDefaultToType(expr, logicalType, columnName)` in
`packages/quereus/src/types/validation.ts`, re-exported from `types/index.ts` and the
package root (the store and isolation packages import it from `@quereus/quereus`). It
folds a DEFAULT expression to a literal via `tryFoldLiteral` **and** runs
`validateAndParse` against the column's declared type. Returns `undefined` when the
expression does not fold (the per-row evaluator path owns that), `null` when it folds to
NULL, and throws `MISMATCH` when the literal cannot convert — with the same message text
the INSERT path produces.

All eight sites route through it: memory `addColumn`, store `alterAddColumn`, isolation
`deriveAddColumnBackfill`, the emitter's `foldedDefault` (batched data-change events),
memory `planTightenNotNull`, store `alterColumnSetNotNull`, isolation
`deriveSetNotNullBackfill`, and the emitter's `alterColumnEventValueRemap`.

**The per-row evaluator path carries an identity guard.** `AddColumnBackfill` gained
`coerceTo?: LogicalType`, set in `buildAddColumnBackfill` only when the default
expression's static type is not (by object identity) the new column's type.
`runAddColumn`'s `backfillEvaluator` converts via `validateAndParse` when it is set,
before the per-row CHECK predicates see the value — matching `emitInsert`, which coerces
at the top of the DML pipeline. The guard is load-bearing: `add column k json default
(new.j)` over an already-`json` column was correct before the fix, and a blanket
coercion would break it (JSON's `parse` reads a plain JS string as JSON *source*, so
stored `abc` would throw and stored `9` would silently become the number 9). This mirrors
the identity skip `buildRowCoercion` already makes.

**Two deliberate behaviour changes.**

1. An unconvertible literal DEFAULT now rejects the ALTER. `alter table u add column n
   integer default 'abc'` used to be accepted and store the text `'abc'`; it now fails
   with `MISMATCH`, whether or not the table has rows — DDL acceptance that depends on
   how many rows happen to be present is more surprising than a uniform rejection.
2. The same uniform rule was extended to `alter column … set not null`. The three legs
   folded the DEFAULT at different points relative to their NULL scan (memory after,
   store and isolation before), so an in-place substitution would have made memory reject
   an unconvertible default only when the table held a NULL. All three are now eager.
   Cost: `set not null` on a column with a pre-existing unconvertible DEFAULT now fails
   even when the column holds no NULLs.

**Adjacent inconsistency fixed.** `store-module-alter-column.ts` detected its literal
DEFAULT with a hand-rolled `expr.type === 'literal'` check, so a signed numeric default
(`default -5`, a unary-minus node in the parse tree) was invisible to the store and the
ALTER rejected where the memory module backfilled. It now uses the shared helper.

# Tests

- `packages/quereus/test/logic/41.12-alter-default-coercion.sqllogic` — runs under both
  the memory module (`yarn test`) and the store module (`yarn test:store`). Literal
  default with a type mismatch (INTEGER, and a signed-numeric REAL); literal default on a
  JSON column; literal defaults on temporal columns (DATE and TIMESPAN, which
  canonicalize); per-row `new.<col>` evaluator across types; the JSON identity regression
  guard; `set not null` backfill; and unconvertible-literal rejection on both a non-empty
  and an empty table.
- `packages/quereus/test/type-system.spec.ts` — `foldDefaultToType` unit tests.
- `packages/quereus/test/alter-table-events.spec.ts` — batched data-change-event
  backfills carry the converted value, on both the engine auto-event path and the memory
  module's native pending-change log.
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — the overlay writes staged
  rows with `preCoerced: true` and so can never pick the conversion up implicitly; two
  tests pin that the overlay and the committed store agree on the converted value, before
  and after commit.

# Validation run

| Command | Result |
|---|---|
| `yarn build` | clean |
| `yarn lint` (eslint + test-file typecheck) | clean |
| `yarn test` (root, all workspaces) | 7853 + 344 + … passing, 0 failing |
| `yarn test:store` | 7844 passing, 22 pending, 0 failing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

# Review findings

## What was checked

The implement diff (`ac47a43c`) was read before the handoff summary. Specifically:

- All eight fold sites and the `coerceTo` evaluator guard, against the write path they
  are supposed to match.
- **The type-identity assumption.** `coerceTo` and `buildRowCoercion` both compare
  `LogicalType` by object identity. Confirmed `inferType` returns registry singletons and
  that `columnDefToSchema` derives its `logicalType` through the same `inferType` call, so
  the engine and all three modules resolve one shared instance per type — no leg can fold
  against a different type object than the guard compared.
- **Whether the new eager throws leak into paths that should not throw.** This was the
  regression most likely to be present. It is not: memory's `planSetNotNull`, the store's
  `alterColumnSetNotNull`, and isolation's `deriveSetNotNullBackfill` each gate on a real
  NOT NULL *tightening*, so `drop not null` and a no-op `set not null` on an
  already-NOT-NULL column are untouched.
- **Whether conversion can flip the ADD COLUMN NOT NULL gate.** It cannot —
  `validateAndParse` returns null only for null input, so `foldedDefault === null` means
  the same thing it meant before.
- **Schema round-trip.** Generated DDL still stringifies the original expression, so a
  reopen re-parses source form. The "an AST literal is always raw source form" invariant
  the helper relies on survives persistence.
- **Missed sites.** Swept `quereus-sync`, `quereus-sync-client`, and the remaining vtab
  implementations for other DEFAULT-backfill folds. None found; the eight are the set.
- Build, lint (which includes the test-file type pass), `yarn test`, `yarn test:store`.

## Correctness defects found

**None.** The eight sites are consistent with each other and with the write path, and the
identity guard is correctly narrow.

## Minor findings — fixed in this pass

- `vtab/memory/layer/manager.ts` had two separate `import` statements from
  `types/validation.js`. Merged.
- `quereus-isolation/src/alter-migration.ts` — `deriveAddColumnBackfill`'s doc comment
  still described its fold as `tryFoldLiteral`. Updated to name the helper and its
  conversion.
- **Batched data-change-event coverage** — the implementer named this the weakest spot in
  the change's coverage, and it was. Added four tests to `alter-table-events.spec.ts`:
  engine auto-event path (ADD COLUMN with a converted literal default; ADD COLUMN with a
  per-row evaluator default; SET NOT NULL with a converted default) and the memory
  module's native pending-change-log path (ADD COLUMN with a converted literal default).
  All pass.
- **Temporal coverage** — added a section to the sqllogic for the canonicalizing temporal
  types, which are the ones where "converted" is visibly different from "raw":
  `date default '2024-06-05T00:00:00Z'` must store `'2024-06-05'` and
  `timespan default '1 hour'` must store `'PT1H'`, each matching what a post-ALTER insert
  stores. Passes under both modules.
- **A doc the change should have touched and didn't** — `docs/module-authoring.md`'s
  `alterTable` sub-arm contract table still told module authors that "a literal / NULL
  default is bulk-written", with no mention of conversion. A third-party module written to
  that contract would reproduce exactly this bug. The `addColumn` and
  `alterColumn.setNotNull` rows now require `foldDefaultToType` and note that
  `backfillEvaluator`'s result arrives already converted. (`docs/types.md` and
  `docs/sql-ddl.md`, which the implementer did update, were re-read and are accurate.)

## Major findings — filed as a new ticket

`tickets/backlog/bug-unconvertible-default-accepted-at-create.md`.

The implementer flagged that `CREATE TABLE` still accepts a DEFAULT the column type
cannot hold, and asked the reviewer to decide. It is worth filing — and the problem is
wider than `CREATE TABLE`. Verified empirically against the built package that **three**
paths accept it: `CREATE TABLE`, `ALTER COLUMN … SET DEFAULT`, and `ALTER COLUMN … SET
DATA TYPE` (which retypes the column and never re-checks the DEFAULT it leaves behind —
masked when rows are present, since their values fail first, but it goes straight through
on an empty table). The ticket carries all three reproductions.

Filed to `backlog/` rather than fixed here because it changes acceptance for **existing
stored schemas**: schemas are re-parsed on open, so a database already containing such a
DEFAULT would newly fail to reopen unless reopen is deliberately exempted. That is a
human's call, as is whether `SET DATA TYPE` should reject or instead *convert* the stored
DEFAULT the way it converts each row's value.

## Judgement calls reviewed and accepted

- **The eager `SET NOT NULL` throw** — the change the implementer most wanted a second
  opinion on. Accepted as-is. It is what makes the memory, store and isolation legs agree;
  the lazy alternative preserves exactly one narrow acceptance (a column with an
  unconvertible DEFAULT and no NULLs) at the cost of deferring a conversion into
  `validateOverlayMigration` to keep the throw pre-mutation. That narrow case is itself a
  schema the new backlog ticket proposes to reject at creation, so preserving it would
  mean plumbing work to protect something already slated for removal.
- **BLOB / NUMERIC / BOOLEAN sqllogic coverage** — deliberately still uncovered. BLOB and
  NUMERIC have no canonicalizing `parse`, so a test would assert identity and pin nothing
  about this change. The types where conversion is observable (JSON, DATE, TIMESPAN) are
  now all covered.
- **`insertAtIndex` (mid-table column insert)** — deliberately still uncovered. Not
  reachable from SQL, and the conversion happens before the insert position is chosen, so
  it is position-independent by construction.

## Tripwires parked

- `packages/quereus/src/types/validation.ts`, at `foldDefaultToType` — `NOTE:` recording
  that skipping the identity guard `buildRowCoercion` carries is safe only while every
  DEFAULT expression originates from the parser. If a path ever synthesizes a DEFAULT node
  from an already-stored value, this becomes a second conversion and needs the guard.
- `packages/quereus/src/runtime/emit/alter-table.ts`, at `alterColumnEventValueRemap` —
  the implementer's existing `NOTE:` (the function is documented as total but the helper
  throws; unreachable while every module folds eagerly up front). Re-read and confirmed
  accurate; left in place.
