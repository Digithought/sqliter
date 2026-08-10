---
description: Renaming a column used to break any other column whose value is worked out from it — as a default or as a computed column — leaving the table unable to accept new rows; that now propagates correctly, and dropping such a column is refused instead of silently breaking things.
files:
  - packages/quereus/src/schema/rename-rewriter.ts               # renameColumnInColumnExpressions (~621)
  - packages/quereus/src/runtime/emit/alter-table.ts             # rewriteTableForColumnRename columns arm (~2400); rewriteOtherTableColumnExpressions (~2418); runDropColumn guard order (~1161)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts      # assertNoColumnDefaultNamesColumn (~75)
  - packages/quereus/src/schema/catalog-persistability.ts        # cloneTableRewritableAsts columns clone (~168)
  - packages/quereus/src/schema/schema-differ.ts                 # NOTE on the redundant SET DEFAULT (~2429)
  - packages/quereus-store/src/common/store-module-alter.ts      # renameColumnChange in-hook arm (~433)
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic           # §29-37
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # §15-18
  - packages/quereus-store/test/rename-column-default-reopen.spec.ts
  - packages/quereus/test/schema/differ-alter-column.spec.ts
  - docs/sql-ddl.md                                              # § Default Values
  - docs/sql-alter.md                                            # RENAME COLUMN / DROP COLUMN
---

# What landed

`ALTER TABLE … RENAME COLUMN` propagated into CHECK constraints, foreign keys and
partial-index predicates, but never looked at `table.columns` — so the two expressions
that live on a `ColumnSchema` were invisible to it:

| field | written as | before | after |
| --- | --- | --- | --- |
| `defaultValue` | `b integer default (new.a + 1)` | rename broke it; drop unguarded | rewritten; drop refused |
| `generatedExpr` | `g integer generated always as (a + 1)` | rename broke it | rewritten (drop already guarded) |

"Broke it" meant the table could accept no further rows: every insert failed at plan time
with `new.a isn't a column` / `Column not found: a`.

The implementation, all following the shape the CHECK arm established:

- **`renameColumnInColumnExpressions`** (`rename-rewriter.ts`) — walks a column array and
  rewrites both fields in place through the **seeded** `renameColumnInCheckExpression`
  entry point. The seed's implicit unaliased binding resolves a generated column's bare
  `a`; its ownership of the `new.` / `old.` row-image namespace resolves a default's
  `new.a`. Case folding and the `"new"`-named-table shadowing edge come along for free.
- **The `table.columns` arm** of `rewriteTableForColumnRename` — branches on
  `isRenamedTable` as the checks/indexes loops do (seeded helper for the owning table,
  `rewriteOtherTableColumnExpressions` → unseeded `renameColumnInAst` otherwise).
- **`cloneTableRewritableAsts`** spine-clones `columns[].defaultValue` / `[].generatedExpr`
  so the pre-flight persistability probe cannot mutate the live catalog and leave a vetoed
  statement with half-renamed defaults.
- **`assertNoColumnDefaultNamesColumn`** (`drop-column-guards.ts`), called first in
  `runDropColumn`: `Cannot drop column 'a' from 'T': it is referenced by the DEFAULT of
  column 'b'`.
