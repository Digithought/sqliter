----
description: When a connection changes the sorting rule of a primary-key column mid-transaction, the check that looks for newly-colliding keys examines the wrong set of rows — so it can refuse over rows the transaction already deleted, and miss a genuine clash between rows the transaction has just inserted.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey / assertNoPrimaryKeyCollision (~3511-3595), alterColumn (~2278, 2568)
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict — the invariant check downstream of the pre-pass
  - packages/quereus/src/vtab/module.ts                      # EffectiveRowSource contract (~412)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # home for the isolated-leg regression tests
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic
difficulty: hard
----

# `alter column … set collate` on a primary-key column judges the wrong rows

## The one-sentence version

`MemoryTableManager.validateRekeyedPrimaryKey` ignores the `rows` argument its caller was
handed, so when the memory module runs underneath a wrapper (the isolation layer) it judges its
own committed rows instead of the rows the issuing transaction can actually see.

## Background

Two rows can have distinct primary keys under one collation and identical ones under another:
`'A'` and `'a'` differ under `BINARY` and are equal under `NOCASE`. So `alter table t alter
column k set collate nocase` on a primary-key column `k` has to prove that no two rows collide
under the new comparator before it re-keys anything.

When a wrapper module sits in front of the memory module — which is the normal engine
configuration, `packages/quereus-isolation` — the transaction's own uncommitted inserts and
deletes live in the wrapper's private staging table, not in the memory module. The wrapper
therefore hands every row-content DDL check a merged stream of "the rows this connection can
see" (`EffectiveRowSource`, `vtab/module.ts`). `MemoryTableManager.alterColumn` receives it as
`rows` and passes it to `validateRekeyedUniqueStructures` — but **not** to
`validateRekeyedPrimaryKey`, which walks the manager's own layer chain instead. There is an
explicit `NOTE:` at `manager.ts` ~2568 recording that omission as deliberate.

## What goes wrong

Both directions of the mismatch are reachable. All four reproduce today against
`IsolationModule({ underlying: new MemoryTableModule() })`.

### A. Rows the transaction deleted still count → wrong error, wrong code

```sql
create table t (k text primary key, v text) using isolated;
insert into t values ('A', 'x'), ('a', 'y'), ('b', 'z');
begin;
delete from t where k in ('A', 'a');               -- both colliders gone, as this txn sees it
alter table t alter column k set collate nocase;
```

Today: `CONSTRAINT` — `UNIQUE constraint failed: t primary key collides under new collation`.

That message says "your data is invalid", which is untrue: the only two rows that collide are
rows this transaction has deleted. Without the isolation layer the identical statement produces
a `BUSY` and a message that tells the user what to do — *"rows this transaction has removed
still collide under the new collation and must survive a rollback. Commit/rollback and retry."*
That is the honest answer and it is what the isolated leg should say too. (Deleting only one of
the two colliders — `delete from t where k = 'a'` — has the same shape and the same wrong
message.)

### B. Rows the transaction staged do NOT count → the check passes, then the wrapper explodes

```sql
create table t (k text primary key, v text) using isolated;
begin;
insert into t values ('A', 'x'), ('a', 'y');       -- both staged, both visible to this txn
alter table t alter column k set collate nocase;
```

Today: `INTERNAL` — *"Isolation layer: applying alter table (alterColumn) to the issuing
connection's overlay … raised: UNIQUE constraint failed … validation and migration have
drifted."* And by the time the user sees it, the shared table's collation **has already
changed**.

This is a genuinely illegal change — two rows the transaction can see collide — and it must be
refused with `CONSTRAINT`, before anything is mutated. It slips through because the memory
module's committed base is empty (both rows are staged in the wrapper's overlay), so the
layer-chain walk sees no collision.

## Why the refusal in case A cannot become an acceptance

The ticket this came from asks for case A to *succeed*. It cannot, and the fix should not try.

The memory module's base layer physically holds the committed rows `'A'`, `'a'`, `'b'`. The
transaction's deletes live in the wrapper's overlay (or, without a wrapper, in a
`TransactionLayer`); a rollback must bring those rows back, so the base has to keep both. The
primary tree is a map, not a multi-map, so a base re-keyed under `NOCASE` cannot represent
`'A'` and `'a'` at once. The same argument holds for the persistent store backend, whose
committed rows are equally still there (see `bug-store-pk-collate-rejects-deleted-row-collision`
in `backlog/`). Accepting would require the schema change to be transaction-scoped, which
Quereus DDL is not (`feat-transactional-ddl-native-backends` in `backlog/` is where that lives).

So the deliberate conservative carve-out introduced by `alter-collate-pk-in-transaction`
(completed) **stays**. What changes is that both legs reach it, and reach it with the right
status code and the retryable wording. Record that decision in the method doc so the next
reader does not re-litigate it.

