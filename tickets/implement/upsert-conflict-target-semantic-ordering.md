---
description: Writing "insert ... on conflict (column) do update" against a duration column failed with a uniqueness error instead of updating the existing row when the new value spelled the same duration a different way; the fix landed during the fix stage and needs a final validation pass before review.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # the fix — conflictTargetComparators
  - packages/quereus/src/schema/unique-enforcement.ts        # uniqueEnforcementComparators (reused unchanged)
  - packages/quereus/src/planner/building/insert.ts          # resolveConflictTargetEnforcement (unchanged)
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # new coverage block
  - docs/types.md                                            # § UNIQUE enforcement — new paragraph
difficulty: easy
---

# UPSERT conflict-target routing now uses the shared UNIQUE-enforcement identity

## What was wrong

Some declared column types define their own notion of "same value" that is not
byte-equality of the stored text (`docs/types.md` § "Semantic ordering"). `TIMESPAN`
is the motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour, and
`=`, `DISTINCT`, `GROUP BY`, primary keys and UNIQUE enforcement on every backend
already treat them as one value.

`insert … on conflict (<column>) do update` did not. The virtual table reported the
conflict and handed back the existing row correctly; the DML executor then had to
decide *which* `on conflict` clause the violation belonged to, by checking whether the
proposed and existing rows agree on the clause's target columns. That check compared
with storage class + collation only, so the two spellings looked unequal, no clause
matched, and the executor re-raised `UNIQUE constraint failed`.

Reproduced on both backends at commit `28620d00`; confirmed fixed on both.

## The fix (already applied)

`runtime/emit/dml-executor.ts` no longer carries per-target *collation functions* on
the runtime clause. It carries per-target *comparators*, built once at emit by the
shared `uniqueEnforcementComparators` (`schema/unique-enforcement.ts`) — the same
builder the memory re-validators, the store finders, the isolation overlay and the
covering-MV candidate generator use. That helper already accepts a bare list of source
column indices (its docstring says so explicitly), so `conflictTargetIndices` was
passed straight in; neither the helper nor `resolveConflictTargetEnforcement`
(`planner/building/insert.ts`, which still resolves collation NAMES at plan time)
needed changing.

Concretely:

- `RuntimeUpsertClause.conflictTargetCollationFns` → `conflictTargetComparators:
  Array<(a: SqlValue, b: SqlValue) => number>`.
- At emit, the plan's collation names are resolved to functions as before (keeping the
  collation dependency registration so a redefined collation re-emits), then fed to
  `uniqueEnforcementComparators(tableSchema.columns, clause.conflictTargetIndices,
  collationFns)`.
- `conflictTargetValuesMatch` calls the comparator, falling back to
  `compareSqlValuesFast(…, BINARY_COLLATION)` when the array is absent (a defensively
  old plan) — the same degradation the collation version had.

Semantic-ordering columns are gated by `hasSemanticOrdering` inside the shared helper,
so TEXT/ANY columns keep the collation comparison and NOCASE/RTRIM routing is
untouched.

## Coverage added

A block in `test/logic/15.1-semantic-ordering.sqllogic`, next to the existing UNIQUE
identity block, running under both `yarn test` (memory) and `yarn test:store`:

- `on conflict (d) do update` and `do nothing` against a `d timespan unique` column
  with a re-spelled duration.
- The untargeted `on conflict do update` form (unchanged behavior).
- A conflict on a *different* constraint than the target still aborts.
- A composite `unique (k, d)` target with a TIMESPAN member.
- JSON — the ticket's open question. JSON values reach the executor already
  canonicalized, so both sides were equal even before the fix; the case is now pinned
  rather than assumed, so routing stays correct whichever layer canonicalizes.
- Negative control: a `text unique` target keeps text identity (differently spelled
  value inserts as a new row; the same spelling still routes to DO UPDATE).

The multi-constraint-coincidence corner documented in `matchUpsertClause`'s comment
remains out of scope, and is now also stated in `docs/types.md`.

## Validation already run

- `yarn workspace @quereus/quereus run test` — 7473 passing, 13 pending.
- `yarn workspace @quereus/quereus run test:store` — 7466 passing, 20 pending.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn build` — clean.
- `documentation.spec.ts` re-run after the `docs/types.md` edit — 6 passing.

Not run: the full-workspace `yarn test` (only the `@quereus/quereus` workspace leg
was run) and `yarn typecheck` across every package.

## TODO

- Run full-workspace `yarn test` and `yarn typecheck` (or `yarn check`) to cover the
  packages outside `@quereus/quereus`; the diff touches only engine-internal runtime
  code, so no cross-package fallout is expected.
- Re-read the diff in `packages/quereus/src/runtime/emit/dml-executor.ts` for comment
  accuracy — the `RuntimeUpsertClause` field docstring, the
  `conflictTargetValuesMatch` docstring and the emit-site comment were all rewritten
  alongside the rename.
- Hand off to review.
