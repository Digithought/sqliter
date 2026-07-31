---
description: The persistent store writes each secondary index's text values using one table-wide text-sorting rule instead of the rule declared on the indexed column, so the stored bytes disagree with how the database actually compares those values. Change the stored bytes to follow the column's own rule, and keep every path that writes, rebuilds, seeks, or merges those bytes in step.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # NEW resolveIndexKeyCollations, beside resolvePkKeyCollations
  - packages/quereus-store/src/common/key-builder.ts                # buildIndexKey / buildIndexPrefixBounds gain per-column index collations
  - packages/quereus-store/src/common/store-table-base.ts           # validateKeyCollations — validate index key collations, not blanket K
  - packages/quereus-store/src/common/store-table-scan.ts           # analyzeIndexAccess, buildIndexRangeBounds, scanMultiSeek, indexColumnCollations, NEW getIndexComparator
  - packages/quereus-store/src/common/store-table-constraints.ts    # updateSecondaryIndexes, findUniqueConflictViaIndex, findIndexForUniqueConstraint, indexSeekHonorsEnforcementCollation
  - packages/quereus-store/src/common/store-module-index-build.ts   # buildIndexEntries (CREATE INDEX / rebuild path)
  - packages/quereus-store/src/common/store-module-alter-column.ts  # SET COLLATE on an indexed non-PK column must now rebuild indexes
  - packages/quereus-store/src/common/implicit-unique-index.ts      # stale doc comment about K-identical index keys
  - packages/quereus-isolation/src/isolated-table.ts                # buildDescriptorComparators — merge order for store index scans
  - packages/quereus-store/test/index-column-collation.spec.ts      # NEW
  - docs/store.md                                                   # § Per-column PK key collation, index-derived UNIQUE section
difficulty: hard
---

# Encode secondary-index columns under the column's collation, not the table key collation

## Background, in plain terms

A **collation** is a rule for comparing text — `BINARY` (byte-exact), `NOCASE`
(case-insensitive), `RTRIM` (ignore trailing spaces), or an application-registered one.

The persistent store turns every key into raw bytes and orders rows by comparing those
bytes. For text it does that by running the value through the collation's **normalizer**
(e.g. `NOCASE` lowercases) and storing the result. So *which* collation the store picks
when it builds a key decides what the stored bytes are.

A store table has one **table key collation**, written `K` — the `collation = …` module
option, default `NOCASE`. Today every secondary index encodes its indexed-column bytes
under `K`, whatever collation the column itself declares.

But everything that *reads* those rows compares under the **index column's own effective
collation**, written `C`:

```
C = the index column's own COLLATE (create index ix on t (col collate x))
    else the table column's declared collation
    else BINARY
```

`C` is what `StoreTable.matchesFilters` re-checks a scanned row under
(`resolveFilterCollations` + `indexColumnCollations`), what the planner uses to decide a
pushed predicate is covered, what `uniqueEnforcementCollations` enforces UNIQUE under, and
what `buildIndexEntries`' in-pass duplicate check already buckets under
(`indexDedupeNormalizers`).

So the bytes say `K` and every comparison says `C`. Three guards exist only to paper over
that gap. This ticket removes the gap at its source: **encode index-column bytes under `C`.**

Collapsing the three guards is deliberately NOT in this ticket — see
`store-index-collation-guard-collapse`, which depends on this one. Every existing guard
stays sound after this change (it can only decline more than necessary; see *Why the old
guards stay safe*, below), so this ticket can land on its own.

## The change

Add, in `pk-key-resolution.ts`, the index-column twin of `resolvePkKeyCollations`:

```ts
/**
 * Per-column KEY collation for a secondary index's OWN columns (the index half of
 * buildIndexKey), positionally aligned with `index.columns`.
 */
export function resolveIndexKeyCollations(
	index: TableIndexSchema,
	columns: ReadonlyArray<ColumnSchema>,
): (string | undefined)[]
```

Per column, delegate the branch to the engine's `pkKeyCollationName` exactly as
`resolvePkKeyCollations` does, but hand it the index column's COLLATE override:

