---
description: Adding a column at a chosen spot (rather than at the end) already works correctly through the transaction-isolation layer, but nothing tests it — so a future edit could quietly break it. Add the tests.
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # add a describe block next to the existing one at ~2888
  - packages/quereus-isolation/src/alter-migration.ts         # buildOverlayAddColumnChange (~708) — behavior under test; do not change
  - packages/quereus-isolation/README.md                      # ALTER section (~141) — one line to add
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts   # PositionedMemoryModule (~44) — the harness pattern to mirror
difficulty: easy
---

# Pin the caller-chosen ADD COLUMN position through the isolation layer

## What this is (and is not)

**This is a test-only ticket. The behavior is already correct — do not "fix" it.**

Background: each open connection to an isolated table gets a private side table (an
"overlay") holding rows that connection has written but not committed. The overlay has the
same columns as the real table plus one extra bookkeeping column at the end that marks a row
as deleted.

`alter table … add column` normally appends. The `addColumn` schema change carries an optional
`insertAtIndex` that asks for the new column at a specific slot instead. There is no SQL
syntax for it — an in-process module wrapper is the only thing that can set it.

The original filing said the isolation layer forwarded that position to the storage module
underneath while unconditionally appending in its own overlay rows, so the two layouts would
disagree. **That is stale.** The function it named (`translateOverlayRow`) no longer exists;
`buildOverlayAddColumnChange` in `alter-migration.ts` now hands the overlay
`insertAtIndex: change.insertAtIndex ?? tombstoneIdx` — a caller-named position is honored,
and with no position the column lands ahead of the bookkeeping flag so the flag stays last.

I drove the caller-named path end to end against the current tree and it behaves correctly in
every case listed below (observed values are recorded, so they are the assertions to write).

What is missing is coverage. The existing block — `in-transaction column-shape ALTER keeps the
overlay tombstone flag last` at `isolation-layer.spec.ts:2888` — only exercises the *default*
arm (no caller position, so `?? tombstoneIdx` applies). Collapsing
`change.insertAtIndex ?? tombstoneIdx` to a bare `tombstoneIdx` would pass the whole suite
today. That is the regression this ticket closes.

## Harness

Mirror `PositionedMemoryModule` from
`packages/quereus/test/alter-column-open-transaction-layer.spec.ts:44` — a subclass whose
`alterTable` override injects `insertAtIndex` into an `addColumn` change and otherwise
delegates:

```ts
class PositionedIsolationModule extends IsolationModule {
	public insertAt: number | undefined;

	override async alterTable(db, schemaName, tableName, change, rows) {
		const positioned = change.type === 'addColumn' && this.insertAt !== undefined
			? { ...change, insertAtIndex: this.insertAt }
			: change;
		return super.alterTable(db, schemaName, tableName, positioned, rows);
	}
}
```

Driving the ALTER through `db.exec('alter table … add column …')` with that module registered
keeps the engine's catalog in step, so a plain `select *` is a meaningful assertion. For the
cross-connection case, call `iso.alterTable(...)` directly with the position in the change and
build the foreign overlay the way `injectOverlay` does at `isolation-layer.spec.ts:3182`
(`iso.overlayModule.create` + `iso.createOverlaySchema` + `iso.setConnectionOverlay`).

## Cases to cover, with the values I observed

Table shape unless stated: `create table t (id integer primary key, v text) using isolated`,
one committed row, one row inserted inside an open transaction, `add column w text default 'z'`.

- **Position 0, staged + committed rows.** Column order `["w","id","v"]`. In-transaction and
  post-commit `select *` both give `[{w:'z',id:1,v:'a'},{w:'z',id:2,v:'b'}]`.
- **Writes after the reshape.** After the position-0 ALTER: `update … set w = 'upd' where id = 2`,
  `insert into t values ('fresh', 3, 'c')` (new layout), `delete … where id = 1`.
  Post-commit: `[{w:'upd',id:2,v:'b'},{w:'fresh',id:3,v:'c'}]`. This is the case that would
  catch a row/schema layout disagreement — a value written to the new column must read back
  under that column's name.
