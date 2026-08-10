description: Writing "insert ... on conflict (column) do update" against a duration column used to fail with a uniqueness error instead of updating the existing row when the new value spelled the same duration a different way; it now updates the row, and the fix has been reviewed and validated.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # the fix — conflictTargetComparators
  - packages/quereus/src/schema/unique-enforcement.ts        # uniqueEnforcementComparators (reused unchanged)
  - packages/quereus/src/planner/building/insert.ts          # resolveConflictTargetEnforcement (unchanged)
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # coverage block
  - docs/types.md                                            # § UNIQUE enforcement
  - docs/sql-dml.md                                          # § UPSERT — user-facing matching rule
difficulty: easy
---

# UPSERT conflict-target routing uses the shared UNIQUE-enforcement identity

## What was wrong

Some declared column types define their own notion of "same value" that is not byte
equality of the stored text (`docs/types.md` § "Semantic ordering"). `TIMESPAN` is the
motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour, and `=`,
`DISTINCT`, `GROUP BY`, primary keys and UNIQUE enforcement on every backend already
treat them as one value.

`insert … on conflict (<column>) do update` did not. The virtual table reported the
conflict and handed back the existing row correctly; the DML executor then had to
decide *which* `on conflict` clause the violation belonged to, by checking whether the
proposed and existing rows agree on the clause's target columns. That check compared
with storage class + collation only, so the two spellings looked unequal, no clause
matched, and the executor re-raised `UNIQUE constraint failed`.

## The fix

`runtime/emit/dml-executor.ts` carries per-conflict-target *comparators* on the runtime
clause instead of per-target *collation functions*. They are built once at emit by the
shared `uniqueEnforcementComparators` (`schema/unique-enforcement.ts`) — the same
builder the memory re-validators, the store finders, the isolation overlay and the
covering-MV candidate generator use. That helper already accepted a bare list of source
column indices, so `conflictTargetIndices` is passed straight in; neither the helper nor
`resolveConflictTargetEnforcement` (`planner/building/insert.ts`, which still resolves
collation NAMES at plan time) needed changing.

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
so TEXT/ANY columns keep the collation comparison and NOCASE/RTRIM routing is untouched.

## Coverage

A block in `test/logic/15.1-semantic-ordering.sqllogic`, next to the existing UNIQUE
identity block, exercised under both `yarn test` (memory) and `yarn test:store` (LevelDB
store path):

- `on conflict (d) do update` and `do nothing` against a `d timespan unique` column with
  a re-spelled duration.
- The untargeted `on conflict do update` form (unchanged behavior).
- A conflict on a *different* constraint than the target still aborts.
- A composite `unique (k, d)` target with a TIMESPAN member.
- A TIMESPAN **primary key** target (added at review — see findings).
- JSON, whose values reach the executor already canonicalized, so both sides were equal
  even before the fix; pinned rather than assumed.
- Negative control: a `text unique` target keeps text identity.

## Review findings

Read the code diff first, then the handoff. Reviewed against: single-purpose functions,
DRY, modularity, performance, error handling, type safety, resource cleanup, source
hygiene, test breadth, and doc currency.

### Verified correct (no change needed)

- **Positional alignment through the whole chain.** `resolveConflictTargetEnforcement`
  builds its collation list by mapping each `conflictTargetIndices` entry back through a
  by-column-index map (never positionally), so `conflictTargetCollations` is guaranteed
  same-length and index-aligned even when the `ON CONFLICT (b, a)` column order differs
  from the constraint's declared order. `uniqueEnforcementComparators` then indexes
  `collations[i]` by the same position. No off-by-one or misalignment path.
- **The handoff's own review question — does `uniqueEnforcementComparators` assume a
  full-constraint column list?** No. It is a pure positional `map` over whatever indices
  it is handed, with no reference to the owning constraint, and
  `database-materialized-views.ts:1125` already passed it a PRIMARY KEY column list
  rather than a `uc.columns` before this change. The new arbitrary-subset caller has
  precedent, not novelty.