```ts
index.columns.map(col => {
	const tableCol = columns[col.index];
	const name = pkKeyCollationName({
		logicalType: tableCol.logicalType,
		collation: col.collation ?? tableCol.collation,
	});
	return name === undefined ? undefined : (name || 'BINARY').toUpperCase();
})
```

Three cases fall out, and they are the same three the PK path already has:

| index column kind | key collation |
|---|---|
| never-text (`integer`, `real`, `blob`) | `undefined` — encoded type-natively, collation is moot |
| text-capable but not `isTextual` (`any`, `json`, `date`/`time`/`datetime`/`timespan`) | hard-coded `BINARY` — those types' `compare` ignores collation |
| `isTextual` (`text`) | `col.collation ?? tableCol.collation ?? 'BINARY'` |

**The fallback is `BINARY`, not `K`.** That is the crux of the change and it differs from
`resolvePkKeyCollations`, whose fallback *is* `K`. The asymmetry is correct and deliberate:
`reconcilePkCollations` (store-module-schema-rewrite.ts) rewrites an undecorated **text
primary-key** column's declared collation to `K` at CREATE time, so for a PK member `K` *is*
the declared collation. There is no such rewrite for non-PK columns — an undecorated `text`
column is genuinely `BINARY`, both in the engine's comparisons and in the store's residual
— so `BINARY` is what its index bytes must use.

### Threading it through

`buildIndexKey` and `buildIndexPrefixBounds` in `key-builder.ts` currently pass `undefined`
for the index half's per-column collations. Give both an explicit parameter and thread the
resolved array from every call site:

```ts
buildIndexKey(indexValues, pkValues, options,
	indexDirections, pkDirections,
	indexCollations, pkCollations,          // <- indexCollations is new
	indexTransforms, pkTransforms)

buildIndexPrefixBounds(prefixValues, options, directions, collations, transforms)
```

Note this makes the two halves of `buildIndexKey` symmetric — each half now takes its own
directions, collations, and transforms. Consider reshaping the signature into two
`{ values, directions, collations, transforms }` halves rather than eight positional
arguments; eight positional `ReadonlyArray | undefined` parameters is where a silent
argument-order slip becomes very cheap to make and very expensive to find. Either shape is
acceptable — pick one and keep both halves' argument order visually identical.

The five sites that encode or seek index-column bytes, all of which must agree byte for byte:

- `StoreTableConstraints.updateSecondaryIndexes` — DML maintenance (delete + insert).
- `StoreTableConstraints.findUniqueConflictViaIndex` — the UNIQUE enforcement point seek.
- `buildIndexEntries` (store-module-index-build.ts) — `CREATE INDEX` and every rebuild.
- `StoreTableScan.analyzeIndexAccess` (EQ prefix window) and `buildIndexRangeBounds`
  (range window).
- `StoreTableScan.scanMultiSeek` — one window per IN-list tuple.

A helper on `StoreTableScan` beside the existing `indexColumnCollations` — say
`indexKeyCollations(index)` returning the memoizable resolved array — keeps the three scan
sites from re-deriving it. `buildIndexEntries` and `updateSecondaryIndexes` must call
`resolveIndexKeyCollations` directly (they already do the same for transforms and PK
collations); they are the pair whose drift silently corrupts an index, so keep them
adjacent in review.

### `validateKeyCollations` (store-table-base.ts)

Today it adds `K` to the must-have-a-normalizer set whenever *any* index column is
text-capable. Replace that with the actual index key collations: every defined entry of
`resolveIndexKeyCollations` over every index in the **materialized** schema (so hidden
`_uc_*` indexes are covered, as they are today).

Two consequences, both correct and both worth a test:

- An index column declaring a comparator-only collation (registered with a comparator but
  no `{ normalizer }`) is now rejected at DDL time instead of silently keying under `K`.
- A table whose `K` has no normalizer but whose index columns are all `BINARY`/type-native
  and whose PK needs no `K` is no longer made unopenable by a `K` it never encodes with.

### UNIQUE enforcement must seek the right index