- **Staged deletion survives.** Two committed rows, `delete where id = 1` before a position-1
  ALTER, plus a staged insert. Column order `["id","w","v"]`; post-commit
  `[{id:2,w:'z',v:'b'},{id:3,w:'z',v:'c'}]` — the deleted row stays deleted.
- **Multi-column primary key + secondary index, insert ahead of both.**
  `create table t (k1 integer, v text, k2 integer, primary key (k1, k2))`, `create index … on t(v)`,
  position 0. Column order `["w","k1","v","k2"]`; `select v from t where k1 = 2 and k2 = 20`
  and `select k1 from t where v = 'q'` both still hit, in-transaction and post-commit. (The
  memory module renumbers the index-bearing schema fields; this pins that the isolation layer
  rides along.)
- **Position equal to the base's column count.** `insertAt = 2` on a 2-column base — the
  base's own append slot, which for the overlay means "ahead of the bookkeeping flag".
  Indistinguishable from a plain append: order `["id","v","w"]`, values as the default arm.
- **Out-of-range position rejected clean.** `insertAt = 99` throws
  `Cannot add column 'w' at position 99: expected an integer in [0, 2]`. Assert the catalog
  still lists `["id","v"]`, the rows are unchanged, and the open transaction still commits
  (the rejection happens before anything irreversible).
- **Cross-connection foreign overlay.** Connection A issues the ALTER; connection B has an
  overlay holding one live staged row and one deletion marker. With
  `insertAtIndex: 0` and `c integer default 42`: base columns `["c","id","x"]`, B's overlay
  schema `["c","id","x","_tombstone"]`, B's overlay rows `[[42,10,7,0],[null,11,null,1]]` —
  backfilled value at slot 0, `null` at that slot for the deletion marker, flag still last —
  and B's overlay is **not** poisoned.
- **Under a savepoint.** Positioned ALTER between `savepoint s` and `rollback to savepoint s`,
  then commit. DDL is not transactional here, so the column stays; what must survive is the
  pre-savepoint write. Mirror the shape of the existing savepoint ADD COLUMN test at
  `isolation-layer.spec.ts:~2025`.

## Edge cases & interactions

- **A failing assertion here is a real defect, not a test to loosen.** Every case above was
  observed passing on the current tree. If one fails, something regressed between this ticket
  being written and the work landing — report it, don't adjust the expectation.
- **Do not add a `@quereus/store` dependency to the isolation package** to test the
  store-rejects-a-position path. That package depends only on `@quereus/quereus` today, and the
  store's rejection is already covered by `packages/quereus-store/test/alter-table.spec.ts:105`.
  If the "underlying refuses the ALTER" path through the isolation layer is worth pinning, use a
  stub underlying module in-package — but treat that as optional, and skip it rather than
  growing the dependency graph.
- **Keep the new block separate from the existing one at `:2888`.** That block's comment is
  specifically about the no-position default arm; a new sibling describe (`ADD COLUMN at a
  caller-chosen position`) keeps the two intents legible.
- **The subclass must leave a change with no position untouched** — one case should confirm
  that `insertAt = undefined` still produces an append, so the harness itself cannot mask the
  default arm.
- Reads must go through `select *` or an explicit column list bound by name, not by row index —
  the whole failure mode being pinned is values arriving under the wrong column name.

## TODO

- Add a `PositionedIsolationModule` harness to `packages/quereus-isolation/test/isolation-layer.spec.ts`
- Add a `describe('ADD COLUMN at a caller-chosen position (isolation layer)')` block next to the
  existing tombstone-flag-last block, covering each case above
- Include the cross-connection foreign-overlay case, reusing the overlay-injection pattern at
  `isolation-layer.spec.ts:3182`
- Run `yarn workspace @quereus/isolation test` and confirm green; run `yarn test` for the whole
  workspace before handing off
- Run `yarn workspace @quereus/isolation run typecheck` (its `tsconfig.test.json` pass covers
  the new spec)
- Add one line to the ALTER section of `packages/quereus-isolation/README.md` (~141) stating that
  a caller-supplied `insertAtIndex` is honored in the overlay, and that with none supplied the
  new column lands ahead of the overlay's deletion-marker column so that marker stays last
