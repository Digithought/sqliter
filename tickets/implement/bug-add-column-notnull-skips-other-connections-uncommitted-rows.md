description: When several connections share a table, adding a column that forbids blanks only checks the rows the connection running the change can see, so another connection's in-progress rows end up blank in that column and get saved that way. Make the other connection fail instead of silently saving a blank.
files:
  - packages/quereus-isolation/src/alter-migration.ts                 # computeAddColumnValue ~line 587 — the fix site
  - packages/quereus-isolation/src/isolation-module.ts                # alterTable ~line 1320-1450 — the issuer/foreign tiering that routes the throw
  - packages/quereus-isolation/test/isolation-layer.spec.ts           # ~line 3071 — "row-validating DDL cross-connection poison semantics" describe block
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # ~line 374 — "ALTER over staged overlay rows (isolation layer)" describe block
  - docs/design-isolation-layer.md                                    # ~line 859 (ALTER: migrate, or poison) — already documents the intended outcome
difficulty: easy
---

# Confirmed behaviour

Reproduced. Two `Database` connections share one `IsolationModule`; the committed table is
empty; connection B has an open transaction with one staged row; connection A adds a NOT NULL
column. Today:

```
B sees:                [ { id: 1, x: 1 } ]
A sees:                []
ALTER accepted         (c.notNull === true)
B sees after alter:    [ { id: 1, x: 1, col_2: null } ]
B commit ok
A sees after B commit: [ { id: 1, x: 1, c: null } ]
```

A NULL lands in a NOT NULL column, in committed storage. Identical with an explicit
`not null` and with the implicit mandatoriness the shipped `default_column_nullability =
'not_null'` gives a bare `add column c integer`.

## Why nothing catches it

Three checks exist and all three miss these rows:

- The engine's `validateNotNullBackfill` (`packages/quereus/src/runtime/emit/alter-table.ts`
  ~line 847) probes `select 1 from t limit 1` on the **issuing** connection. That view is
  committed rows plus the issuer's own staged rows — never a foreign connection's.
- The underlying memory/store module's own "NOT NULL column on a non-empty table" check sees
  committed rows only, and here the committed table is empty.
- The isolation layer's own dry run, `validateOverlayMigration` →
  `computeAddColumnValue` (`packages/quereus-isolation/src/alter-migration.ts` ~line 587),
  enforces NOT NULL **only on the per-row-evaluator branch**. The folded-literal branch
  (`return ctx.foldedDefault`) appends the value unchecked, and for a column with no DEFAULT —
  or a DEFAULT that folds to NULL — that value is `null`.

The comment on that function says the literal branch's nullability "is gated up-front by the
engine". That is the engine probe, and the probe does not cover foreign connections.

**Reachable only when the committed table is empty.** With any committed row present, either
the engine probe or the underlying's own check rejects the ALTER first. Narrow, but real, and
it is exactly the shape a fresh table under concurrent writers takes.

## The scoped-out neighbour

`alter table t add column c integer` issued while the **issuer's own** transaction has staged
rows is already rejected correctly (verified). So is the case where the issuer has staged
DELETEs hiding committed rows from the probe — the underlying's own check still sees the
committed rows and refuses. Neither needs work.

# The fix

Extend the NOT NULL check in `computeAddColumnValue` to the folded-default branch:

```ts
if (ctx.newColNotNull && ctx.foldedDefault === null) {
	throw new QuereusError(
		`NOT NULL constraint failed: column '${ctx.tableName}.${ctx.newColName}' has no usable DEFAULT for a staged row`,
		StatusCode.CONSTRAINT,
	);
}
return ctx.foldedDefault;
```

Everything downstream already exists and needs no change:

- Tombstone rows short-circuit to `null` above this point, so a staged deletion marker never
  trips it. A clean overlay (`!hasChanges`) is skipped entirely by
  `validateOverlayMigration`.
- The **issuer's** overlay runs this in tier 2, before `underlying.alterTable`, so it aborts
  atomically. Belt-and-braces — the engine probe already rejected that case — but it makes
  the module API safe for a direct (non-engine) caller.
- A **foreign** overlay reaches it through `migrateOverlayForward` inside
  `applyInPlaceOverlayChange`, which maps `CONSTRAINT` to **poison**. That is the documented
  answer for this class of failure, and the right one: the design deliberately does *not* let
  a foreign connection's invisible rows abort another connection's ALTER
  (`docs/design-isolation-layer.md`, *ALTER: migrate, or poison*, tier 3).