- **NULL and cross-storage-class handling.** `createTypedComparator` short-circuits
  null/null → 0 and storage-class mismatch → class difference before reaching the
  type's `compare`, so the semantic branch cannot report a false match across storage
  classes, and NULL behavior at a target column is unchanged from the pre-fix
  `compareSqlValuesFast` path.
- **Cost.** Comparators are built once per clause at emit, not per row. No new per-row
  schema lookup.
- **Non-semantic columns are byte-for-byte unchanged.** The helper's else-branch is
  literally `compareSqlValuesFast(a, b, collations[i])` in the same argument order the
  old code used.
- The `conflictTargetComparators`-absent fallback is unreachable in practice (the
  planner always sets collations whenever it sets indices), but it is cheap, documented
  as defensive, and matches the pre-existing shape. Left as-is.

### Minor — fixed in this pass

- **Test gap: the PRIMARY KEY branch of `resolveConflictTargetEnforcement` was
  untested.** That function resolves enforcement collation down two different branches
  (PK column definition vs. UNIQUE constraint), and every new case exercised only the
  UNIQUE branch. Added a `uxp` block covering `create table uxp (d timespan primary key,
  n integer)` with `on conflict (d) do update set n = excluded.n` — both the re-spelled
  duration (routes to DO UPDATE) and a genuinely different duration (plain insert), and
  it exercises `excluded.` value plumbing through the semantic path. Passes on both
  backends.
- **`docs/sql-dml.md` § UPSERT was stale — the change should have touched it and
  didn't.** That section is the *user-facing* statement of how a targeted conflict is
  matched, and it still enumerated collation and affinity only. Rewrote it to include
  semantic-ordering types, with a `'PT60M'` vs `'PT1H'` example and a pointer to
  `types.md`. (`docs/types.md` was already updated by the implementer and reads
  correctly.)
- **Stale comment the rename missed.** The inline block in `matchUpsertClause` still
  said "the per-column collation functions are precomputed at emit" after the field
  became comparators, and otherwise restated `conflictTargetValuesMatch`'s docstring at
  length. Trimmed to the facts that are local to the call site and pointed at the
  docstring for the comparison rule; the multi-constraint NOTE is kept verbatim. Also
  removed a stray double blank line the diff left behind.

### Major — none

No correctness, isolation, or backend-divergence defect found in the diff. No new
ticket filed.

### Tripwires (parked, not ticketed)

- **Which spelling survives a DO UPDATE is not pinned.** The whole
  `15.1-semantic-ordering.sqllogic` file asserts TIMESPAN values through
  `timespan_total_seconds`, so the tests prove the right *row* survived but not that it
  kept its *own* key spelling. That is correct today (the target column is unassigned,
  so the existing row's value stands) and only becomes a question if a backend is
  changed to adopt the proposed row's key spelling. Parked as a `NOTE:` comment above
  the `ux` block in the test file.
- **Multi-constraint coincidence** — an insert violating the targeted constraint *and*
  another one at once is routed to DO UPDATE/DO NOTHING, because the vtab short-circuits
  on the first violation and never reports the second. Pre-existing, applies equally to
  plain byte-identity conflicts, and unresolvable by value comparison alone. Already
  recorded by the implementer as a `NOTE:` in `matchUpsertClause` and a sentence in
  `docs/types.md`; reviewed and agreed as documented behavior.
- **Declined, not parked:** `(a: SqlValue, b: SqlValue) => number` is spelled inline in
  `unique-enforcement.ts` and `dml-executor.ts` while a `ValueComparator` alias exists
  privately in `vtab/memory/layer/plan-filter.ts`. Hoisting and exporting one alias
  would touch the package's public type surface (`index.ts` re-exports the helper) for a
  purely cosmetic gain — not worth it, and not conditional on anything, so no NOTE.

### Validation (all run at review, after the review edits)

- `yarn workspace @quereus/quereus run test` — 7473 passing, 13 pending.
- `yarn workspace @quereus/quereus run test:store` — 7466 passing, 20 pending.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + test-file type pass).
- `yarn typecheck` (all packages) — clean.
- `documentation.spec.ts` re-run after the `docs/sql-dml.md` edit — 6 passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