Case B, by contrast, is a pure defect: the change is illegal and must be refused up front.

## Target behavior

`validateRekeyedPrimaryKey` grows a `rows?: EffectiveRowSource` parameter and becomes async
(the source is an async iterable). Two questions, asked in this order:

1. **Is the change legal at all?** — probe the *effective* rows under the new key functions.
   When `rows` is supplied that is the wrapper's merged stream; otherwise it is the existing
   layered view (`pendingTransactionLayer ?? readLayer`, i.e. what `effectiveDdlRows()`
   returns). A duplicate here is `CONSTRAINT`, and the message should name the colliding key
   rather than only the table.

2. **Can the structures physically carry it?** — probe every layer whose tree a rollback or
   `rollback to savepoint` could restore. When `rows` is supplied the manager's own view layer
   is no longer proven clean by step 1 (its rows are the *committed* ones, a different set), so
   the walk must start **at the view** and continue through its parents; when `rows` is absent
   the view was already proven clean, so the walk starts at the parent, exactly as today. A
   duplicate here is `BUSY` with the existing "commit/rollback and retry" wording.

Resulting classifications, all decided before any mutation:

| Situation (isolated leg)                                        | Code       | Message family |
|-----------------------------------------------------------------|------------|----------------|
| Two rows the transaction can see collide (committed or staged)   | CONSTRAINT | "collides under new collation", names the key |
| Only committed-but-deleted rows collide                          | BUSY       | "commit/rollback and retry" |
| Nothing collides                                                 | —          | proceeds |

The plain memory leg (no wrapper, `rows` undefined) keeps today's behavior exactly; only the
key-naming detail of the `CONSTRAINT` message changes there.

## Scope boundary

This ticket covers the case where a collision is visible to the transaction, or sits in
committed rows. It does **not** cover the case where the wrapper's staging table holds a
*deletion marker* and a staged row that collide only under the new rule — the memory module
correctly accepts that (nothing in its own rows collides) and the wrapper then fails to migrate
its overlay. That is the companion ticket
`isolation-overlay-pk-rekey-collapses-deletion-markers`, which must land for the
`INTERNAL`-after-mutation family to be fully closed.

## TODO

- Give `validateRekeyedPrimaryKey` a `rows?: EffectiveRowSource` parameter, make it `async`,
  and pass `rows` through from `alterColumn`'s `structuresRekeyed` arm (~`manager.ts:2575`).
- Split the collision probe into (a) an effective-row pass and (b) the layer walk.
  `assertNoPrimaryKeyCollision` already does (b) over one layer; add a sibling that consumes an
  `Iterable<Row> | EffectiveRowSource` for (a). Keep both building a `BTree` keyed by the new
  `PrimaryKeyFunctions`, as today.
- When `rows` is supplied, include the view layer in the `BUSY` walk; when it is not, keep
  starting at `view.getParent()`.
- Include the offending key in the `CONSTRAINT` message (the probe already has the row in hand).
- Replace the `NOTE:` at `manager.ts` ~2568 that says the `rows` argument is deliberately
  ignored — it is now wrong. Explain instead why the two passes judge two different row sets.
- Update `validateRekeyedPrimaryKey`'s doc comment: state plainly that a collision confined to
  rows the transaction deleted is refused-with-retry *by physical necessity* (base/committed
  rows must survive a rollback and the primary tree is a map), and cross-reference the store
  sibling and `feat-transactional-ddl-native-backends`.
- Check `base.ts` `rebuildPrimaryTreeStrict`'s doc comment, which cites
  `validateRekeyedPrimaryKey` as its precondition — the precondition statement needs to name the
  layer-walk pass specifically, since the effective-row pass no longer implies it.

### Regression coverage

- `packages/quereus-isolation/test/isolation-layer.spec.ts` — the isolated leg is where all four
  shapes are reachable:
  - deleted-only collision → `BUSY`, message matches `/commit\/rollback and retry/i`, and the
    underlying table's column collation is **unchanged** (white-box, via
    `iso.getUnderlyingState('main','t')!.underlyingTable`).
  - one-of-two-colliders deleted → same.
  - two staged live colliders → `CONSTRAINT`, message names the key, underlying unchanged.
  - committed colliders with no deletes → `CONSTRAINT` (this one passes today; pin it so the
    rewrite does not regress it).
- `packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic` — assert the plain
  memory leg's existing outcomes are untouched. Note that this file also runs under
  `yarn test:store`, where the underlying is the store module and none of this code executes;
  only add cross-leg assertions whose outcome you have actually confirmed on both.
- `yarn test` and `yarn workspace @quereus/isolation test` must both pass; run
  `yarn lint` (it type-checks the spec files too).
