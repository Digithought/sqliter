---
description: In-memory tables used to let two different spellings of the same duration (like "PT1H" and "PT60M") both sit in a UNIQUE column; the second one is now rejected as a duplicate, matching every other part of the engine.
files:
  - packages/quereus/src/schema/unique-enforcement.ts        # new uniqueEnforcementComparators helper
  - packages/quereus/src/index.ts                            # export it
  - packages/quereus/src/vtab/memory/layer/manager.ts        # 3 re-validators routed through it + NOTE tripwire
  - packages/quereus-store/src/common/store-table.ts         # uniqueColumnComparators folded onto the helper
  - packages/quereus-isolation/src/isolated-table.ts         # findMergedUniqueConflict inline block folded onto the helper
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic          # new UNIQUE block (runs on memory AND store)
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts   # memory oracle re-added to 2 tests
  - docs/types.md                                            # § Semantic ordering
difficulty: medium
---

# Review: memory UNIQUE enforcement compares through the column's declared type

## What was wrong

Some declared column types define their own "same value" that differs from comparing
the stored text byte-for-byte — `docs/types.md` § "Semantic ordering" calls this
**semantic ordering**. `TIMESPAN` is the motivating case: `'PT1H'` and `'PT60M'` are two
spellings of one hour, and the type's `compare` returns 0 for them. `=`, `DISTINCT`,
`GROUP BY`, the memory PRIMARY KEY and the persistent store's UNIQUE constraints all
already treat them as one value. The in-memory backend's UNIQUE enforcement did not.

The candidate *lookup* was already type-aware (`MemoryIndex` builds its BTree comparator
with `createTypedComparator`, so a `'PT60M'` probe returned the `'PT1H'` row's primary
key). The re-validation immediately after it was not: it compared the probe against the
live row with `compareSqlValuesFast(..., enforcementCollation)` — storage class +
collation, no type involvement — decided `'PT1H' ≠ 'PT60M'`, skipped the candidate, and
admitted the duplicate.

## What changed

**New shared helper** `uniqueEnforcementComparators(columns, ucColumns, collations)` in
`packages/quereus/src/schema/unique-enforcement.ts`, exported from the package index.
Returns one comparison function per constrained column: the declared type's `compare`
when `hasSemanticOrdering(logicalType)`, else `compareSqlValuesFast` under the supplied
collation. It takes **pre-resolved collations** on purpose — memory's
`checkUniqueViaIndex` resolves its collations from the live `MemoryIndex` handle rather
than from `uniqueEnforcementCollations(schema, uc)`, a divergence that is intentional and
conformance-locked by `test/unique-enforcement-collation.spec.ts`. This signature lets all
four call sites share the comparator construction while each keeps its own collation
resolution.

**Three copies collapsed to one.** The helper replaces
`StoreTable.uniqueColumnComparators`'s body (the method survives as a thin wrapper — three
call sites read better with it) and the inline block in
`IsolatedTable.findMergedUniqueConflict`. The explanatory comments at both sites were
kept.

**Three memory re-validators routed through it**, each keeping its own collation
resolution, resolved once above the candidate loop (`manager.ts`):
`checkUniqueViaIndex`, `checkUniqueViaMaterializedView`, `checkUniqueByScanning`.
`enforceSecondaryUniqueOnMaintenance` reuses `checkSingleUniqueConstraint` and is fixed
transitively. `checkUniqueViaIndex`'s `if (existingPKs.length === 0) return null` early
bail still runs ahead of the resolution.

## Behaviour now (was: all accepted)

| case | now |
|---|---|
| `d timespan unique`, insert `'PT1H'` then `'PT60M'` | UNIQUE violation |
| `insert or ignore` of the second spelling | dropped; one row survives |
| `insert or replace` of the second spelling | evicts the existing row |
| composite `unique (k, d)`, `(1,'PT1H')` then `(1,'PT60M')` | UNIQUE violation; `(2,'PT60M')` still inserts |
| `create unique index` on `d`, write-time duplicate spelling | UNIQUE violation |
| `update` moving a row onto another row's spelling | UNIQUE violation |
| `update` re-spelling a row's OWN value | succeeds (self-exclusion intact) |
| `d text unique` holding the same two strings | both still accepted (negative control) |

