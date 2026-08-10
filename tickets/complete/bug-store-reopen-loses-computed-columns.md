description: A computed column saved to persistent storage used to come back empty after the database was closed and reopened — the rule that computes it was silently thrown away, and every row written afterwards stored nothing in that column. Fixed and reviewed.
files:
  - packages/quereus/src/schema/ddl-generator.ts                             # formatColumnDef — the fix, one added branch (~532-539)
  - packages/quereus-store/test/generated-column-reopen.spec.ts              # persist/close/reopen behavioral spec (+1 case added in review)
  - packages/quereus-store/test/ddl-generator.spec.ts                        # 3 unit cases pinning emitted text
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts          # generate→parse→columnDefToSchema round-trip case
  - packages/quereus-store/test/rename-column-default-reopen.spec.ts         # stale comment updated
  - docs/schema.md                                                           # DDL-generation feature coverage list (updated in review)
difficulty: easy
---

# Emit `generated always as` from the canonical DDL generator — complete

## What changed

`formatColumnDef` in `packages/quereus/src/schema/ddl-generator.ts` (~532-539) gained the one
missing branch:

```ts
if (col.generated && col.generatedExpr) {
    colDef += ` GENERATED ALWAYS AS (${expressionToString(col.generatedExpr)})`;
    colDef += col.generatedStored ? ' STORED' : ' VIRTUAL';
}
```

Placed after the `DEFAULT` block (the two are mutually exclusive — `columnDefToSchema` rejects
a column carrying both) and before the tags block. Storage keyword is always emitted
explicitly, matching this file's stance that persisted DDL stays fully explicit.
`generateTableDDL` and `generateMaintainedTableDDL` both route through this one function, so
both get the fix.

Everything else — parser, `columnDefToSchema`, the insert/update planner's generated-column
enforcement, `renameColumnInColumnExpressions`'s in-memory rewrite of `generatedExpr` on a
`RENAME COLUMN` — was already correct. This was a pure emission gap.

## Test coverage

- **`packages/quereus-store/test/generated-column-reopen.spec.ts`** — persist → `close()` →
  fresh `Database` + `StoreModule` over the same in-memory KV provider → `rehydrateCatalog`.
  Three cases: inline stored + virtual generated columns (flags/expr rehydrate, pre-reopen row
  keeps its stored value, post-reopen INSERT computes `g=8, v=14` instead of null, direct
  writes to either column rejected); a `RENAME COLUMN` of a column named by the generated body
  re-persisting the rewritten body; and (added in review) the same reopen survival for columns
  introduced by `alter table ... add column ... generated always as (...)`.
- **`packages/quereus-store/test/ddl-generator.spec.ts`** — 3 unit cases pinning exact emitted
  text for `STORED`, `VIRTUAL`, and the `generatedExpr`-absent guard.
- **`packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts`** — engine-side
  `generateTableDDL → parse → columnDefToSchema` round-trip, no store package involved.

## Review findings

### Checked and clean (no action)

- **Clause placement / parse order.** `formatColumnDef` emits `GENERATED` after `DEFAULT`,
  `PRIMARY KEY` and `COLLATE`, before `WITH TAGS`. The parser's column-constraint reader
  (`isColumnConstraintStart` / `columnConstraint`, parser.ts ~4570-4680) is an
  order-agnostic loop over constraint kinds, so no ordering combination — including
  `NOT NULL GENERATED …` or an inline-PK generated column — can misparse. The trailing
  `WITH TAGS` still binds to the column, since the constraint parser only consumes a
  trailing tags clause for *named* constraints.
- **No second lossy emitter.** `ast-stringify`'s `columnConstraintsToString` (the AST→SQL
  path used by `ALTER TABLE ADD COLUMN` and the declarative differ) already emitted
  `generated always as (...)`, eliding `virtual` because that is the parser's default — a
  lossless elision, so the two emitters differ in explicitness deliberately, exactly as they
  already do for `NULL` / `COLLATE`. Nothing to unify.
- **Sibling schema→AST paths already carry the field.** `buildConstraintsFromColumn`
  (`runtime/emit/alter-table.ts` ~2451, the `RENAME COLUMN` ColumnDef reconstruction) and
  `cloneTableRewritableAsts` (`schema/catalog-persistability.ts` ~162, the module-veto
  probe's clone) both already handle `generatedExpr`. No parallel gap.
- **No new differ churn.** `computeColumnAttributeChange` never read `generated` before this
  change and still doesn't; the persisted side gaining the clause cannot introduce a
  phantom diff. The real gap there (`ALTER COLUMN … SET/DROP GENERATED` has no SQL syntax)
  stays filed as `backlog/feat-alter-column-generated-clause`.
- **Expression fidelity.** The new branch renders through the same `expressionToString` the
  `DEFAULT` branch has always used, so any stringifier limitation is shared, pre-existing,
  and not introduced here. Not recorded as a tripwire for that reason.

### Found and fixed in this pass

- **Coverage gap (the one the implementer flagged).** `alter table … add column … generated
  always as (…)` reaches persistence through the same `formatColumnDef` but by a different
  producer, and had no reopen test. Added a third case to
  `generated-column-reopen.spec.ts`: ADD COLUMN of a stored and a virtual generated column,
  backfill of the pre-existing row asserted before `close()`, then flags and post-reopen
  computation asserted after `rehydrateCatalog`. Passes.
- **Doc drift.** `docs/schema.md` § DDL Generation carries an explicit "Feature coverage
  (both forms)" enumeration of what `generateTableDDL` emits — it listed `DEFAULT <expr>`,
  `COLLATE`, `PRIMARY KEY`, `USING`, `WITH TAGS`, and nothing about generated columns, so it
  described the pre-fix behavior. Added `GENERATED ALWAYS AS (<expr>) STORED|VIRTUAL` to the
  list plus a short paragraph on why the storage keyword is always explicit and why the
  clause never co-emits with `DEFAULT`. Every other doc touching generated columns
  (`sql-ddl.md`, `sql-alter.md`, `determinism.md`, `module-authoring.md`) describes engine
  semantics the fix restores rather than changes, and needed no edit; `docs/invariants.md`
  has no DDL-losslessness invariant to extend.

### Explicitly empty

- **No major findings, so no new tickets filed.** The fix is one branch, its blast radius is
  the single function every DDL producer already routes through, and every adjacent path was
  verified to already carry the field.
- **No tripwires recorded.** The only conditional concern considered (expression-stringifier
  fidelity) is shared with the long-standing `DEFAULT` branch, so it is a property of the
  file, not something this change put at risk.
- **No pre-existing failures encountered** — every suite ran clean, so no
  `tickets/.pre-existing-error.md` was written.

## Verification run

Rebuilt `@quereus/quereus` first (the store suite resolves it through its built `dist`, so a
stale `dist` would silently pass against the old lossy emitter).

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **8697 passing**, 13 pending, 0 failing.
- `yarn workspace @quereus/store run test` — **1369 passing** (1368 before the review's +1
  ADD COLUMN case), 0 failing. Console noise in the run is other tests' expected error-path
  logging.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc --noEmit`) — clean.
- `yarn workspace @quereus/store run lint` / `run typecheck` — clean.

## End
