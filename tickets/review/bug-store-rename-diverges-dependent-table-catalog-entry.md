---
description: A rename that a persistent table's saved definition could not absorb used to report success while leaving the saved copy out of date; it is now refused up front, so nothing changes at all.
files:
  - packages/quereus/src/vtab/module.ts                              # CatalogObjectKind gains 'table'; hook docstring rewritten
  - packages/quereus/src/schema/catalog-persistability.ts            # TableRewrite, cloneTableRewritableAsts, the split scan
  - packages/quereus/src/runtime/emit/alter-table.ts                 # both rename pre-flights now pass a table rewriter (~lines 212, 354)
  - packages/quereus-store/src/common/store-module-catalog.ts        # tableCatalogEntry, prospectiveCatalogEntry, ownsTableCatalogEntry
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts          # 5 new cases + 1 extended, in the RENAME describe (~line 571)
  - docs/schema.md                                                   # § persistence: RENAME pre-flight bullets, self-filter, ordering note, "Two things stay uncovered"
  - docs/module-authoring.md                                         # hook table row (~line 471)
difficulty: medium
repro: verified
---

## What shipped

`alter table … rename to` / `rename column` rewrites more than the renamed object: it
also rewrites every OTHER table that mentioned it — a foreign key's target table or
referenced-column list, a `check` expression, a partial-index predicate. When such a
dependent table is store-backed, its saved (on-disk) definition has to be rewritten too.