- **The store module's in-hook arm** — `renameColumnChange`'s `rewriteColumn(from, to)`
  closure also rewrites `updatedColumns`, so no persisted DDL bundle ever names the
  pre-rename column (the crash window between the hook's put and the post-hook one).

The differ's open question was settled during implement: a diff carrying a rename **plus**
a default naming the renamed column emits one redundant `ALTER COLUMN … SET DEFAULT` after
the `RENAME COLUMN`. Harmless — the rename lands first, so the redundant statement re-sets
the column to exactly what the propagation produced, and the follow-up diff is empty.
Recorded as a `NOTE:` at `computeColumnAttributeChange`.

# Review findings

## Fixed in this pass

**Nested subquery in a foreign object rewrote the wrong reference — silently wrong
values, no error.** `rewriteTableForColumnRename`'s three *other-table* arms
(`checkConstraints`, `indexes`, and the new `columns` arm) called `renameColumnInAst`
**without** `resolveColumnInSource`, while the seeded arms and the pre-flight
persistability probe all pass it. Without the resolver the scope walk cannot tell that an
inner FROM source exposes the old name, so in

```sql
create table src (id integer primary key, a integer);   -- holds 1
create table other (id integer primary key, a integer); -- holds 99
create table x (id integer primary key,
                c integer default ((select (select max(a) from other) from src limit 1)));

alter table src rename column a to z;
```

the **inner** `max(a)` — which binds to `other` — was rewritten to `max(z)`, which then
resolved against the outer `src` frame instead. The default went from returning 99 to
returning 1, with no error at any point. The CHECK spelling of the same shape failed the
next insert with `CHECK constraint failed`. Verified in-process before and after.

Fixed by passing the resolver on all three arms (`alter-table.ts` ~2339 / ~2382 / ~2402),
which also puts the live propagation back in step with the probe that vets it. Pinned by a
new §37 in `41.3-alter-rename-propagation.sqllogic` covering both the DEFAULT arm (this
ticket's) and the CHECK arm (pre-existing, same hole); sabotage-verified — corrupting the
expected value fails the suite at `41.3:1042`.

## Filed as new tickets

**`fix/bug-table-rename-invisible-to-column-defaults`** — the *table* verb has the exact
blind spot this ticket fixed for the column verb: `alter table u rename to u2` rewrites
another table's CHECK constraints and index predicates but never its column defaults, so a
table with `default ((select min(v) from u))` stops accepting rows. Verified in-process.
Not folded into this pass: it needs a new rewriter entry point plus an arm in the store's
*rename-table* hook (a separate file from the one this ticket touched), i.e. its own diff
and its own store leg.

**Appended as a second arm to `backlog/bug-drop-column-skips-check-on-another-table`** —
the new DEFAULT drop guard scans only the altered table's own columns, so dropping a
column that *another* table's default reaches through a subquery is still accepted and
leaves that table unwritable. Verified. Same site, same probe question and same cost
question as the CHECK arm that ticket already tracks, so it belongs there rather than in a
ticket of its own.

## Checked and clean

- **The implementer's two flagged decisions both hold.** No per-column shallow copy in
  the rewrite arm: `changed` is what re-registers the table, and keeping array identity
  matches `adoptSchemaOnOpenLayers`'s discipline — correct as argued. The
  generated-column DROP guard staying on `generatedColumnDependencies` is likewise fine;
  the two mechanisms agree on policy and the index map is load-bearing for evaluation
  order.
- **Guard ordering in `runDropColumn`.** The new guard sits after the
  column-exists / PK / last-column / generated / partial-index checks, so a
  nonexistent column still reports "not found" rather than a DEFAULT refusal, and it
  runs before `requireVtabModule` / `module.alterTable`, so a refusal persists nothing.
- **The memory module genuinely needs no arm.** Confirmed by reading, not assumed:
  `MemoryTableManager.renameColumn` rewrites index predicates *only* because
  `createSecondaryIndexes` recompiles them during the rebuild; it compiles neither a
  default nor a generated expression, and it does not rewrite CHECK constraints either —
  so a columns arm would be exactly as absent as the CHECK arm already is, by the same
  reasoning. Nothing to add.
- **Rename edge cases probed in-process, all correct:** renaming the column that *owns*
  the default (`b` → `c`, module-hook path rebuilds that `ColumnSchema` from the AST);
  a rename round trip `a → z → a`; dropping the default's owning column.
- **Mutation-context variables are not a new exposure.** A default may read a context
  variable by bare name, which the seeded walk would rewrite if it collided with the
  renamed column's name — but that collision already makes the table unwritable, tracked
  by `bug-context-variable-sharing-a-column-name-breaks-all-writes`. The qualified
  spelling (`context.x`) is never matched: only `new` / `old` are row-image qualifiers.
- **Docs re-read against the new reality** (`sql-alter.md` RENAME COLUMN / DROP COLUMN,
  `sql-ddl.md` § Default Values). Accurate, including the claim that a foreign object's
  reference "resolves against that subquery's own FROM" — which the resolver fix above is
  what makes true.
- **Test coverage is real, not decorative.** The implementer sabotage-verified their
  groups; spot-checked §37's own sabotage here. Coverage spans happy path, case folding,
  the `SET DEFAULT` spelling, both column expressions on one table, both scope edges
  (under- and over-rewrite), the drop guard's four cases, the differ round trip, and the
  store reopen.
- **Source hygiene.** No file grew a section that wants splitting; the new guard and the
  new rewriter entry point are each one short function next to their siblings. The
  implementer's drive-by (inline `import('…').ColumnSchema` → top-level `import type`)
  is correct per AGENTS.md.

## Tripwires recorded

None new. The two conditional concerns in this area already carry `NOTE:` comments at
their sites — the probe cost of `columnReferencedInAst` (one spine clone + one walk per
probe, `rename-rewriter.ts` ~524) and the differ's redundant `SET DEFAULT`
(`schema-differ.ts` ~2429). The new drop guard's cost is the same shape and scale as the
CHECK guard beside it and is covered by that existing note.

## Known gaps carried forward, unchanged

- Generated columns still vanish across a store reopen (`formatColumnDef` emits no
  `generated always as` clause) — `fix/bug-store-reopen-loses-computed-columns`. The
  store arm covers `generatedExpr` anyway, correct-but-inert until that lands.
- `generated always as (T.a + 1)` (table-qualified, own table) is unusable with or
  without a rename — `bug-generated-column-own-table-qualified-reference-unusable`.
- Rename propagation still walks only the renamed object's own schema —
  `bug-rename-not-propagated-across-schemas`.

# Validation

- `yarn test` — 8696 passing / 13 pending (quereus); every other package green
- `yarn test:store` — 8688 passing / 21 pending
- `yarn typecheck` — clean
- `yarn lint` — clean

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