Memory and store now agree case-for-case.

## How to exercise / validate

- `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` — new section
  "TIMESPAN UNIQUE enforcement: identity, not spelling" covers every row of the table
  above. It runs under **both** `yarn test` (memory) and `yarn test:store` (LevelDB), so
  the two backends are compared against the same expectations.
- `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` §
  "secondary UNIQUE identity" — the memory table is back as the oracle in
  `"rejects 'PT60M' after 'PT1H' in a UNIQUE column, honoring \`on conflict\`"` and
  `"maintains a UNIQUE index across an UPDATE that re-spells the indexed value"`; both
  now loop over `['t','m']`. The comment deferring to this ticket slug is gone.
- Regression guards that must stay byte-for-byte unaffected (they do —
  `hasSemanticOrdering` is the gate, so TEXT/ANY columns never consult a type `compare`):
  `packages/quereus/test/unique-enforcement-collation.spec.ts` (11 passing) and
  `test/logic/102.2-unique-collation.sqllogic`.

Manual repro, if you want to see it directly:

```sql
create table m (id integer primary key, d timespan unique);
insert into m values (1, 'PT1H');
insert into m values (2, 'PT60M');   -- UNIQUE constraint failed (was: accepted)
```

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean. `yarn typecheck` — clean.
- `yarn test` — all workspaces pass (no failures in the log).
- `yarn test:store` — 7183 passing, 19 pending (pre-existing pendings).
- `yarn workspace @quereus/store run test` — 1017 passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps / what a reviewer should push on

- **The MV-covering hole is still open and is NOT fixed here.** A UNIQUE constraint
  answered by a row-time covering materialized view can still admit a duplicate spelling,
  because the *candidate generator* (`_lookupCoveringConflicts`) narrows under the source
  column's declared collation before any re-validator sees a candidate. This ticket only
  fixed the re-validation. Tracked as `covering-mv-conflict-candidates-semantic`, which
  names this ticket as its prerequisite. The new sqllogic block does **not** exercise an
  MV-covered constraint, so `checkUniqueViaMaterializedView`'s comparator change is
  covered only indirectly (by the existing 102.2 MV sections, which are collation-only —
  no semantic-ordering column reaches that path in the suite today). That is the thinnest
  spot in the test coverage.
- **`checkUniqueByScanning` has no new direct test either.** It is the cold full-scan
  fallback that fires only when no covering structure exists ("pathological schemas" per
  its own comment); the suite reaches it through 102.2's existing cases, none of which use
  a semantic-ordering column. The change there is the same three-line substitution as the
  other two sites, but it is unproven by a test that would fail if reverted.
- **JSON UNIQUE was already correct and stays correct**, now via a different route (the
  type's structural `compare` rather than canonical-text equality through
  `compareSqlValuesFast`). Both agree on equality, and the existing key-reordered-object
  case still rejects — but a reviewer may want to confirm no ordering-sensitive UNIQUE
  path depends on which of the two produced the verdict.
- **Perf**: each of the three sites now allocates one closure per constrained column per
  constraint check, on top of the collation resolve it already did. `checkUniqueViaIndex`
  does this only after a candidate exists (the zero-candidate early bail is ahead of it),
  so the common no-conflict insert is untouched; the MV and scan paths build them
  unconditionally, as they already did for collations.

## Tripwire parked (not a ticket)

`MemoryTableManager.uniqueColumnsChanged` (manager.ts) decides whether an UPDATE needs a
UNIQUE re-check using byte-level `compareSqlValues`, so it over-triggers for a
semantic-ordering column: a `'PT1H'` → `'PT60M'` rewrite is reported as "changed" and
re-runs the check, which then excludes the row's own primary key and passes. Correct
today (it only gates *whether* to re-check), just not minimal. Recorded as a `NOTE:` in
that method's docstring.
