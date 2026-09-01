description: Finish and validate the shadow-rebuild change that now writes a rebuilt table's definition through the one official definition writer — run the test suites, fix any fallout, and add the end-to-end coverage proving nothing is lost in a rebuild.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # DONE: buildShadowTableDdl → generateTableDDL; survivingColumns removed; index re-creation; FK suppression around the internal DROP; createIndex precondition (~line 1943)
  - packages/quereus/src/schema/manager.ts                  # DONE: assertNoReferencingChildrenForDrop early-returns under _isFkRestrictSuppressed
  - packages/quereus/test/runtime/shadow-ddl.spec.ts        # DONE: rewritten for canonical (uppercase, quoted) output + new 3-arg signature — but NOT yet executed
  - packages/quereus/test/no-alter-module.ts                # DONE: withCreateIndex flag forwards createIndex/dropIndex
  - packages/quereus/test/alter-table-conformance.spec.ts   # TODO: end-to-end rebuild-preservation coverage goes here (helpers: rows, pkColumns, expectConstraint, expectKeyFlagsAgreeWithDefinition)
difficulty: medium

# Validate the canonical shadow-rebuild DDL change (continuation)

Continuation of the ticket "rebuild a table through the canonical DDL writer, not a
hand-rolled one" — the prior run hit its token budget after landing all source
changes and rewriting the unit spec, **before running any tests**. The working
tree contains the full source change, uncommitted. Nothing has been executed.

## What already landed (uncommitted, verify by reading the files above)

- `buildShadowTableDdl(tableSchema, shadowName, newPkDef)` is now a thin wrapper:
  `generateTableDDL({ ...tableSchema, name: shadowName, primaryKeyDefinition: newPkDef })`
  (no `db` argument, so the text is fully qualified/annotated). The
  `survivingColumns` parameter was deleted end-to-end
  (`rebuildTableWithNewShape` → `rebuildViaShadowTable` → `buildShadowTableDdl`);
  the doc comment explains why the builder is deliberately whole-table-only.
- The insert-select projection now comes from `tableSchema.columns` **filtered to
  non-generated columns** — the shadow declares the same `GENERATED ALWAYS AS`
  clauses and computes them itself; listing a generated column in the INSERT
  column list would be rejected.
- A new helper `rebuildUserIndexes(tableSchema)` filters `tableSchema.indexes`
  through `isImplicitCoveringIndex` (a declared UNIQUE constraint's auto-built
  backing re-materializes from the shadow's own CREATE TABLE; a
  `derivedFromIndex` UNIQUE round-trips the other way, via its CREATE UNIQUE
  INDEX, which `appendIndexToTableSchema` re-synthesizes). After the rebuild's
  RENAME, each user index is re-created with
  `generateIndexDDL(idx, tableSchema)` inside the suppressed-events scope.
- `runAlterPrimaryKey` gained a second capability precondition: refuse (sited
  UNSUPPORTED) when the table has user indexes and the module lacks
  `createIndex` — refusing up front instead of stranding a half-rebuilt table or
  silently dropping indexes.
- **Foreign-key drop ordering resolved by suppression, not refusal.** The
  shadow now carries FKs, and a self-referencing FK makes the shadow a
  "referencing child" of the original — `assertNoReferencingChildrenForDrop`
  (schema/manager.ts) would refuse the rebuild's internal `drop table`. The
  rebuild wraps exactly that DROP in `db._setFkRestrictSuppressed(true)`
  (restored in a `finally`), and the drop guard now early-returns under that
  flag (this also aligns the guard with the external-changes apply path, which
  already sets the flag). The copy itself needs no suppression: the shadow's FKs
  reference the intact ORIGINAL by name, so the per-row EXISTS checks pass, and
  the trailing rename's propagate pass rewrites the then-dangling
  self-reference onto the restored name.
- `makeNoAlterModule` gained `withCreateIndex` (forwards `createIndex` +
  `dropIndex`), matching the `withRenameTable` shape.
- `test/runtime/shadow-ddl.spec.ts` was rewritten for the canonical form,
  including the flipped empty-key case (now expects `PRIMARY KEY ()`), a
  constraints/FK/tags case, an `ON CONFLICT REPLACE` case, and a
  stale-per-column-flag case. **The exact regexes are best-guess against
  `generateTableDDL` output and have not been run** — adjust to the real
  canonical text where they miss (e.g. FK rendering casing via
  `tableConstraintsToString` is lowercase; the spec matches case-insensitively).

## TODO

- Run `yarn workspace @quereus/quereus test` and `yarn lint`; fix fallout.
  Likely spots: the rewritten shadow-ddl.spec regexes; the store package's
  ddl-generator conventions are unaffected (no store files touched).
- Add end-to-end coverage in `alter-table-conformance.spec.ts` (new describe
  block, module `makeNoAlterModule({ withRenameTable: true })`, plus
  `withCreateIndex: true` for the index arms) through a real
  `alter table … alter primary key`:
  - a table-level `CHECK` still rejects a violating insert afterwards
  - a `UNIQUE` constraint still rejects a duplicate afterwards
  - a declared `FOREIGN KEY` survives — assert enforcement (insert violating
    child row rejected), not just DDL text
  - table tags survive
  - the key's `on conflict replace` action survives (behavioral: duplicate-key
    insert replaces instead of erroring)
  - indexes survive: with `withCreateIndex`, a `create index` / `create unique
    index` (unique one asserts duplicate rejection after rebuild) is present and
    enforced after the rebuild; withOUT `withCreateIndex`, the same statement
    is refused up front with the sited UNSUPPORTED and the table is unchanged
  - `alter primary key ()` yields the empty singleton key on a 1-row table, and
    rejects when 2+ existing rows would collide under it (they always do)
  - a **self-referencing FK** table rebuilds successfully, the FK points back at
    the table itself afterwards, and is still enforced
  - another table's FK pointing at the rebuilt table, WITH referencing rows:
    the rebuild succeeds (suppression made this match the in-place path) and the
    child's FK is still enforced afterwards
  - the general subsumer: capture `generateTableDDL(table)` before and after a
    rebuild that re-keys, assert the two strings differ ONLY in the
    `PRIMARY KEY` clause
- Sanity-check the manager.ts drop-guard suppression didn't regress any existing
  FK/drop test (the flag was previously not consulted by that guard; the
  external-changes apply path sets it during applied drops, so an apply-path
  drop of a referenced parent now proceeds instead of refusing — trust-the-origin
  semantics, believed correct, but watch for a test asserting the old refusal).
- If `tsconfig` `noUnusedLocals`-style build errors surface for the alter-table
  imports, confirm `generateIndexDDL` / `isImplicitCoveringIndex` are used
  (they are, in `rebuildViaShadowTable` / `rebuildUserIndexes`).
- Handoff to review/ per workflow when green, noting:
  - tripwire already in code (`rebuildUserIndexes` NOTE): an exposed implicit
    index's user tags don't survive a rebuild on a rebuild-path backend
  - tripwire: a CHECK constraint whose subquery names its own table would make
    the shadow block the internal drop via `assertNoExpressionDependsOn`
    (emitter-level guard, unrelated to the FK suppression) — conditional,
    pre-existing shape, not handled
  - the drop-guard suppression behavior change for the apply path (above)
