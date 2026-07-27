----
description: If a transaction postpones a foreign-key check to commit time and then renames one of the tables involved, the commit either dies with a confusing internal error or wrongly reports a constraint violation. Make the postponed check follow the rename.
prereq:
files:
  - packages/quereus/src/runtime/deferred-constraint-queue.ts   # the queue; buckets keyed by table name, evaluator closures frozen at row time
  - packages/quereus/src/runtime/types.ts                       # RuntimeContext — where the name-remap slot goes
  - packages/quereus/src/runtime/emit/scan.ts                   # the ONLY runtime site that resolves a scanned table by name (module.connect)
  - packages/quereus/src/runtime/emit/alter-table.ts            # runRenameTable — must notify the queue
  - packages/quereus/src/runtime/emit/constraint-check.ts       # enqueue site (row-time defer decision)
  - packages/quereus/src/core/derived-row-validator.ts          # second enqueue site
  - packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic  # neighbouring deferred-FK coverage
difficulty: medium
----

# Deferred constraint checks must follow an `ALTER TABLE ... RENAME TO` in the same transaction

## The bug, in plain terms

A foreign key declared `deferrable initially deferred` is not checked when the row is written.
The engine parks the row on a queue and checks it at `commit`. If the same transaction also
renames one of the tables the parked check has to read, the check is evaluated against a table
name that no longer exists.

Two different bad outcomes, depending on the storage backend:

- **Memory backend** — `commit` fails with an engine-level error that looks like an internal
  fault, and the constraint is never evaluated at all:

  ```
  Error: Module 'memory' connect failed for table 'pp':
         Memory table definition for 'pp' not found. Cannot connect.
  ```

- **Store backend (`yarn test:store`, LevelDB)** — worse: the connect under the vanished name
  *succeeds* and yields an empty table, so `commit` reports a **false** constraint violation
  (`CHECK constraint failed: _fk_dr_c_pid`) on a transaction that is in fact perfectly valid.
  A silently wrong answer rather than a loud one.

Both reproduce today; both were confirmed by running the regression file below with the fix
disabled.

## Root cause

`ConstraintCheck` emission compiles each constraint expression into a closure
(`emitCallFromPlan(check.expression, ctx).run`) and, when the check defers, hands that closure to
`DeferredConstraintQueue.enqueue` (`runtime/emit/constraint-check.ts`, the `metadata.shouldDefer`
branch). The closure is frozen: it carries the plan tree that was built when the row was written.

Inside that plan tree, the leaf that reads the referenced table is `emitSeqScan`
(`runtime/emit/scan.ts`). Its emitter closure captures `schema = source.tableSchema` and at run
time calls:

```ts
vtabInstance = await module.connect(
    runtimeCtx.db, capturedModuleInfo.auxData, schema.vtabModuleName,
    schema.schemaName, schema.name, options);
```

`schema.name` is the **emit-time** name. `runRenameTable` (`runtime/emit/alter-table.ts`) re-keys
the module's internal registration, the catalog, the batched events, and the dependent ASTs — but
nothing re-points the already-queued closures. At commit the closure asks the module for a table
that no longer exists under that name.

`emitSeqScan` is the only runtime site a deferred check can reach that resolves a table by name;
verified by auditing every `module.connect(` call in `packages/quereus/src` — the others are
`analyze.ts`, `remote-query.ts`, `schema/manager.ts` (rehydration) and `runtime/utils.ts`
`getVTable` (the DML path), none of which a read-only deferred check drives.

Separately, `DeferredConstraintQueue`'s bucket key is the write-time table name (`enqueue`
lowercases `baseTable`), and `findConnection`'s name fallback matches on it. That is the concern
the existing `NOTE` at `deferred-constraint-queue.ts:172` describes and explicitly hands to this
ticket.

## The correction

Validated as a prototype against the whole `packages/quereus` suite (6675 passing) and against
the store backend, then reverted — reproduce it as production code.

**A per-entry name remap, scoped to deferred evaluation.** Not a database-wide alias table: a
global old→new map would misdirect a scan of a *fresh* table that reuses the freed name
(`alter table pp rename to pp2; create table pp (...)` is legal inside one transaction). Only
entries queued *before* a rename may be remapped, so the map has to live on the entry.

Three pieces:

**1. `RuntimeContext` gains an optional remap** (`runtime/types.ts`):

```ts
/**
 * Lowercase `<schema>.<name>` as written at emit time → the name that table
 * carries NOW. Set only while the deferred-constraint queue evaluates an
 * evaluator frozen before an `ALTER TABLE ... RENAME TO`; undefined everywhere
 * else, so the scan leaf pays one `?.` on the hot path.
 */
tableNameRemap?: ReadonlyMap<string, string>;
```

**2. `emitSeqScan`'s `run` consults it** before connecting (`runtime/emit/scan.ts`):

```ts
const effectiveName = runtimeCtx.tableNameRemap?.get(
    `${schema.schemaName}.${schema.name}`.toLowerCase()) ?? schema.name;
```

