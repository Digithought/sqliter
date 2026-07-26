----
description: When a column's type is changed inside a transaction on a table that stages uncommitted writes separately, the rows written earlier in that same transaction keep their old-typed values — so after the commit the table holds values that do not match its own declared column type, and a plain equality query cannot find them.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable (~1311); deriveSetNotNullBackfill / SetNotNullBackfillContext (~121); the stale NOTE at ~116
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # "ALTER over staged overlay rows" describe — where the regression test belongs
difficulty: medium
----

# Retype inside a transaction skips the transaction's own staged rows (isolation layer)

## Reproduced

On `main`, memory backend wrapped by `IsolationModule` (the same wrapper the LevelDB store runs
under):

```sql
create table t (id integer primary key, v text) using isolated;
insert into t values (1, '10');
begin;
insert into t values (2, '20');            -- staged in this connection's private overlay
alter table t alter column v set data type integer;   -- accepted
commit;
```

Afterwards:

```
select id, v, typeof(v) from t;   -- [{id:1, v:10, 'integer'}, {id:2, v:'20', 'text'}]
select type from table_info('t') where name='v';   -- INTEGER
select id from t where v = 20;    -- []          <-- row 2 is invisible to equality
select id from t where v > 5;     -- [1, 2]      <-- but visible to a range scan
```

Row 2 committed with a text value under a column the catalog calls INTEGER. Equality misses it;
inequality finds it. Nothing warns, and nothing is left to signal the inconsistency.

## Why it happens

Each connection's uncommitted writes are held in a private staging area ("overlay") owned by the
isolation layer, not by the storage module underneath. When a schema change lands, the isolation
layer walks every affected overlay and rewrites the staged rows into the new shape — it does this
for `add column`, `drop column`, and the `set not null` NULL → DEFAULT backfill, each of which has
a small precomputed context object driving a per-row rewrite loop.

`set data type` has no such context. Its value conversion happens entirely inside the storage
module, over that module's *committed* rows, so an overlay row never passes through it. The gap is
already known — `isolation-module.ts` carries a `NOTE:` saying a parallel context should be hooked
through the same derive → validate → translate seam — but the note points at a ticket that has
since completed, so no open work item exists.

The same seam already rejects an un-migratable overlay row atomically before the underlying module
is touched (that is how a staged NULL under `set not null` with no default aborts the whole ALTER),
so the machinery for "convert, or reject the ALTER" is in place.

## Expected behavior

An accepted `alter column … set data type` must leave *every* row the issuing connection can see —
committed and staged alike — holding a value of the new type. If a staged value cannot be
converted, the ALTER must reject with `MISMATCH` before anything is mutated, exactly as an
unconvertible committed value already does. A committed table must never hold a value whose type
contradicts its own column declaration.

## Notes for whoever picks this up

*   The engine-level (unwrapped memory) path is correct: `MemoryTableManager` converts its own open
    transaction layers via `convertColumnOnOpenLayers`. That call simply no-ops under the wrapper,
    because the pending rows are not in any layer it owns.
*   Related but distinct, both already handled: the uniqueness re-validation of a value-rewriting
    ALTER does see overlay rows (`bug-retype-unique-revalidation-memory`), and the store's own
    rewrite ordering is `bug-retype-unique-revalidation-store`. Neither converts overlay rows.
*   Interaction worth stating in the fix: because the uniqueness probe judges overlay rows as
    *converted* while the honored path leaves them *unconverted*, the two disagree today — a
    collision the probe rejects may not exist after the (broken) rewrite, and vice versa. Closing
    this gap removes the disagreement rather than needing separate handling.
*   A prior review of `alter-column-set-data-type-sees-transaction-rows` saw this gap and chose not
    to file it, treating it as a mirror of the documented `set collate` overlay limitation. It is
    filed now because the symptom is committed data that contradicts the declared schema and is
    unreachable by an equality query — worse than a validation blind spot. Close as a duplicate if
    that call is revisited.