`StoreTableConstraints.findIndexForUniqueConstraint` picks the index that realizes a UNIQUE
constraint by column-set match, and `withImplicitUniqueIndexes` **appends** the hidden
`_uc_*` after the explicit indexes — so when both exist, `find` returns the *explicit* one.
Today that is harmless (every index keys under the same `K`, so the two are byte-identical).
After this change it is a silent wrong answer. The reachable failure:

```sql
create table t (id integer primary key, email text collate nocase, unique (email)) using store;
create index ix on t (email collate binary);
insert into t values (1, 'A@x');
insert into t values (2, 'a@x');   -- must raise UNIQUE constraint failed
```

`findReusableIndexForUnique` refuses `ix` (its `BINARY` ≠ the declared `NOCASE`), so
`_uc_email` is materialized under `NOCASE` — but `findIndexForUniqueConstraint` still picks
`ix`, whose bytes are now `BINARY`. The seek window holds only the byte-exact `'a@x'`
entries, misses `'A@x'`, and the duplicate lands. (The stale NOTE at that site already
predicts this and names this ticket.)

Fix both halves:

- **Prefer the constraint's own index by name.** For an index-derived UC, resolve by
  `uc.derivedFromIndex` (unchanged). For a non-derived UC, look up
  `implicitUniqueIndexName(schema, uc)` **first**, and only fall back to the column-set
  match when no such index exists — that fallback then lands on a
  `findReusableIndexForUnique`-approved index, whose collations
  `indexCollationsMatchDeclared` has already proven equal to the declared ones.
- **Restate `indexSeekHonorsEnforcementCollation` as an exact per-column equality**
  between the index's KEY collations (`resolveIndexKeyCollations`) and the constraint's
  enforcement collations (`uniqueEnforcementCollations`), normalized upper-case, with
  never-text columns exempt. The old coarser-`K` reasoning — the `K === 'NOCASE' && C ===
  'BINARY'` special case that reasons about built-in names — goes away entirely: the key
  and the comparison are now the same collation by construction, so the only thing left to
  check is that they really are.

  Keep the guard rather than deleting it. It is no longer load-bearing in any *designed*
  path, but `withImplicitUniqueIndexes` skips materializing a `_uc_*` when its name is
  already taken (a user index literally named `_uc_email`, or a named UC colliding with an
  index name), and that path can still hand the seek an index whose key collations differ.
  A false answer there silently accepts a duplicate; a decline only costs the full scan.

### Isolation merge order

`quereus-isolation`'s `IsolatedTable` merges the overlay's pending rows against the
underlying table's index scan by `(indexKey, PK)` sort key. Its comparator comes from
`underlyingTable.getIndexComparator?.(name)` when the underlying offers one, else
`buildDescriptorComparators`, which resolves `kc.collation ? … : BINARY` — **no fall back to
the table column's collation**. `StoreTable` implements no `getIndexComparator`, so store
index scans merge under that descriptor fallback today.

Store emission order vs. isolation's expectation, before and after:

| index column | table column | today (bytes = `K` = NOCASE) | after (bytes = `C`) | isolation expects |
|---|---|---|---|---|
| no COLLATE | `text` (BINARY) | NOCASE ✗ | BINARY ✓ | BINARY |
| no COLLATE | `text collate nocase` | NOCASE ✗ | NOCASE ✗ | BINARY |
| `collate nocase` | `text` | NOCASE ✗ | NOCASE ✓ | NOCASE |

Row 1 — the common shape — is *fixed* by this change. Row 2 is broken today and stays
broken. Row 3 is fixed. But with `K = BINARY` (an explicit `collation = binary` module
option) row 2 flips from agreeing to disagreeing, which is a regression this change
introduces.

Close it at the source: **implement `getIndexComparator(indexName)` on `StoreTableScan`**,
returning per-column comparators that state the store's actual key order — the same
resolution `resolveIndexKeyCollations` uses (index COLLATE ?? table column collation ??
BINARY; `createTypedComparator` for a semantic-ordering type; negate for `desc`). Model it
on `MemoryTable.getIndexComparator` (packages/quereus/src/vtab/memory/table.ts). Resolve
against `this.collationResolver` and look the index up in the **materialized** schema so a
`_uc_*` name resolves too. The isolation layer already prefers it over the descriptor
fallback, so no change is needed on that side beyond a doc-comment correction noting that a
store-backed index scan now supplies its own comparators.