Verified with a throwaway build of exactly this change — B's next read and its commit both
fail with the existing poison message, the ALTER applies for A, and no NULL is committed:

```
ALTER accepted
B read failed:   ALTER on 'main.t' added column 'c' (NOT NULL) that this connection's
                 uncommitted row cannot satisfy; roll back this transaction.
B commit failed: (same)
A sees after B commit: []
```

# Documentation

`docs/design-isolation-layer.md` line ~859 already states the intended behaviour — "a per-row
`NOT NULL` (`CONSTRAINT`) failure … **poisons** that one overlay". It reads as if it only
covers the per-row evaluator. Widen that phrasing so it plainly covers both sources of a
staged NULL: an evaluator that returns NULL, **and** a mandatory column with no usable DEFAULT
whose staged rows have nothing to fill it with. Add one sentence saying the engine's own
pre-mutation probe sees only the issuing connection, which is why this check is the isolation
layer's own job.

# Test harness notes

Driving this end-to-end through ordinary SQL needs a second `Database` whose catalog knows the
table. `create table` on the second connection would build a *second* underlying, so mirror
the first connection's catalog entry instead:

```ts
dbB.registerModule('isolated', iso);
dbB.schemaManager.getMainSchema().addTable(dbA.schemaManager.getTable('main', 't')!);
```

`dbB` then resolves `t` and reaches `IsolationModule.connect`, which finds the existing
underlying state and shares it. Note dbB's catalog does **not** learn about dbA's ALTER — see
`bug-schema-change-not-propagated-to-other-connections-catalog` in `backlog/`. That does not
affect this ticket's assertions (post-fix, dbB is poisoned and cannot read at all), but do not
assert on dbB's post-ALTER *column names*.

The white-box style already used by the poison suite (`isolation-layer.spec.ts` ~line 3071)
works too and is cheaper, but its `beforeEach` seeds a committed row — this hole needs the
committed table **empty**, or the underlying rejects the ALTER before the overlay is reached.

**Build before testing.** `packages/quereus-isolation` imports `@quereus/quereus` from its
built `dist`, so a stale `dist` silently tests the previous engine. Run `yarn build` first.

# Known pre-existing failure

`yarn test` currently fails one test at HEAD, unrelated to this work:
`alter-table-conformance.spec.ts:386` "honored ADD COLUMN migrates a staged overlay row
forward (NULL in the new column)". It is written against the pre-`default_column_nullability`
behaviour that `bug-add-column-default-null-notnull-hole` changed, and is masked unless
`yarn build` runs first. Recorded in `tickets/.pre-existing-error.md`. Do not fix it here and
do not skip it — the triage pass owns it. If it has already been fixed by the time this runs,
ignore this section.

# TODO

- Add the folded-default NOT NULL throw to `computeAddColumnValue` in
  `packages/quereus-isolation/src/alter-migration.ts`, and update that function's doc comment
  — it currently states the literal branch is gated by the engine, which is what was wrong.
- Update `validateOverlayMigration`'s doc comment (`addColumn` bullet, ~line 469) so it names
  both rejection sources, not just the evaluated row.
- Regression test, SQL-driven, in
  `packages/quereus-isolation/test/alter-table-conformance.spec.ts` under the existing
  "ALTER over staged overlay rows (isolation layer)" describe: two connections, empty
  committed table, B stages a row, A adds a mandatory column; assert A's ALTER succeeds, B's
  next read throws `CONSTRAINT`, B's commit throws `CONSTRAINT`, and the committed table holds
  no row afterwards. Cover both spellings — explicit `not null`, and the bare
  `add column c integer` that is mandatory under the shipped default.
- White-box companion in `isolation-layer.spec.ts`'s poison describe block, alongside the
  existing evaluator case: a `SchemaChangeInfo` for a NOT NULL column with **no** DEFAULT and
  **no** `backfillEvaluator` poisons a foreign overlay. Needs its own empty-committed-table
  setup (the block's shared `beforeEach` inserts a row).
- Assert the negative too: a mandatory column with a usable literal DEFAULT still migrates a
  foreign overlay forward and does **not** poison it. The existing
  `ADD COLUMN forwards a foreign overlay IN PLACE` test covers the shape; confirm it still
  passes rather than duplicating it.
- Widen the *ALTER: migrate, or poison* wording in `docs/design-isolation-layer.md` as above.
- `yarn build && yarn test`, then `yarn lint` and `yarn typecheck`.