and passes `effectiveName` to `module.connect` in place of `schema.name`. Nothing else in the
scan is name-bound — `schema.columns`, the row descriptor and the `FilterInfo` are all
positional, and a table rename changes no column.

**3. `DeferredConstraintQueue` records renames and re-keys buckets.** `DeferredConstraintRow`
gains `tableRenames?: Map<string, string>`; `cloneAll` must carry it forward. A new method:

```ts
notifyTableRename(schemaName: string, oldName: string, newName: string): void
```

which, over `this.entries` and every layer in `this.layers`:

- for every already-queued entry, rewrites any existing map **value** equal to `oldName` to
  `newName` (so `pp → pp2 → pp3` composes), then sets `<schema>.<oldName>` → `newName`;
- moves the bucket keyed `<schema>.<oldName>` to `<schema>.<newName>`, merging per-constraint row
  lists if the destination bucket already exists.

`runDeferredRows` then sets `runtimeCtx.tableNameRemap = entry.tableRenames` alongside the
existing `runtimeCtx.activeConnection = connection` assignment, per entry.

**4. `runRenameTable` notifies the queue.** In `runtime/emit/alter-table.ts`, immediately after
the existing `renameBatchedEvents` call (same reasoning for the placement: after the module
`renameTable`, before the catalog swap):

```ts
rctx.db.getDeferredConstraints().notifyTableRename(tableSchema.schemaName, oldName, newName);
```

`Database.getDeferredConstraints()` is already public (it is the `TransactionManagerContext`
implementation).

**5. Update the `NOTE` at `deferred-constraint-queue.ts:172.** It defers exactly this case to this
ticket and says "if that fix makes rename-then-deferred-check reachable, key the fallback off the
table's CURRENT name rather than the write-time one." The bucket re-key in step 3 does that;
rewrite the note to describe the mechanism rather than the deferral.

### Alternative considered and rejected

Re-planning each deferred check at commit time against the live catalog (the constraint's AST is
still on `RowConstraintSchema.expr`) would handle rename plus any other mid-transaction schema
change in one stroke. Rejected as disproportionate here: it needs the flat OLD/NEW row descriptor
rebuilt so its attribute ids match a freshly-built expression, it re-enters the planner from
inside commit, and it still cannot handle a column added or dropped between the write and the
commit (the parked row's arity would no longer match). Worth revisiting only if more
schema-change-versus-deferred-check shapes turn up.

## What already works — cover it, don't fix it

Confirmed passing on the memory backend *before* any change; the regression file locks them in:

- renaming only the **child** (the table the parked row belongs to);
- `alter table ... rename column` on either side, including a column the check reads — column
  references were resolved to indices at plan time, so a rename does not disturb them;
- `alter table ... add column` on the referenced parent;
- `drop table` on the referenced parent is correctly rejected up front
  (`FOREIGN KEY constraint failed: cannot drop table 'pp' because table 'cc' still has rows
  referencing it`).

## Regression coverage

Add `packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` with the content below.
It sits next to the existing deferred-FK coverage in `41-fk-cascade-conflict-and-self-ref.sqllogic`
(case 10 there is the self-referential forward-reference shape case 3 below extends) and runs on
both backends. Verified: **fails** on memory (connect error) and on store (false constraint
violation) without the fix, **passes** on both with it.

```
-- Deferred FK checks queued before an `alter table ... rename to` in the SAME
-- transaction must still evaluate at commit, against the table's CURRENT name.
-- Regression for: a queued check whose evaluator was compiled against the
-- pre-rename name failed the COMMIT with an engine-level "connect failed"
-- (memory) or a false constraint violation (store) instead of passing.

pragma foreign_keys = true;

-- ===================================
-- 1. Renaming the PARENT after the deferred check is queued
-- ===================================

create table dr_p (id integer primary key);
create table dr_c (id integer primary key,
	pid integer null references dr_p(id) deferrable initially deferred);

begin;
insert into dr_c values (10, 1);   -- queues the deferred FK check against dr_p
alter table dr_p rename to dr_p2;
insert into dr_p2 values (1);      -- the parent row the check needs
commit;

select id, pid from dr_c order by id;
→ [{"id":10,"pid":1}]

select id from dr_p2 order by id;
→ [{"id":1}]

-- ===================================
-- 2. Same shape, but the parent row never arrives — the check must still be
--    evaluated and must REPORT the violation (not an internal error).
-- ===================================

create table dr_p3 (id integer primary key);
create table dr_c3 (id integer primary key,
	pid integer null references dr_p3(id) deferrable initially deferred);

begin;
insert into dr_c3 values (10, 1);
alter table dr_p3 rename to dr_p4;
commit;
-- error: constraint

select count(*) as cnt from dr_c3;
→ [{"cnt":0}]

-- ===================================
-- 3. Self-referential deferred FK + rename (case 10 of
--    41-fk-cascade-conflict-and-self-ref.sqllogic, plus a rename)
-- ===================================

