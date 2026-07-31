---
description: A rename that a persistent table's saved definition could not absorb used to report success while leaving the saved copy out of date; it is now refused up front, so nothing changes at all.
files:
  - packages/quereus/src/vtab/module.ts                              # CatalogObjectKind gains 'table'
  - packages/quereus/src/schema/catalog-persistability.ts            # TableRewrite, cloneTableRewritableAsts, the split scan
  - packages/quereus/src/runtime/emit/alter-table.ts                 # both rename pre-flights pass a table rewriter
  - packages/quereus-store/src/common/store-module-catalog.ts        # tableCatalogEntry, prospectiveCatalogEntry, ownsTableCatalogEntry
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts          # dependent-table cases in the RENAME describe
  - docs/schema.md                                                   # § persistence: RENAME pre-flight
  - docs/store.md                                                    # § identifier / DDL-text guards
  - docs/module-authoring.md                                         # hook table row
  - packages/quereus-isolation/README.md                             # transparent hook forwarding
difficulty: medium
repro: verified
---

## What shipped

`alter table … rename to` / `rename column` rewrites more than the renamed object: it also
rewrites every OTHER table that mentioned it — a foreign key's target table or referenced-column
list, a `check` expression, a partial-index predicate. When such a dependent table is
store-backed, its saved (on-disk) definition has to be rewritten too.

