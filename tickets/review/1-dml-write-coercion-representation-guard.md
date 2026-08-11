---
description: The engine used to trust a value's declared type label when deciding whether to convert it on the way into a table column, so a column declared as text could end up holding a raw number. The write path now also checks the value itself; this reviews that change.
prereq:
files:
  - packages/quereus/src/types/representation.ts            # NEW — conformsToType / buildConformanceCheck, moved down a layer
  - packages/quereus/src/types/validation.ts                # NEW buildCellCoercion; buildRowCoercion reworked on top of it
  - packages/quereus/src/runtime/strict-representation.ts   # now imports the predicate instead of defining it
  - packages/quereus/src/planner/building/alter-table.ts    # ADD COLUMN backfill takes the shared decision
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # AddColumnBackfill.coerceTo → coerce (a closure)
  - packages/quereus/src/runtime/emit/alter-table.ts        # applies backfill.coerce
  - packages/quereus/src/runtime/emit/constraint-check.ts   # OR REPLACE NOT NULL DEFAULT substitution
  - packages/quereus/src/runtime/emit/dml-executor.ts       # ON CONFLICT DO UPDATE assignments + upsert NOT NULL defaults
  - packages/quereus/src/runtime/row-constraints.ts         # NotNullDefaultRuntime.coerceColumn → coerce
  - packages/quereus/test/types/row-coercion.spec.ts        # NEW unit tests (14)
  - packages/quereus/test/dml-write-representation.spec.ts  # NEW engine-level regressions (19)
  - docs/types.md                                           # § Where coercion happens, § Enforcement
difficulty: medium
---

# What the problem was

Every DML write converts each cell to its target column's declared logical type once, at
the top of the pipeline, and then tells the storage layer `preCoerced` so nothing converts
again. The decision about which cells to convert was **purely static**: compare the
producing expression's announced `LogicalType` against the column's declared type by
object identity, and skip the cell on a match.

The skip had a real reason — re-converting is destructive for JSON, whose `parse` reads a
plain JS string as JSON *source* (stored text `9` becomes the number 9; `abc` throws). But
it trusted a static type the engine does not enforce anywhere else, so a wrong announcement
let a non-conforming value reach storage. Two verified instances, both with
`QUEREUS_REPR_STRICT` off and `MemoryTable` as the backend:

- `sum()` announces REAL and returns a `bigint` past 2^53 → REAL-into-REAL identity match →
  a `real` column stored the JS `bigint` `18014398509481986n`.
