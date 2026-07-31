description: On in-memory tables, a uniqueness rule declared on a column that already has a filtered index quietly stopped working for most rows — duplicates were accepted even though the rule said they should not be. Fixed; this ticket is the build/test verification handoff.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # both fix sites, see below
  - packages/quereus-store/src/common/implicit-unique-index.ts         # findReusableIndexForUnique ~95 — the reference predicate
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # §10e — now asserts enforcement instead of carving it out
difficulty: easy
repro: verified
---

## Status: fix already applied in working tree, needs build/test sign-off

The root cause and the primary fix site were as described in the originating fix
ticket (`ensureUniqueConstraintIndexes`, ~line 275 of `manager.ts` — the search never
consulted `idx.predicate`, so a filtered index over the same columns matched an
unfiltered UNIQUE and constraint enforcement silently narrowed to whatever rows the
filter admitted).

**Investigation found a second, distinct site with the identical bug**, which is
actually what the ticket's own repro exercises (`alter table t add unique (c)`):
`MemoryTableManager.addUniqueConstraint` (~line 3135) has its own reuse search,
`matchingUniqueIndex`, used for `ALTER TABLE ADD UNIQUE` rather than column/table-level
UNIQUE declared at `CREATE TABLE` time. It checked `idx.unique` and column/collation
match but likewise never checked `idx.predicate` — so a `create unique index … where …`
index matched here too. Both call sites needed the same guard; fixing only the one
named in the original ticket would not have made the ticket's own repro pass.

### Fix

Both search predicates in `packages/quereus/src/vtab/memory/layer/manager.ts` now:
- skip the search entirely when the constraint itself is filtered (`uc.predicate` set)
  — a filtered UNIQUE already owns its own index and was never meant to reuse another;
- require `!idx.predicate` on the candidate index — a filtered index is never valid
  backing for an unfiltered rule, since it physically omits out-of-scope rows.

This mirrors `findReusableIndexForUnique` in
`packages/quereus-store/src/common/implicit-unique-index.ts:95`, which already applied
both conditions for the persistent-store backend.

### Test

`packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` §10e
previously stopped short of asserting enforcement, with a NOTE explaining the gap this
ticket closes. Replaced the NOTE and non-assertion with two inserts that reproduce the
ticket's exact repro (both rows fall outside either partial index's predicate; the full
UNIQUE must still reject the second one).

## TODO

- [x] `MemoryTableManager.ensureUniqueConstraintIndexes` — add predicate guard
- [x] `MemoryTableManager.addUniqueConstraint` — add matching predicate guard (second
      site, found during investigation, not in original ticket's `files:`)
- [x] Update `10.5.7-implicit-unique-index-lifecycle.sqllogic` §10e to assert enforcement
- [x] `yarn workspace @quereus/quereus run typecheck` — clean
- [x] `node test-runner.mjs` (memory backend) — 8166 passing, 0 failing
- [x] `yarn test:store` (LevelDB backend) — 8158 passing, 0 failing, no regression
- [ ] Review stage: confirm the two fix sites are the complete set — grep
      `manager.ts` for any other same-column index-reuse search that might share the
      same gap (e.g. around primary-key or FK-backing index selection) before closing