Do **not** widen `buildDescriptorComparators`' BINARY fallback to the table column's
collation in this ticket. It would change merge order for memory-backed tables too, whose
index BTrees genuinely order by `specCol.collation ?? BINARY`
(packages/quereus/src/vtab/memory/index.ts) — a separate question about whether memory
should honor a declared column collation on an undecorated index column. If you conclude it
is wrong, file it as a backlog `bug-` ticket rather than folding it in here.

### `ALTER COLUMN … SET COLLATE` on an indexed non-PK column

`store-module-alter-column.ts` currently rebuilds secondary indexes only when values were
rewritten or a key transform changed, on the stated grounds that "the store's index KEY
bytes use the table-level key collation K … so no index entry re-encode is required for a
non-PK column". That sentence stops being true here. After this change, a `SET COLLATE` on
a column covered by any index changes that index's key bytes, and the persisted entries are
stale — an index-backed lookup after the ALTER finds nothing.

Extend the rebuild condition (the `(rewritesValues || keyTransformChanged) && !pkRekeyNeeded`
block) to also fire when `collationChanged` and some index in the **materialized** schema
covers `colIndex`. The surrounding invariants are already satisfied:

- The pre-mutation `validateUniqueOverExistingRows` walk above already runs on
  `collationChanged`, so the non-enforcing (`skipDuplicateCheck`) rebuild keeps its
  contract.
- `updatedIndexes` (a few lines above) already propagates the new collation into every
  index column referencing the altered column, so the rebuild encodes under the new `C`.
- The `pkRekeyNeeded` arm already rebuilds every index, so the `&& !pkRekeyNeeded` exclusion
  stays.

Fix the stale comment at that site and its twin in `docs/store.md`.

### Why the old read-side guards stay safe until the follow-up lands

After this change the EQ window is encoded under `C` and re-checked under `C`, so it is
*exactly* the qualifying set — no longer merely a superset. Every existing guard therefore
remains sound; it just declines cases it no longer needs to:

- `tryIndexAccessPlan`'s `eqSafeToHandle` (`C === K`, or `K = NOCASE` over `C = BINARY`)
  returns `true` only in cases that are now trivially exact, and `false` conservatively
  elsewhere.
- `rangeSafeToHandle` / `StoreTableScan.indexRangeIsOrderSafe` (`keyOrderMatchesCollation`
  with the key side passed as `K`) likewise only over-declines.

So the guard collapse is a pure optimization and belongs in the follow-up ticket. Do not
attempt it here.

## On-disk impact

This changes on-disk secondary-index key bytes. Backwards compatibility is waived
project-wide (AGENTS.md) and the store carries no format-version marker, so there is no
migration hook: **any previously-persisted database whose secondary indexes cover a text
column whose effective collation differs from `K` must be recreated or re-indexed.** Record
that in `docs/store.md` alongside the existing "non-textual PK bytes … must be recreated"
note. Data-store (primary-key) bytes are unchanged, and so is the PK suffix embedded in each
index key — only the leading index-column bytes move.

## Edge cases & interactions

- **Default shape.** `create table t (id integer primary key, name text) using store` (so
  `K = NOCASE`) + `create index ix on t (name)`. Index bytes become `BINARY`. Rows differing
  only by case must both be retrievable through the index, and a seek must find the exact
  case.
- **`K = binary` module option** with a `text collate nocase` column: index bytes become
  `NOCASE` (they were `BINARY`). This is the isolation row-2/row-3 case above — assert the
  overlay merge through `getIndexComparator`, with a pending overlay insert whose indexed
  value case-collides with a committed row.
- **Explicit index COLLATE overriding the column.** `create index ix on t (email collate
  binary)` over `email text collate nocase` — index bytes `BINARY`, residual compares
  `BINARY`, UNIQUE (if derived) enforces `BINARY`.
