---
description: A column's default value written as a query used to look up the tables it names using whatever database the writing statement was pointed at, instead of the one the table itself lives in. All four kinds of expression a table can carry in its own definition now resolve names the same way, on every path that evaluates one.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts   # the fix — required schemaName param, narrows schemaPath
  - packages/quereus/src/planner/building/insert.ts                    # two contexts collapsed to one
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/delete.ts
  - packages/quereus/src/planner/building/constraint-builder.ts        # internal narrowing removed
  - packages/quereus/src/planner/building/foreign-key-builder.ts       # internal narrowing removed (2 sites)
  - packages/quereus/src/core/derived-row-validator.ts                 # fresh context now wrapped
  - packages/quereus/src/planner/building/view-mutation-builder.ts     # buildKeyDefault takes the anchor's schema
  - packages/quereus/src/planner/mutation/multi-source.ts              # carries keyDefaultSchemaName
  - packages/quereus/src/planner/mutation/decomposition.ts             # carries keyDefaultSchemaName
  - packages/quereus/src/planner/building/alter-table.ts               # ADD COLUMN backfill AND its CHECK predicates now wrapped
  - packages/quereus/src/runtime/emit/alter-table.ts                   # review fix — ADD COLUMN existing-row CHECK scan
  - packages/quereus/src/schema/constraint-builder.ts                  # review fix — maintained-table existing-row CHECK scan
  - packages/quereus/src/planner/stored-body-context.ts                # sibling doc comment updated
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic
  - docs/schema.md
  - docs/sql-select.md                                                 # review fix — §2.1.1 and the CTE-visibility bullet
repro: verified
---

# Schema-authored expressions resolve names against the owning table's schema

## What shipped

Four kinds of expression can be written inside a table's own definition: a column
`default`, a generated-column expression, a `check` constraint, and the existence probe
the engine synthesizes for a foreign key. All four are authored by whoever wrote the
table, not by whoever writes a row, so an unqualified relation name in any of them means
the owning table's schema — and **only** that schema, with no fallback to the session
default path.

The narrowing lives in one place for everything that is *built*:
`schemaAuthoredContext` (`planner/building/schema-authored-context.ts`), whose owning
schema name is a required parameter:

```ts
schemaAuthoredContext(ctx, schemaName)
// → { ...ctx, cteNodes: undefined, cteReferenceCache: undefined, schemaPath: [schemaName] }
```

The duplicate narrowings inside `buildConstraintChecks` and both foreign-key builders were
removed so one place decides; `core/derived-row-validator.ts`, which builds those same two
builders on its own fresh planning context, is wrapped so removing them did not silently
drop narrowing for a maintained table. For a multi-source / decomposition view insert the
anchor key column's declared `default` belongs to the **anchor base table's** schema, which
can differ from the view's, so `MsInsertAnalysis` / `DecompInsertAnalysis` carry
`keyDefaultSchemaName` alongside `keyDefault`.

**Behaviour change:** a column `default` or generated-column expression naming a relation
in another schema without qualifying it no longer resolves — it becomes a plan-time
"table not found". That is the rule `check` and foreign-key bodies always had.

## Review findings

Reviewed the implement diff (`b81792f0`) first, then the handoff. Everything below was run,
not read.

### Checked and clean

- **Every call site of the three builders that stopped narrowing themselves.**
  `buildConstraintChecks`, `buildChildSideFKChecks`, `buildParentSideFKChecks` and
  `buildNotNullDefaults` have exactly six call sites (`insert.ts`, `update.ts` ×4,
  `delete.ts` ×2, `derived-row-validator.ts` ×2); all now receive a context derived from
  `schemaAuthoredContext` with the right owner. For the parent-side probe the owner is the
  table being written (the parent), which is what the removed internal narrowing used too —
  no change.
- **`createRowExpansionProjection` now runs on the narrowed context.** Confirmed it builds
  only defaults, generated columns, literals and source column references — no
  user-written statement expression rides that context, so narrowing it cannot change what
  a user's `values` row or source `select` binds.
- **Lens-synthesized `extraConstraints`** are built against the base table's schema rather
  than the view's. Pre-existing (the removed internal narrowing did the same); unchanged by
  this diff, so not reopened here.
- **Function resolution** does not consult `schemaPath`, so narrowing cannot break a
  `mutation_ordinal()` / user-function reference inside a default.
- **`stmt.schemaPath` threading** through `planner/mutation/decomposition.ts` targets the
  statement's own relation resolution, not schema-authored expressions — untouched and
  correct.

### Found and fixed in this pass

- **`alter table … add column … check (<subquery>)` resolved the CHECK on the writer's
  path.** Two distinct sites, both verified with a repro before and after:
  - `validateBackfillAgainstChecks` (`runtime/emit/alter-table.ts`) re-prepares the
    constraint's SQL text as a whole `select … where not (<check>)` statement, which
    inherits the *session* path. On a `temp` table under `pragma schema_path = 'main'`,
    `check ((select count(*) from c) = 1)` was **accepted** (reading `main.c`, 1 row) and
    `= 3` **rejected** (the `temp.c` beside the table has 3) — exactly inverted. Now pins
    `stmt._schemaPathOverride = [columnOnlySchema.schemaName]`; both directions verified
    to flip back.
  - `buildAddColumnChecks` (`planner/building/alter-table.ts`) compiles the per-row CHECK
    predicates on the raw ALTER context. Wrapped in `schemaAuthoredContext`. Not testable
    today: those predicates only exist when the ADD COLUMN has a per-row backfill, which is
    exactly the case `bug-alter-add-column-relation-default-fails-to-emit` blocks. Fixed
    anyway so that ticket does not ship a fresh instance.