create table dr_sd (id integer primary key,
	pid integer null references dr_sd(id) deferrable initially deferred);

begin;
insert into dr_sd values (2, 1);   -- forward reference: parent not there yet
alter table dr_sd rename to dr_sd2;
insert into dr_sd2 values (1, null);
commit;

select id, pid from dr_sd2 order by id;
→ [{"id":1,"pid":null},{"id":2,"pid":1}]

-- ===================================
-- 4. Renaming only the CHILD (the table the queued row belongs to)
-- ===================================

create table dr_p5 (id integer primary key);
create table dr_c5 (id integer primary key,
	pid integer null references dr_p5(id) deferrable initially deferred);

begin;
insert into dr_c5 values (10, 1);
alter table dr_c5 rename to dr_c6;
insert into dr_p5 values (1);
commit;

select id, pid from dr_c6 order by id;
→ [{"id":10,"pid":1}]

-- ===================================
-- 5. Two renames of the same table in one transaction
-- ===================================

create table dr_p7 (id integer primary key);
create table dr_c7 (id integer primary key,
	pid integer null references dr_p7(id) deferrable initially deferred);

begin;
insert into dr_c7 values (10, 1);
alter table dr_p7 rename to dr_p8;
alter table dr_p8 rename to dr_p9;
insert into dr_p9 values (1);
commit;

select id, pid from dr_c7 order by id;
→ [{"id":10,"pid":1}]

-- ===================================
-- 6. Renaming a column the deferred check reads, on both sides
-- ===================================

create table dr_p10 (id integer primary key, tag text);
create table dr_c10 (id integer primary key,
	pid integer null references dr_p10(id) deferrable initially deferred);

begin;
insert into dr_c10 values (10, 1);
alter table dr_p10 rename column id to key_id;
alter table dr_c10 rename column pid to parent_id;
insert into dr_p10 values (1, 'x');
commit;

select id, parent_id from dr_c10 order by id;
→ [{"id":10,"parent_id":1}]
```

Add one case the prototype did not cover, since it is the reason the remap is per-entry rather
than global — a freed name reused inside the same transaction must NOT be redirected:

```
create table dr_p11 (id integer primary key);
create table dr_c11 (id integer primary key,
	pid integer null references dr_p11(id) deferrable initially deferred);

begin;
insert into dr_c11 values (10, 1);
alter table dr_p11 rename to dr_p12;   -- the FK now points at dr_p12
insert into dr_p12 values (1);
create table dr_p11 (id integer primary key);   -- fresh, unrelated table
insert into dr_p11 values (99);
commit;

select id, pid from dr_c11 order by id;
→ [{"id":10,"pid":1}]
select id from dr_p11 order by id;
→ [{"id":99}]
```

Run it single-file while iterating:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "41.11"
QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "41.11"
```

## Tripwire to record in code, not as a ticket

`notifyTableRename` stamps every pending entry — including entries below the current savepoint
layer — and popping a layer (`rollbackLayer`) does not unstamp them. That is correct **today**
because a catalog rename is not rolled back at all: memory declares the `'non-transactional'` DDL
tier, so `rollback to <savepoint>` and even a whole `rollback` leave `alter table t rename to t2`
applied (verified directly; this is the decided contract, and raising the backends is the separate
backlog ticket `feat-transactional-ddl-native-backends`). If that ticket ever lands, the remap must
become layer-scoped alongside the catalog. Put this as a `NOTE:` comment on `notifyTableRename`.

## TODO

- Add `tableNameRemap?: ReadonlyMap<string, string>` to `RuntimeContext` with a comment saying it
  is set only during deferred-constraint evaluation.
- Resolve the effective table name through it in `emitSeqScan`'s `run` before `module.connect`.
- Add `tableRenames?: Map<string, string>` to `DeferredConstraintRow`; carry it through `cloneAll`.
- Implement `DeferredConstraintQueue.notifyTableRename(schemaName, oldName, newName)`: compose the
  per-entry maps across repeated renames, and re-key the affected bucket (merging into an existing
  destination bucket rather than clobbering it).
- Set `runtimeCtx.tableNameRemap = entry.tableRenames` per entry in `runDeferredRows`.
- Call `notifyTableRename` from `runRenameTable`, right after `renameBatchedEvents`.
- Rewrite the `NOTE` at `deferred-constraint-queue.ts:172` now that the bucket key follows the
  rename; add the savepoint-layering `NOTE:` on `notifyTableRename`.
- Add `packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` (content above, plus the
  reused-name case).
- Check whether `docs/` needs a line — `docs/schema.md` / `docs/memory-table.md` § DDL and
  transactions are the candidates for "a rename inside a transaction does not disturb a deferred
  check".
- Validate: `yarn lint`, `yarn test`, and `yarn test:store` (the store backend is where the failure
  mode is a silently wrong answer, so it is not optional here).