That rewrite was fire-and-forget in two layers (`SchemaChangeNotifier` try/catch-per-listener,
then the store's async persist queue with a `.catch`-log), so a new name the store cannot encode
left the statement **reporting success** while the live and saved definitions of a persistent
table silently disagreed for the rest of the session. The only trace was a console line.

The unencodable-name case in practice is a **lone surrogate** — a broken half of a Unicode
character, e.g. `'\uD800'` in JavaScript. No UTF-8 byte sequence encodes one, so the store
refuses to write text containing it.

The fix mirrors the view / materialized-view pre-flight that already existed:

**Engine.** `CatalogObjectKind` (`vtab/module.ts`) gains a `'table'` case.
`assertRenameDependentsPersistable` (`schema/catalog-persistability.ts`) takes a fourth argument,
`rewriteTable: TableRewrite`, and runs two arms behind the single `anyModuleCanVeto(db)` early
return: the unchanged view / MV arm (one schema), and a table arm over **every** schema, because
the propagation's own table loop is not schema-scoped. Each table is probed via
`cloneTableRewritableAsts`, a shallow copy whose `checkConstraints[].expr` and
`indexes[].predicate` are spine clones; same-reference-means-unchanged is tested against the
clone. Both rename arms in `runtime/emit/alter-table.ts` pass the corresponding closure.

**Store.** `store-module-catalog.ts` gains `tableCatalogEntry` (key + DDL bundle), which
`saveTableDDL` also uses so veto and write cannot drift; `prospectiveCatalogEntry` switches on
`kind`; and `ownsTableCatalogEntry` is the synchronous ownership self-filter (in `this.tables`,
or `vtabModule === this`, or a wrapper exposing `underlying === this`). Not owned ⇒ no entry ⇒
no check.

## How to exercise it by hand

```sql
create table st (id integer primary key, v integer) using store;   -- makes the store live
create table m  (id integer primary key, x integer);               -- in-memory: no store guard
create table s2 (id integer primary key,
                 mid integer references m(id)) using store;
insert into m values (1, 100);
insert into s2 values (1, 1);            -- REQUIRED: an untouched store table has no entry yet
alter table m rename to "<lone surrogate>";
```

Before: succeeded; `s2`'s live FK read `"\ud800"` while its saved definition still read
`… references m(id) …`. After: raises `… unpaired surrogate (U+D800 …)`, and both the live
catalog and the saved definition are untouched.

## Review findings

Reviewed the implement diff (`0bb03a6f`) against the current sources, then ran the full
validation set. **No major findings — no new tickets filed.**

**Checked.** Both AST rewriters' in-place-mutation semantics against what
`cloneTableRewritableAsts` actually clones; the ownership key format against
`StoreModule.resolveOwnedTable` (`${schema}.${table}` lowercased — matches); the isolation
forward path; the veto-vs-write-path derivation sharing; source sizes of every touched file;
every doc that mentions the hook. Ran `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test`
(all workspaces green), `yarn test:store` (8140 passing, 21 pending, 0 failing). No pre-existing
failures surfaced, so `tickets/.pre-existing-error.md` was not written.

**Minor — fixed in this pass.**

- `docs/store.md` (§ identifier and DDL-text guards) still stated that dependent tables get no
  veto at all and cited this very ticket as an open gap. The implement pass updated `schema.md`
  and `module-authoring.md` but missed this third copy. Rewritten to describe the `'table'` kind
  and the ownership self-filter.
- `packages/quereus-isolation/README.md` (transparent hook forwarding) described the forwarded
  veto as covering only views and materialized views. Extended, including why the wrapper matters
  to the ownership test (a wrapped table's `vtabModule` is the `IsolationModule`).
- `docs/schema.md` did not record the one behavioural difference the handoff flagged — the veto is
  stricter than the write path for a store-owned table whose catalog entry has not been written
  yet. One sentence added; the same point now appears in `store.md`.
- Two of the new FK tests asserted only that the OLD name survived in the persisted DDL, not that
  no surrogate reached it. Both now also assert `not.include(LONE_HIGH)`, matching the CHECK case.

**Test coverage — one case added.** Every dependent in the implementer's cases was created in the
same session, so the ownership filter always resolved through its first arm (`this.tables`) with
a freshly-created table. Added `refuses a rename an ISOLATION-WRAPPED store dependent could not
persist, after a reopen`: phase 1 persists a store table whose CHECK names a memory table, phase 2
rebuilds the memory table, rehydrates the catalog into a fresh isolated store, and renames. It
pins the filter end-to-end through the wrapper and across a reopen — the deployment shape with the
most to lose, since the dependent's entry is already on disk.

Mutation-verified rather than assumed: forcing `ownsTableCatalogEntry` to return `false`
reproduces the original bug verbatim (rename succeeds, `[StoreModule] Failed to persist catalog
DDL after schema change: … unpaired surrogate …` on the log). Worth recording that rehydration
*does* put the table back in `this.tables`, so the `underlying === this` arm is defensive rather
than load-bearing today — a mutation dropping only that arm still passes. The arm is kept for
parity with `resolveOwnedTable`; the test comment says so plainly rather than overclaiming.

**Tripwire recorded (not a ticket).** A unique partial index and its derived UNIQUE constraint
share one predicate node by reference, which is how the live propagation rewrites both at once.
`cloneTableRewritableAsts` clones the index's copy, so the probe's constraint keeps the pre-rename
predicate. Unreachable today — a predicate can only name another table through a subquery, and no
module accepts one — and it can only ever cause a missed veto, never a live-AST mutation. Parked
as a `NOTE:` on `cloneTableRewritableAsts` in `schema/catalog-persistability.ts`. The implementer's
own cost tripwire (spine-cloning every table's ASTs on every rename) is already a `NOTE:` above
`assertRenameDependentsPersistable`; left as is.

**Examined, deliberately unchanged.**

- `prospectiveCatalogEntry`'s `switch` returns `undefined` for a kind it does not know, so a
  future fourth `CatalogObjectKind` would silently skip the store's check rather than fail to
  compile. That is exactly the hook's documented contract ("a module that would not persist the
  object must no-op"), so tightening it would be noise.
- `runtime/emit/alter-table.ts` is 2229 lines. Real size debt, but pre-existing and already
  claimed by `tickets/backlog/debt-emit-source-files-too-large.md`; this change added ~10 lines.
- The table arm's "walks every schema" claim (mirroring `propagateTableRename`) has no direct
  test: the store spec has no primitive for a store table in an attached schema. The code cites
  and mirrors the loop it is following; left uncovered rather than pinned with a fake.
- The renamed table staying in the scan un-special-cased, and the internally-inconsistent
  prospective record it produces for the column arm (old column names, new-name CHECK): reviewed
  and agreed. The DDL text is only surrogate-scanned, never round-tripped, and the veto there is
  always true.
- The partial-index-predicate arm still has no test, for the reason the implementer documented
  (the store's predicate compiler rejects the only shape that could reach it). Verified that
  reasoning still holds; the comment in the spec stays.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean. `yarn typecheck` — clean.
- `yarn test` — all workspaces passing, 0 failing.
- `yarn test:store` — 8140 passing, 21 pending, 0 failing.
- `packages/quereus-store/test/lone-surrogate-keys.spec.ts` — 51 passing.