- An untyped positional `?` announces TEXT (the planner's fallback with no hint) →
  TEXT-into-TEXT identity match → a `text` column stored the JS number `9`. Same for a
  bound `Uint8Array`, boolean, or `bigint`.

Both violate rule R2 of `docs/types.md` § Physical representation — stored data inhabits
its declared type's JS value space — which is the rule the write path exists to uphold.

# What was built

**One predicate, one layer down.** `conformsToType` ("does this non-null value inhabit this
declared type's JS value space") moved out of `runtime/strict-representation.ts` into a new
`src/types/representation.ts`, alongside a `buildConformanceCheck(type)` that pre-selects
the per-`physicalType` arm once and returns `undefined` for a type that constrains nothing
(`ANY`). The strict checker imports it rather than defining it, so the
`QUEREUS_REPR_STRICT` harness and the write path cannot come to disagree about what
conforms. `DeclaredType` moved with it and is re-exported from the old location for the
checker's existing importers. Arms are module-level constants, so neither the one-shot nor
the pre-selected form allocates.

**One shared per-cell decision.** New `buildCellCoercion(sourceType, target, columnName)` in
`types/validation.ts` returns the per-value closure, or `undefined` when there is provably
nothing to do:

- announced type ≠ target (or `undefined`) → **always convert** (as before);
- announced type IS target → **convert only if the value does not conform**;
- announced type IS target and the target constrains no value space (`ANY`) → `undefined`.

The guard is a conjunction with the identity test, not a replacement: a TEXT-announced
expression feeding a DATE column produces a string, which conforms to DATE's TEXT physical
type, yet still needs converting so the spelling canonicalizes.

**Every write seam that made this decision now calls that helper.** Beyond the two arms the
ticket named, three more sites open-coded the same identity comparison, and leaving them
would have made the docs' "convert their one cell by the same rule" claim false:

| site | what changed |
|---|---|
| `buildRowCoercion` (INSERT + both UPDATE phases) | per-column dispositions from the helper; returns `undefined` only when no column converts **and** none needs guarding |
| `planner/building/alter-table.ts` ADD COLUMN backfill | `AddColumnBackfill.coerceTo?: LogicalType` → `coerce?: (v) => SqlValue`, built by the helper |
| `runtime/emit/constraint-check.ts` OR REPLACE NOT NULL DEFAULT substitution | `NotNullDefaultRuntime.coerceColumn` → `coerce` closure |
| `runtime/emit/dml-executor.ts` ON CONFLICT DO UPDATE assignments | `assignmentCoercions: Map<number, ColumnSchema>` → `Map<number, (v) => SqlValue>` |
| `runtime/emit/dml-executor.ts` upsert-arm NOT NULL defaults | same |

The DO UPDATE one was not just tidying — it is reachable: `… on conflict (id) do update set
v = ?` binding a number into a `text` column stored the number, exactly like the plain
INSERT case. It is covered by a test.

`docs/types.md` § Where coercion happens now states the rule as it is (convert unless the
source type matches AND the value already inhabits it), and § Enforcement says where the
shared predicate lives.

# Use cases to exercise

Fast loop for a reviewer:

```
yarn workspace @quereus/quereus run test:single "packages/quereus/test/types/row-coercion.spec.ts"
yarn workspace @quereus/quereus run test:single "packages/quereus/test/dml-write-representation.spec.ts"
```

The two original repros, now correct:

```sql
create table s (id integer primary key, v integer);
insert into s values (1, 9007199254740993), (2, 9007199254740993);
create table t (id integer primary key, r real);
insert into t values (1, (select sum(v) from s));
select r from t;   -- JS number 18014398509481984, not a bigint
```

```js
await db.exec(`create table t (id integer primary key, v text)`);
await db.prepare(`insert into t values (?, ?)`).run([1, 9]);   // stores '9'
```

Note the REAL repro's stored value is `18014398509481984`, **not** the
`18014398509481986` the implement ticket predicted: `Number(18014398509481986n)` rounds,
because 2^54 + 2 has no exact double. The test asserts `Number(18014398509481986n)` so the
intent is legible.

What must NOT regress (all covered):

- `insert into b select j from a` for a JSON column still never re-parses — including the
  stored JSON string scalars `abc` (which `parse` throws on) and `9` (which `parse` would
  silently renumber), and a native document.
- An UPDATE that never mentions a JSON column leaves it byte-identical.
- The four write shapes that already coerced correctly (named parameter, literal,
  `prepare(sql, params)`, positional `?` into an `any` column) keep their results.
- `add column k json default (new.j)` over a `json` column still copies without re-parsing.

# Validation run

All green, from repo root unless noted:

- `yarn test` — every workspace; quereus core 9429 passing, no failures anywhere
- `yarn test:store` — 9421 passing, 33 pending
- `yarn workspace @quereus/quereus run test:repr-strict` — 9438 passing, 16 pending
- `yarn lint` — clean (quereus's eslint + `tsconfig.test.json` pass)
- `yarn build` then `yarn typecheck` — clean across all packages

No pre-existing failures were surfaced, so `tickets/.pre-existing-error.md` was not written.

# Known gaps — treat these as the starting point

- **The guard is R2-level, not `validate`-level.** It asks which JS storage class the value
  is, so it catches "a number reached a TEXT column" but not "a badly-spelled string reached
  a DATE column" — a string does inhabit DATE's TEXT physical type. Deliberate (it keeps
  this predicate identical to the strict checker's), and the known instance of that
  remaining hole is already tracked as
  `debt-variadic-datetime-functions-not-temporally-typed`. Recorded as a `NOTE:` on
  `buildCellCoercion`, including what switching to `target.validate` would cost.
- **Cost is unmeasured.** A guarded cell now costs one pre-selected `typeof`/`instanceof`
  per row where it cost nothing. Not benchmarked; recorded as a `NOTE:` on
  `buildRowCoercion` pointing at `test/performance-sentinels.spec.ts` as the place to note
  it rather than reverting the guard.
- **No non-conforming ADD COLUMN backfill instance exists.** That arm is shared for
  single-sourcing, not because a failure was observed; its two tests pin the reachable
  shapes (differing types convert, conforming identity passes through). A reviewer wanting
  more should try to construct a non-conforming one — if it is genuinely unconstructible,
  say so.
- **Announced types are still inaccurate in places.** This ticket deliberately did not fix
  announcements; `binary-op-result-types-match-runtime` and
  `remaining-scalar-result-types-and-repr-net` own that. The guard means a wrong
  announcement no longer corrupts storage, but it can still make a value convert where an
  exact announcement would have skipped — which is safe, just not free.
- **Out-of-repo follow-up (not actionable here).** lamina excludes
  `packages/lamina-quereus-test/src/retype-insert-equivalence.test.ts` from its
  `QUEREUS_REPR_STRICT=1` lane over the positional-`?` case. That exclusion can lift once
  this lands; lamina is a separate repository, so nothing in this diff touches it.
- **Test floor, not ceiling.** 33 new assertions across two new spec files. Not covered:
  the guard under the isolation overlay or the LevelDB store path specifically (the shared
  suite runs against both via `yarn test:store`, but no store-specific stored-representation
  assertion was added), and no property/generator test over "every announced type × every
  bound JS value".
