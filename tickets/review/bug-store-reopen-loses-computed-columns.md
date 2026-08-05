description: A computed column saved to persistent storage used to come back empty after the database was closed and reopened — the rule that computes it was silently thrown away, and every row written afterwards stored nothing in that column. Fixed.
files:
  - packages/quereus/src/schema/ddl-generator.ts                             # formatColumnDef — the fix, one added branch (~532-539)
  - packages/quereus-store/test/generated-column-reopen.spec.ts              # NEW — full persist/close/reopen behavioral spec
  - packages/quereus-store/test/ddl-generator.spec.ts                        # +3 unit cases pinning emitted text
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts          # +1 generate→parse→columnDefToSchema round-trip case
  - packages/quereus-store/test/rename-column-default-reopen.spec.ts         # comment updated (stale reference to this bug as still-open)
difficulty: easy
---

# Emit `generated always as` from the canonical DDL generator — implemented

## What changed

`formatColumnDef` in `packages/quereus/src/schema/ddl-generator.ts` (~532-539) gained the
one missing branch:

```ts
if (col.generated && col.generatedExpr) {
    colDef += ` GENERATED ALWAYS AS (${expressionToString(col.generatedExpr)})`;
    colDef += col.generatedStored ? ' STORED' : ' VIRTUAL';
}
```

Placed after the `DEFAULT` block (the two are mutually exclusive — `columnDefToSchema`
already rejects a column carrying both) and before the tags block. Storage keyword
(`STORED`/`VIRTUAL`) is always emitted explicitly, matching this file's stance that
persisted DDL stays fully explicit. `generateTableDDL` and `generateMaintainedTableDDL` both
route through this one function, so both get the fix.

Everything else — parser, `columnDefToSchema` (schema/table.ts), the insert/update
planner's generated-column enforcement, `renameColumnInColumnExpressions`'s in-memory
rewrite of `generatedExpr` on a `RENAME COLUMN` — was already correct. This was a pure
emission gap.

## Test coverage added

- **`packages/quereus-store/test/generated-column-reopen.spec.ts`** (new) — the primary
  behavioral proof, using the in-memory KV provider harness (persist → `close()` → fresh
  `Database` + `StoreModule` over the same provider → `rehydrateCatalog`):
  - `rehydrateCatalog` reports zero errors.
  - Reopened `ColumnSchema` carries `generated`, `generatedExpr`, and the right
    `generatedStored` for both a `stored` and a `virtual` column.
  - A row inserted **before** the reopen keeps its stored value; the virtual column
    recomputes on read.
  - A row inserted **after** the reopen gets computed values (`g=8, v=14`), not `null` — the
    exact regression symptom.
  - A direct `insert ... (id, a, g)` / `(id, a, v)` after the reopen is rejected with
    `Cannot INSERT into generated column '<name>'` for both the stored and virtual column.
  - A second test: `RENAME COLUMN` of a column named by the generated body, done *before*
    `close()`, re-persists the rewritten body — the reopened table still computes correctly
    from the renamed column (proves `renameColumnInColumnExpressions`'s in-memory rewrite now
    actually survives a reopen, not just the live session).
- **`packages/quereus-store/test/ddl-generator.spec.ts`** — 3 new unit cases pinning exact
  emitted text: `GENERATED ALWAYS AS (a + 1) STORED`, `GENERATED ALWAYS AS (a * 2) VIRTUAL`,
  and a guard case confirming nothing is emitted when `generatedExpr` is absent (the
  unreachable-defence branch every producer already avoids).
- **`packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts`** — 1 new case:
  `generateTableDDL → parse → columnDefToSchema` for both a stored and virtual column, pinned
  on `generated`, `generatedStored`, and the expression text (via `expressionToString`) —
  the engine-side round-trip, no store package involved.
- Updated a stale comment in `rename-column-default-reopen.spec.ts` that referenced this bug
  as still-open ("a computed column comes back after a reopen as a plain null column") —
  now points at the new spec instead.

## Verification run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **8697 passing** (was 8696 before this
  ticket's +1 new test), 13 pending, 0 failing.
- `yarn workspace @quereus/store run test` — **1368 passing** (was 1363 before this ticket's
  +5 new tests), 0 failing. (Console noise in the run — collation/materialized-view/savepoint
  warnings — is other tests' expected error-path logging, not failures; confirmed 0 failed in
  the mocha summary.)
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc --noEmit`) — clean.
- `yarn workspace @quereus/store run lint` and `run typecheck` — clean.
- Rebuilt `@quereus/quereus` before running store tests, per the ticket's noted trap (the
  store suite resolves `@quereus/quereus` through its built `dist`, so a stale `dist` would
  silently pass against the old lossy emitter).

## Known gaps / out of scope (not touched by this ticket)

- **`ALTER COLUMN … SET/DROP GENERATED`** doesn't exist as SQL syntax, so a declarative
  schema that changes a column's generated body is still silently ignored by the schema
  differ (`computeColumnAttributeChange` never reads `generated`). Already filed as
  `backlog/feat-alter-column-generated-clause` by the prior fix-stage pass — not this
  ticket's scope, left as-is.
- Two unrelated, pre-existing backlog tickets touch generated columns
  (`bug-generated-column-own-table-qualified-reference-unusable`,
  `bug-generated-column-subquery-column-refs-misread`) — not read or touched; flagging only
  so the reviewer doesn't mistake them for overlap with this fix.
- No sqllogic case added: the sqllogic harness has no reopen primitive (same reasoning
  `rename-column-default-reopen.spec.ts` and `add-column-inline-constraint-reopen.spec.ts`
  already follow), so all new coverage lives in the two spec files above.
- The new reopen spec covers `create table` with generated columns declared inline. It does
  **not** add a case for a generated column added later via `alter table add column ...
  generated always as (...)` — that path shares `formatColumnDef` (same fix covers it) but
  wasn't independently exercised across a reopen. Low risk given the shared code path, but a
  gap a reviewer may want an explicit test for.

## End
