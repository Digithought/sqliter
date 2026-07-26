description: A disk-backed table could silently accept a row that broke a uniqueness rule, when its primary key was a JSON value that happened to be a piece of text spelled like a number; the same table stored in memory correctly rejected it. Fixed.
files:
  - packages/quereus/src/types/json-type.ts                      # JSON_TYPE.compare — the fix (one line, plus comment rewrite)
  - packages/quereus-store/src/common/store-table.ts              # resolvePkSemanticEquality — stale BUG note removed
  - packages/quereus-store/src/common/json-key.ts                 # header NOTE rewritten to describe post-fix agreement
  - packages/quereus-store/test/json-semantic-key-order.spec.ts   # 3 new regression tests
difficulty: easy
---

# JSON primary keys no longer compare as "the same row" when they are different rows

## What changed

`JSON_TYPE.compare` (`packages/quereus/src/types/json-type.ts`, string-vs-string branch)
used to honor a plain text comparison **only when a collation argument was supplied**;
with no collation it fell through to re-parsing each side as JSON, so `'9'` and `'9.0'`
(as JSON string scalars) both parsed to the number 9 and compared equal. Two "is this
the same row?" comparators are built with no collation — `resolvePkSemanticEquality`
(`packages/quereus-store/src/common/store-table.ts`) and `getPkSemanticComparators`
(`packages/quereus-isolation/src/isolated-table.ts`) — and the store's UNIQUE check
uses the first to exclude the row being written from its own conflict search, so it
believed a conflicting existing row *was* the row being inserted and swallowed the
violation.

Fix: default the string-vs-string branch to `compareCodePoints` (BINARY) when no
collation is supplied, matching every other typed comparator's "no collation ⇒ BINARY"
convention (`TEXT_TYPE.compare` already does exactly this) and matching
`deepCompareJson`'s string-leaf order and the store's structural JSON key bytes
(`json-key.ts`).

```ts
if (typeof a === 'string' && typeof b === 'string') {
    return collation ? collation(a, b) : compareCodePoints(a, b);
}
```

Stale notes cleaned up:
- `store-table.ts`'s `resolvePkSemanticEquality` doc comment — removed the `BUG:`
  paragraph naming this ticket; contract text above it is unchanged.
- `json-key.ts`'s header `NOTE:` — used to explain the divergence between the
  structural key bytes' code-point order and bare `JSON_TYPE.compare`'s re-parsing
  behavior. Rewritten to state the two now agree (ordering paths and PK-equality paths
  alike).
- `isolated-table.ts`'s `pkSemanticCache` / `getPkSemanticComparators` doc comments
  were checked — they never asserted the old (wrong) behavior, only the general
  contract ("'PT1H' and 'PT60M' must key the same"), so no edit was needed there.

## Repro (now fixed)

```sql
create table t (j json primary key, u text unique) using store;
insert into t values ('"9"', 'dup');
insert into t values ('"9.0"', 'dup');   -- now raises: ConstraintError: UNIQUE constraint failed: t (u)
```

Before the fix: the store accepted both rows silently, ending with two rows sharing
`u = 'dup'` — a durable violation of a `unique` column. A plain in-memory table (no
`using store`) already raised the constraint error correctly; behavior now matches.

## Tests added (`packages/quereus-store/test/json-semantic-key-order.spec.ts`)

1. `describe('plain-scan order matches the memory table')` → **"keeps JSON-number-spelled
   string scalars distinct, in code-point order"**: inserts `'"9"'`, `'"9.0"'`, `'"10"'`
   into both a `using store` table and a plain memory table, asserts both scan as
   `'"10"' < '"9"' < '"9.0"'` (code-point order, not numeric).
2. `describe('primary key identity')` → **"rejects a JSON-number-spelled string PK as a
   duplicate when it collides via a UNIQUE column, as the memory table does"**: the
   exact repro above (`json primary key` + `text unique`), run against both the store
   table and the memory table, asserting a `UNIQUE` error and a single surviving row on
   both.
3. `describe('JSON structural key order (isolated store)')` → **"keeps a
   JSON-number-spelled string PK distinct from a committed row across `insert or
   replace`"**: a committed `('"9"', 'committed')` row, then in an open transaction
   `insert or replace into o values ('"9.0"', 'staged')`; asserts both the staged view
   (mid-transaction) and the post-commit table hold **two** rows, not one. Verified this
   fails before the fix (staging collapses onto the committed row) and passes after.

## Known gap — carried forward, not closed here

The ticket's originally-suggested isolation-layer test ("an in-transaction UPDATE of one
such row must not disturb the other") could not be written. It is blocked by a *separate*,
pre-existing defect: any UPDATE or DELETE of a row whose JSON column holds a string
scalar either mutates the value or fails outright, on every backend. That is already
filed independently as `tickets/fix/bug-json-string-scalar-not-round-trip-safe.md` — it
predates this ticket, was rediscovered (not fixed) during this work, and is confirmed
independent of this fix (still reproduces with this fix applied). Test 3 above uses
`insert or replace` specifically to route around that gap. No new ticket needed — the
existing `fix/` ticket already covers it; this review inherits it as an open dependency
for anyone writing the UPDATE/DELETE-shaped regression test later.

## Validation run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/store run test` — 1006 passing, 0 failing.
- `yarn test` (full workspace) — 7180 + 1003 + 481 + 251 + … passing across every
  package, 0 failing, 13 pending (pre-existing, unrelated).
- `yarn lint` (fans out; `@quereus/quereus`'s real eslint+tsc pass run directly too) —
  clean.
- `yarn typecheck` — clean.

## Review findings

- Fix and comment rewrites match the ticket's verified diff exactly (single line
  behavior change in `json-type.ts`, doc-comment cleanup in the two other files).
  `isolated-table.ts` needed no edit — checked its doc comments and none depended on
  the old behavior.
- Added the 3 tests specified in the ticket's Phase 3 (regression coverage for PK
  identity, plain-scan order, and the isolation-overlay `insert or replace` case).
  Full workspace test suite (7180+ tests across all packages) and store-only suite
  (1006 tests) both green; no pre-existing failures encountered.
- Known gap carried forward (not a new ticket — already tracked): the UPDATE/DELETE
  isolation regression test the ticket originally asked for is still blocked by
  `bug-json-string-scalar-not-round-trip-safe` in `tickets/fix/`. Flagging here again
  so a reviewer doesn't mistake its absence for an oversight.
