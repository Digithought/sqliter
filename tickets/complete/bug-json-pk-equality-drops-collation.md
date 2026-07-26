---
description: A disk-backed table could silently accept a row that broke a uniqueness rule, when its primary key was a JSON value that happened to be a piece of text spelled like a number; the same table stored in memory correctly rejected it. Fixed and reviewed.
files:
  - packages/quereus/src/types/json-type.ts                       # JSON_TYPE.compare — the fix (one line), comment corrected in review
  - packages/quereus/test/type-system.spec.ts                     # unit-level regression added in review
  - packages/quereus-store/src/common/store-table.ts              # stale BUG note removed
  - packages/quereus-store/src/common/json-key.ts                 # header NOTE rewritten
  - packages/quereus-store/test/json-semantic-key-order.spec.ts   # 3 end-to-end regression tests
  - docs/types.md                                                 # JSON comparison entry clarified in review
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

Stale notes cleaned up: the `BUG:` paragraph on `resolvePkSemanticEquality`, and
`json-key.ts`'s header `NOTE:` describing the old divergence. `isolated-table.ts`
never asserted the old behavior, so it needed no edit.

## Repro (now fixed)

```sql
create table t (j json primary key, u text unique) using store;
insert into t values ('"9"', 'dup');
insert into t values ('"9.0"', 'dup');   -- now raises: ConstraintError: UNIQUE constraint failed: t (u)
```

Before the fix the store accepted both rows silently, ending with two rows sharing
`u = 'dup'`. A plain in-memory table already raised the error correctly; behavior
now matches.

## Tests

End-to-end (`packages/quereus-store/test/json-semantic-key-order.spec.ts`, from implement):

1. **Plain-scan order** — `'"9"'`, `'"9.0"'`, `'"10"'` into a `using store` table and a
   memory table; both must scan as `'"10"' < '"9"' < '"9.0"'` (code point, not numeric).
2. **PK identity / UNIQUE** — the repro above, asserted against both backends.
3. **Isolation overlay** — a committed `'"9"'` row plus an in-transaction
   `insert or replace` of `'"9.0"'` must leave **two** rows, staged and post-commit.

Unit level (`packages/quereus/test/type-system.spec.ts`, added in review): direct
`JSON_TYPE.compare` assertions that two string scalars compare as text with *and*
without a collation (`'9' < '9.0'`, `'10' < '9'`, NOCASE still folds `'Bob'`/`'bob'`),
plus a structural-ordering test (`{"a":2} < {"a":10}`, type-rank order). The
end-to-end tests all route through the store/isolation stack; nothing pinned the
comparator itself, so a future refactor could have reverted the one-line fix with a
green store suite.

## Known gap — carried forward, not closed here

The originally-suggested isolation test ("an in-transaction UPDATE of one such row must
not disturb the other") could not be written: any UPDATE or DELETE of a row whose JSON
column holds a string scalar either mutates the value or fails outright, on every
backend. Filed independently as `tickets/fix/bug-json-string-scalar-not-round-trip-safe.md`
— it predates this ticket and still reproduces with this fix applied. Test 3 uses
`insert or replace` to route around it.

## Validation

- `yarn build` — clean.
- `yarn test` (full workspace) — 7180 passing before the review's added tests,
  7182 after; 0 failing, 13 pending (pre-existing, unrelated). Store package 1006
  passing. No pre-existing failures encountered, so `.pre-existing-error.md` was not
  written.
- `yarn lint` (real eslint + `tsc -p tsconfig.test.json` pass in `@quereus/quereus`) — clean.
- `yarn typecheck` — clean.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; the fix's blast
radius (every call site that can reach `JSON_TYPE.compare`, and whether values arriving
there are coerced or raw); the three comment rewrites against actual current behavior;
test coverage at unit / end-to-end / isolation levels; `docs/types.md`'s JSON and
"Semantic ordering" sections; lint, typecheck, build, full test suite.

**Correctness of the fix itself:** confirmed sound. Verified empirically that
post-coercion paths order correctly (`select (a < b)` on stored JSON objects → true;
`order by` on a JSON column emits structural order) and that the mixed-type fallthrough
is unreachable end-to-end (a store table with a `'"9"'` string-scalar PK and a `'9'`
number PK still raises the UNIQUE violation, because both backends address rows through
structural key bytes rather than this comparator).

**Major — new ticket filed:** `tickets/fix/bug-json-compare-string-ambiguity.md`.
`JSON_TYPE.compare` cannot distinguish a JSON string *scalar* from *serialized JSON
text*, and guesses. Two consequences, both **pre-existing** (present before this fix,
unchanged by it — the affected path always supplies a collation, which both the old and
new code honor identically):
- An immediate `check (a < b)` over two JSON columns evaluates against the raw,
  uncoerced NEW row, so it compares serialized text alphabetically instead of
  structurally. Verified: `check (a < b)` rejects `('{"a":2}', '{"a":10}')`, while the
  same comparison after storage correctly returns true.
- `JSON_TYPE.compare('9', 9)` returns `0` — the string scalar is re-parsed as a number,
  claiming a JSON string and a JSON number are the same value despite the type's own
  rank order. Latent only; no reachable end-to-end failure found (see above).
Filed as one ticket because fixing either half independently pulls against the other;
the durable answer is to remove the ambiguity at the source (coerce before immediate
CHECK) rather than sniff harder inside `compare`.

**Minor — fixed inline in this pass:**
- The new comment in `json-type.ts` asserted "serialized JSON text does not reach here",
  which is false (the CHECK path above). Narrowed to state the true invariant: every
  *collation-less* caller reads post-`coerceRowToSchema` values, and the one raw-text
  caller always supplies a collation.
- Added the unit-level `JSON_TYPE.compare` regressions described above — the fix had no
  test at the layer it was actually made.
- `docs/types.md` line 210 said only "Numeric storage class holds, so a JSON scalar `5`
  equals `5.0`", which invited exactly this bug's misreading. Clarified that the rule is
  about *number* scalars and that a *string* scalar always compares as text.

**Tripwires:** none recorded. Every concern found was either definitely wrong now (filed
as the ticket above) or already correct — nothing fell into the "fine now, only matters
if X later" shape.

**Noted, not filed:** `docs/types.md` line 214 says JSON uses `serialize()`/
`deserialize()` hooks for storage and read-back. In fact `LogicalType.serialize` and
`LogicalType.deserialize` are never called anywhere in the monorepo — only `parse` is;
the store round-trips whole rows through `JSON.stringify`/`JSON.parse`
(`packages/quereus-store/src/common/serialization.ts`). Harmless today (the described
behavior happens to match what actually occurs) but misleading to anyone reasoning about
where coercion happens, which is precisely what the new fix ticket asks someone to do —
so it is captured in that ticket's "Notes for whoever picks this up" rather than
duplicated as its own ticket.

**Pre-existing failures:** none. Full suite green throughout.