- **A maintained table's declared CHECK was validated against existing rows on the session
  path.** `validateChecksOverExistingRows` (`schema/constraint-builder.ts`) re-prepares the
  constraint text the same way. `create table temp.mt (… check (n <= (select count(*) from c)))
  maintained as …` under session path `main` was rejected at create time against `main.c`.
  Now pins the owning schema. Verified by reverting the fix and watching the create fail.
- **The `derived-row-validator.ts` gap the handoff flagged as "reasoned, not demonstrated"
  is now demonstrated.** The maintained-table arm above also derives rows *after* creation,
  which routes through that validator. Reverting the wrap makes the arm fail with
  `CHECK constraint failed: _check_n … maintained table 'temp.mt'`.
- **Docs that should have been touched and were not.** `docs/sql-select.md` §2.1.1 still
  said a CHECK / foreign-key body falls back to the session default path (never true) and
  said nothing about defaults or generated columns; the CTE-visibility bullet at the
  §"Common Table Expressions" section described only the CTE half of the isolation. Both
  rewritten to state the one rule for all four kinds. `docs/schema.md` was already correct.

### Considered and dismissed

- `alter table … add column x integer check (…)` with no DEFAULT is rejected with a NOT
  NULL error. Not a defect — `default_column_nullability` ships as `not_null`, so the
  column is mandatory and a non-empty table has nothing to fill it with. Documented in
  `docs/sql-alter.md`.
- `alter table … add constraint … check (…)` does not validate existing rows at all.
  Confirmed with a plain non-subquery predicate, and it is documented as a deliberate
  limitation of the CHECK add path in `docs/sql-alter.md` §ADD CONSTRAINT. Unrelated to
  schema paths; not filed.

### Tripwires recorded, not filed

- The two prepared-statement CHECK-enforcement sites cannot use `schemaAuthoredContext`
  (they never build a planning context), so the rule now has two spellings. A `NOTE:` in
  `planner/building/schema-authored-context.ts` names both sites and says to give the
  statement seam its own helper if a third ever appears, rather than adding a fourth copy.
- The implementer's own tripwire is intact: `buildKeyDefault` falls back to the view's
  schema when `keyDefaultSchemaName` is absent, which is unreachable because both analyses
  set it. `NOTE:` at the site in `view-mutation-builder.ts`.

### Not covered — known remaining gaps

- **Relation-reading ADD COLUMN backfill (DEFAULT / GENERATED) still has no arm**, because
  it still fails to emit at all — `bug-alter-add-column-relation-default-fails-to-emit` in
  `tickets/fix/`. That ticket's body was corrected during this review: its speculation that
  the ADD COLUMN CHECK path has the same emit problem is wrong for the bulk scan (verified
  working) and unverifiable for the per-row predicates until the backfill itself emits.
- **A generated column recomputed by an UPDATE** still has no arm — a subquery-bearing one
  stores the unresolved promise (`bug-update-generated-column-subquery-not-awaited` in
  `tickets/fix/`, unrelated to schema paths). The UPDATE-path narrowing is pinned instead by
  a `check` built on the same context object.
- **Parent-side foreign-key probe** has no schema-path arm; `13.9` covers its
  common-table-expression sibling and the owner is unchanged from before the diff.
- **`yarn test:store` was not run** (LevelDB backend). Planner-level change with no storage
  surface, but a real omission — carried forward from the implement stage.

## Test coverage

`packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic`, the
sibling of `13.9-schema-authored-cte-isolation.sqllogic`. Every arm places a **decoy**
relation in the schema the writer is pointed at, the real one beside the table, makes the
two disagree, and pins the owning schema's answer.

Arms from the implement stage: column `default` under the session `pragma schema_path`;
generated column on INSERT; `not null` default via `insert or replace`; the UPDATE-path
build in both directions; a per-statement `insert … with schema main` while the session
path is `temp`; `check` and child-side foreign key as controls; write-through a view whose
base table is in the non-default schema; the multi-source anchor key default twice
(view+bases both in `temp`, then **view in `main` with the anchor in `temp`** — the arm that
actually pins `keyDefaultSchemaName`); a qualified-reference control; the strict
no-fallback rule; and a user-declared `declare schema` so the coverage is not a `temp`-only
special case. Each was verified to fail with the narrowing disabled.

Arms added in review: `alter table … add column … check (<subquery>)`, both directions; and
a maintained table whose declared CHECK reads a colliding relation, covering the create-time
scan and the per-derived-row validator. Both verified by reverting the corresponding fix.

## Validation

- `yarn test` — green. 8664 quereus tests plus every other workspace package; zero failures.
- `yarn lint` — clean.
- `npx tsc -b tsconfig.build.json` — clean.
- `node scripts/check-docs.mjs` — `docs/schema.md` and `docs/sync.md` over their word
  ratchets. Pre-existing and already tracked as `debt-docs-size-ratchet-red-again` in
  `tickets/.pre-existing-known.md`; neither was grown by this ticket. `docs/sql-select.md`,
  the file this review edited, is not over its ratchet.