- **The `_uc_*`-vs-explicit-index under-fetch** reproduced above — this is the one case
  where getting the change half-right silently accepts a duplicate. Test it directly.
- **`any` / `json` / temporal index columns** now key `BINARY` instead of `K`. Under
  `K = NOCASE`, `create table t (id integer primary key, v any) using store` with a UNIQUE
  index on `v` must accept both `'A'` and `'a'` (it does not today — same class of defect
  `bug-store-any-json-pk-keyed-under-table-collation` fixed on the PK side). Semantic-ordering
  index columns keep their `resolveIndexKeyTransforms` transform; collation and transform
  are independent and both must be threaded.
- **Never-text index columns** (`integer`, `blob`) get `undefined` and must produce
  byte-identical keys before and after — a cheap regression pin.
- **DESC index columns.** Collation normalization happens before the DESC bit inversion, per
  column. A `create index ix on t (name collate nocase desc)` must still iterate in
  descending `NOCASE` order and its UNIQUE seek must land on the inverted window.
- **Partial indexes.** The predicate-scoped write path (`updateSecondaryIndexes`' in/out-of
  scope halves) and `buildIndexEntries`' build-time filter must both carry the new
  collations; a row transitioning across the predicate scope on UPDATE deletes under the
  same bytes it was written under.
- **Build path vs. maintenance path agreement.** `create index` on a NON-EMPTY table
  (`buildIndexEntries`), then a DML update to an indexed row (`updateSecondaryIndexes`), then
  a seek. If the two disagree the delete leaks a stale entry — assert the row count through
  the index after the update, not just the presence of the new value.
- **Reopen / rehydrate.** `generateIndexDDL` emits `col.collation` verbatim with no BINARY
  elision, so `indexCol.collation ?? tableCol.collation` round-trips through the catalog.
  Pin it: create with an explicit index COLLATE, close, reopen, and assert an index-backed
  lookup still finds the row (a round-trip that dropped the COLLATE would re-key under the
  table column's collation and find nothing). `test/retype-collation-reopen.spec.ts` is the
  nearest precedent.
- **Multi-seek window merging.** `scanMultiSeek` folds tuples whose encoded prefixes
  byte-match into one window with the others kept as residual alternatives. The merge set
  changes (previously `K`-equal, now `C`-equal). Under `K = NOCASE` with a `BINARY` column,
  `where name in ('a','A')` previously merged into one window and now yields two — both must
  return both rows, in index-key order.
- **`ALTER COLUMN … SET COLLATE`** on an indexed non-PK column: index-backed lookup must
  succeed after the ALTER. Also on a column covered by a `derivedFromIndex` UNIQUE — the
  constraint must enforce under the new collation *and* the entries must be re-encoded.
- **`ALTER COLUMN … SET COLLATE` on a PK member** already rebuilds every index; confirm no
  double rebuild and that the rebuild now also re-encodes the index-column half.
- **DDL-time rejection** of a comparator-only collation named on an index column, and the
  narrowing of `validateKeyCollations`' `K` requirement.
- **Concurrent/forked access.** `quereus-isolation` overlay merge (above) and the store's
  own read-your-own-writes `iterateEffective` — a pending index put and a committed entry
  for the same logical value must sort into the same position under the new bytes.
- **Partial-failure path.** `buildIndexEntries` flushes in batches; a mid-stream failure
  leaves a partially re-encoded index. Behavior is unchanged (re-run the rebuild), but do
  not make it worse — the rebuild must stay idempotent (clear + rebuild).

## Adjacent work, out of scope

- `tickets/implement/bug-store-index-choice-ignores-cost` edits `computeBestAccessPlan`'s
  index-selection loop in `store-module-access-plan.ts`. Different function from the
  collation guards, but the same file — rebase rather than resolve blind if it lands first.
- Memory's index BTree ordering ignores the table column's collation for an undecorated
  index column (`specCol.collation ?? BINARY`). If you conclude that is wrong, file a
  backlog `bug-` ticket; do not change it here.

## Tests

New `packages/quereus-store/test/index-column-collation.spec.ts`. Nearest precedents for
harness shape: `custom-collation-key.spec.ts`, `any-json-pk-binary-key.spec.ts`,
`index-persistence.spec.ts`, `unique-constraints.spec.ts`.

Expected outputs to pin, each against a memory-table oracle where the semantics should
match:

- `K = NOCASE`, `name text`, index on `name`, rows `('Ann')` and `('ann')`:
  `select id from t where name = 'ann'` returns exactly one row through the index plan.
- The `_uc_*`-vs-explicit-index case: the second insert raises
  `UNIQUE constraint failed`.
- `K = NOCASE`, `v any`, unique index on `v`: both `'A'` and `'a'` insert successfully.
- Explicit `collate binary` index column over a `nocase` table column: `= 'A@X'` finds only
  the byte-exact row.
- `SET COLLATE` on an indexed non-PK column, then an index-backed lookup for a value that
  only matches under the new collation.
- Reopen with an explicit index COLLATE: lookup still finds the row.
- Isolation: inside an open transaction, insert an overlay row whose indexed value sorts
  between two committed rows under `C` (but not under `K`) and assert the index scan emits
  all three in `C` order.

**Mutation-check the change**: force `resolveIndexKeyCollations` to return all-`undefined`
(i.e. revert to `K`) and confirm a meaningful number of the new tests fail. A test suite
that passes under both encodings is not testing the change.

## TODO

### Phase 1 — encode under C

- Add `resolveIndexKeyCollations` to `pk-key-resolution.ts`, with a doc comment that states
  the `BINARY`-not-`K` fallback and *why* (the `reconcilePkCollations` asymmetry).
- Give `buildIndexKey` and `buildIndexPrefixBounds` an index-half collations parameter;
  decide the signature shape (positional vs. two half-objects) and apply it consistently.
- Thread the resolved collations through `updateSecondaryIndexes`, `buildIndexEntries`,
  `findUniqueConflictViaIndex`, `analyzeIndexAccess`, `buildIndexRangeBounds`,
  `scanMultiSeek`. Add the `indexKeyCollations(index)` helper on `StoreTableScan`.
- Update `validateKeyCollations` to validate the resolved index key collations instead of
  blanket `K`.
- Update the doc comments at every touched site that assert "index keys are encoded under
  K" (key-builder.ts, store-table-base.ts, store-table-scan.ts, store-table-constraints.ts,
  store-module-index-build.ts, implicit-unique-index.ts).