That rewrite was fire-and-forget in two layers (`SchemaChangeNotifier` try/catch-per-
listener, then the store's async persist queue with a `.catch`-log), so a new name the
store cannot encode left the statement **reporting success** while the live and saved
definitions of a persistent table silently disagreed for the rest of the session. The
only trace was a console line.

The unencodable-name case in practice is a **lone surrogate** — a broken half of a
Unicode character, e.g. `'\uD800'` in JavaScript. No UTF-8 byte sequence encodes one, so
the store refuses to write text containing it.

The fix mirrors the view/materialized-view pre-flight that already existed:

**Engine.** `CatalogObjectKind` (`vtab/module.ts`) gains a `'table'` case.
`assertRenameDependentsPersistable` (`schema/catalog-persistability.ts`) takes a fourth
argument, `rewriteTable: TableRewrite`, and now runs two arms behind the single
`anyModuleCanVeto(db)` early return:

- `assertRenameDependentViewsPersistable` — unchanged behaviour, one schema.
- `assertRenameDependentTablesPersistable` — **every** schema (`_getAllSchemas()`),
  because the propagation's own table loop is not schema-scoped, so a cross-schema FK is
  rewritten. Each table is probed via `cloneTableRewritableAsts`, a shallow copy whose
  `checkConstraints[].expr` and `indexes[].predicate` are spine clones — those two arms of
  both rewriters mutate in place, unlike the FK arm which is already copy-on-write.
  Same-reference-means-unchanged is tested against the CLONE, not the original.

Both rename arms in `runtime/emit/alter-table.ts` pass the corresponding closure
(`rewriteTableForTableRename` / `rewriteTableForColumnRename`); the column arm reuses the
existing `resolveColumnInSource`.

**Store.** `store-module-catalog.ts` gains `tableCatalogEntry` (key + DDL bundle), which
`saveTableDDL` now also uses so veto and write cannot drift; `prospectiveCatalogEntry`
switches on `kind`; and `ownsTableCatalogEntry` is the synchronous ownership self-filter
(mirrors `StoreModule.resolveOwnedTable`: in `this.tables`, or `vtabModule === this`, or
a wrapper exposing `underlying === this` for the isolation layer). Not owned ⇒ no entry ⇒
no check. The existing `subscribedDb !== db` gate is unchanged.

## How to exercise it by hand

```sql
create table st (id integer primary key, v integer) using store;   -- makes the store live
create table m  (id integer primary key, x integer);               -- in-memory: no store guard
create table s2 (id integer primary key,
                 mid integer references m(id)) using store;
insert into m values (1, 100);
insert into s2 values (1, 1);            -- REQUIRED, see gotcha below
alter table m rename to "<lone surrogate>";
```

Before: succeeded; `s2`'s live FK read `"\ud800"` while its saved definition still read
`… references m(id) …`. After: raises `… unpaired surrogate (U+D800 …)`, and both the
live catalog and the saved definition are untouched.

**Gotcha that shapes every test here:** a store table created but never written to has
**no catalog entry yet**, so there is nothing to diverge and a test without the `insert`
asserts nothing. That lazy-persist gap is its own ticket
(`bug-store-untouched-table-and-early-view-never-persisted`) and was deliberately not
fixed here — the ownership self-filter is correct either way.

## Tests added (all in `packages/quereus-store/test/lone-surrogate-keys.spec.ts`)

Describe renamed to `a RENAME that would make a persisted view, materialized view or
table unwritable`. New cases:

- table rename refused via a store dependent's **foreign key** — asserts the persisted
  DDL still names `m` AND that the live FK was not rewritten (proves the probe worked on
  a clone);
- column rename refused via the same FK's **referenced-column list**;
- table rename refused via a store dependent's **check expression** — plus an `insert`
  after the refusal, proving the live CHECK still resolves against `m`;
- **negative**: a memory-backed dependent table, with the store module registered and
  live, still permits the rename and is rewritten as always (the false-positive guard);
- the existing astral (well-formed) case now also carries a store dependent and asserts
  its catalog entry **re-persisted** under the new name — not merely that the rename was
  allowed.

## Known gaps / things worth a reviewer's attention

- **The partial-index-predicate arm has no test.** It has no reachable shape today: a
  predicate can only name another table through a subquery, and the store's index-build
  predicate compiler refuses one (`Unsupported expression in partial-index predicate:
  subquery`, from `store-module-index-build.ts` — observed, not inferred; the test was
  written, run, and removed). A comment in the spec at that spot says so. The scan covers
  the arm regardless, since both rewriters walk predicates.
- **The renamed table itself stays in the scan**, deliberately un-special-cased. Probed
  under its OLD name with only new-name-carrying text rewritten in, so a veto there is
  always true; its own entry stays covered by the module's `renameTable` / `alterTable`
  guards. Note the probe's prospective record is internally inconsistent for the column
  arm (columns still carry the old name while its CHECK carries the new one) — harmless
  because the DDL text is only surrogate-scanned, never round-tripped, but a reviewer
  should confirm they agree that no future check on this path would care.
- **The self-filter is stricter than the write path** for a store-owned table whose
  catalog entry has not been written yet: the write path skips it, the veto refuses.
  Argued as the safe side in a comment (that table's eventual lazy `saveTableDDL` would
  throw on the diverged text anyway) — but it is a real behavioural difference and the
  one place a false positive could hide. No test pins it, because constructing it means
  relying on the lazy-persist gap above.
- **Cost.** The table arm spine-clones the CHECK/predicate ASTs of every table in every
  schema on every `ALTER … RENAME`. Parked as a `NOTE:` tripwire merged into the existing
  one above `assertRenameDependentsPersistable` (gate the clone on a cheap dry-run name
  scan if a schema-heavy workload shows up hot). Not measured — DDL is rare and the whole
  scan is skipped when no module can veto; full-suite wall clock was unchanged.
- **Not done, by prior decision in the source ticket:** no `create table` veto under the
  new `'table'` kind. `create … using store` already fails through `module.create`, and a
  store table's definition text is deliberately checked lazily on first storage access —
  pinned by existing passing tests in this same spec.

## Validation run

- `yarn build` — clean.
- `yarn test` — 8148 + 1214 + all other workspaces passing, 0 failing.
- `yarn test:store` — 8140 passing, 0 failing.
- `yarn lint` — clean. `yarn typecheck` — clean.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
