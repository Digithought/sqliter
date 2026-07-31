description: On in-memory tables, a uniqueness rule declared on a column that already has a filtered index quietly stopped working for most rows — duplicates were accepted even though the rule said they should not be. Fixed at both known sites; this ticket hands off for review, including one more related spot worth a second look.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # two fix sites + one flagged-not-fixed site, see below
  - packages/quereus-store/src/common/implicit-unique-index.ts         # findReusableIndexForUnique ~95 — the reference predicate the fixes mirror
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # §10e — now asserts enforcement instead of carving it out
difficulty: easy
repro: verified
---

## Summary

Two distinct index-reuse searches in `MemoryTableManager` matched a same-column
index as backing for a UNIQUE constraint without checking whether that index
was **filtered** (`create index … where …` / a partial index). A filtered index
only contains the rows matching its own predicate, so adopting it as the sole
enforcement structure for an *unfiltered* UNIQUE silently narrowed enforcement
to whatever the filter admitted — duplicates outside the filter went through.

Both now:
- skip the search entirely when the constraint itself is filtered (`uc.predicate`
  set) — a filtered UNIQUE already owns its own index and was never a candidate
  for reuse in the first place;
- require `!idx.predicate` on the candidate index — a filtered index is never
  valid backing for an unfiltered rule.

This mirrors `findReusableIndexForUnique` in
`packages/quereus-store/src/common/implicit-unique-index.ts:95`, which already
applied both conditions for the persistent-store backend (store was never
affected by this bug).

### Fix site 1 — `ensureUniqueConstraintIndexes` (~manager.ts:279)

Column/table-level `UNIQUE` declared at `CREATE TABLE` time. This was the site
named in the originating ticket.

### Fix site 2 — `addUniqueConstraint` (~manager.ts:3154)

`ALTER TABLE … ADD UNIQUE`'s own separate reuse search (`matchingUniqueIndex`),
found during investigation — **not** in the originating ticket's `files:` list,
but this is actually the site the ticket's own repro (`alter table t add unique
(c)`) exercises. Fixing only site 1 would not have made the repro pass.

## Test coverage

`test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` §10e previously
stopped short of asserting enforcement, with a NOTE explaining the gap. Replaced
the NOTE and non-assertion with two inserts that reproduce the ticket's exact
repro: both rows fall outside either partial index's predicate, and the full
UNIQUE must still reject the second one.

## Verification performed (this pass)

- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `node test-runner.mjs` (memory backend, from `packages/quereus/`) — **8166
  passing, 0 failing, 13 pending**.
- `yarn test:store` (LevelDB backend, from repo root) — **8158 passing, 0
  failing, 21 pending** (a handful of `[TransactionCoordinator] release/rollback
  savepoint … out of range` lines print to stderr during the run; these are
  logged warnings, not test failures — the run still reports 0 failing, and
  this is pre-existing console noise unrelated to this diff).
- Read both diffs directly (`git show a9946170`) — confirms the fix is exactly
  the two guarded searches described above, plus the sqllogic assertion change.

## What to check in review

**A third same-shape site, deliberately not fixed here — needs a decision.**

`MemoryTableManager.findIndexForConstraint` (manager.ts:1333) resolves which
*existing* structure enforces an already-established UNIQUE constraint (used on
every write to check uniqueness — call sites at manager.ts:1221 and :1279). It
tries by-name resolution first (`uc.derivedFromIndex`, or
`getImplicitCoveringStructure`, both of which resolve through the names the two
fixed sites above establish at creation time) and only when *that* fails does
it fall through to a **defensive column-set-only scan** (manager.ts:1375-1381)
that, like the two bugs just fixed, does not check `idx.predicate` — so if it
ever matches, it could hand back a filtered index as the enforcement structure
for an unfiltered constraint, silently under-enforcing the same way.

Whether this is reachable today:
- For any UNIQUE constraint created *after* this fix, by-name resolution should
  always succeed (the creation sites now correctly name/register the
  constraint's own structure), so the fallback shouldn't trigger in practice.
- The surrounding comments (manager.ts:1346-1361) explicitly document it as
  "defensive... only when the name does not resolve" — the same classification
  already given to an analogous fallback lower in the file (the "adopt a
  claimed name" defence-in-depth at manager.ts:286-296, added for the sibling
  `bug-duplicate-unnamed-unique-constraint` ticket), which was accepted as
  intentional tolerance for catalogs predating the naming guards.
- I did not find a currently-reachable path (outside a corrupted/legacy
  catalog) where by-name resolution fails for a constraint created through the
  current code. If review agrees, this reads as a tripwire ("fine now; if
  by-name resolution ever fails *and* a same-column filtered index exists, this
  silently mis-enforces") — comment at the site rather than a new ticket. If
  review finds a live path I missed, it's a third fix site, same shape as the
  two above (skip when `uc.predicate` set, require `!idx.predicate` on the
  candidate).
- I did not fix it inline myself because the originating ticket explicitly
  scoped "confirm the two fix sites are the complete set" to the review stage
  (its last TODO item) — leaving the fix-vs-tripwire call to review's
  adversarial pass rather than deciding it in the same pass that found it.

## TODO

- Adversarial review pass per stage rules (minor → fix inline; major → new
  ticket; conditional/speculative → tripwire comment, not a ticket).
- Resolve the `findIndexForConstraint` fallback question above: tripwire
  comment, or fix.
- Promote to `tickets/complete/` with a `## Review findings` section.