### Phase 2 — keep the write side sound

- `findIndexForUniqueConstraint`: prefer the constraint's own `_uc_*` by name for a
  non-derived UC; fall back to the column-set match only when absent. Remove the now-stale
  NOTE.
- `indexSeekHonorsEnforcementCollation`: restate as exact per-column equality between the
  index key collations and `uniqueEnforcementCollations`, never-text exempt. Rewrite the
  doc comment — the coarser-`K` superset argument no longer applies.
- `store-module-alter-column.ts`: rebuild secondary indexes when `collationChanged` and an
  index covers the altered non-PK column. Fix the stale "metadata-only" comment.

### Phase 3 — merge order

- Implement `getIndexComparator(indexName)` on `StoreTableScan`, mirroring the store's key
  order exactly (per-column collation, semantic-ordering `compare`, DESC negation),
  resolving the index against the materialized schema.
- Correct the `buildDescriptorComparators` doc comment in `quereus-isolation` to note that
  a store-backed index scan now supplies its own comparators.

### Phase 4 — validate

- Write `test/index-column-collation.spec.ts` covering the *Edge cases & interactions* list.
- Mutation-check as described above.
- `yarn build`, `yarn lint`, `yarn test` — all green.
- `yarn test:store` — this change is squarely in the store path; run it and report the
  result. Stream with `tee` (see AGENTS.md); if wall-clock approaches the runner's idle
  window, note the deferral explicitly in the handoff rather than skipping silently.
- Update `docs/store.md`: the "plus the collation used for secondary-index *column* values"
  clause in § *Per-column PK key collation* is now wrong; the index-derived UNIQUE section's
  "metadata-only … index *key* bytes use the table-level collation K" parenthetical is now
  wrong; add the re-index-on-upgrade note.
