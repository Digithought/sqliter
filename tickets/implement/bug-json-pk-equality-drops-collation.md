---
description: A disk-backed table can silently accept a row that breaks a uniqueness rule, when its primary key is a JSON value that happens to be a piece of text spelled like a number. The same table stored in memory correctly rejects it.
files:
  - packages/quereus/src/types/json-type.ts                      # JSON_TYPE.compare — THE fix (one line)
  - packages/quereus-store/src/common/store-table.ts             # resolvePkSemanticEquality — stale `BUG:` note to remove
  - packages/quereus-isolation/src/isolated-table.ts             # getPkSemanticComparators (~line 87) — same site, no code change needed
  - packages/quereus-store/src/common/json-key.ts                # header NOTE (~line 55) describing the divergence — must be rewritten
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # home for the regression tests
difficulty: easy
---

# JSON primary keys compare as "the same row" when they are different rows

## Confirmed reproduction

```sql
create table t (j json primary key, u text unique) using store;
create table m (j json primary key, u text unique);

insert into t values ('"9"', 'dup');
insert into t values ('"9.0"', 'dup');   -- ACCEPTED: two rows, both u = 'dup'

insert into m values ('"9"', 'dup');
insert into m values ('"9.0"', 'dup');   -- correctly raises UNIQUE constraint failed
```

Observed at HEAD: memory raises `ConstraintError: UNIQUE constraint failed: m (u)`; the
store returns no error and ends holding
`[{"q":"\"9\"","u":"dup"},{"q":"\"9.0\"","u":"dup"}]` — a durable violation of a
`unique` column.

## Root cause

`JSON_TYPE.compare` (`packages/quereus/src/types/json-type.ts`, ~line 72) honours a
plain text-vs-text comparison **only when a collation argument is supplied**:

```ts
if (typeof a === 'string' && typeof b === 'string' && collation) {
    return collation(a, b);
}
```

With no collation it falls through to re-parsing each side as JSON text, so the native
JS strings `9` and `9.0` both parse to the number 9 and compare equal.

Two "is this the same row?" comparators are built with no collation —
`resolvePkSemanticEquality` (store-table.ts) and `getPkSemanticComparators`
(isolated-table.ts), both via `createTypedComparator(logicalType)`. The store's UNIQUE
check uses the first to exclude the row being written from its own conflict search; it
therefore believes the conflicting existing row *is* the row being inserted, and the
violation is swallowed.

Every other JSON type in the engine already defaults its own collation internally —
`TEXT_TYPE.compare` is literally `(collation ?? BINARY_COLLATION)(a, b)`
(`packages/quereus/src/types/builtin-types.ts:139`). JSON is the only type that treats
"no collation" as a *different comparison* rather than "BINARY". So the fix belongs in
the type, not at the call sites.

`BINARY_COLLATION` is exactly `compareCodePoints`
(`packages/quereus/src/util/comparison.ts:88`), which is already what
`deepCompareJson` uses for string leaves and what the store's structural key bytes
produce — so defaulting to it makes equality agree with ordering and with the physical
key identity, which is the ticket's stated expected behaviour.

TIMESPAN — the other type routed through these comparators — declares
`compare: (a, b) => ...` with no collation parameter at all
(`packages/quereus/src/types/temporal-types.ts:331`), so it is unaffected.

## Verified fix

One line in `packages/quereus/src/types/json-type.ts`:

```ts
if (typeof a === 'string' && typeof b === 'string') {
    return collation ? collation(a, b) : compareCodePoints(a, b);
}
```

`compareCodePoints` is already imported in that file. With this applied and
`@quereus/quereus` rebuilt, the repro above raises
`ConstraintError: UNIQUE constraint failed: t (u)` and the store keeps one row.

**Regression risk: measured as none.** `yarn test` across the whole workspace was run
with this change applied: 7180 + 1003 + 481 + 251 + … passing, **0 failing**. The two
call sites need no code change once the type defaults correctly; leave them building
the comparator as they do.

## Scope note discovered while reproducing

The ticket's suggested isolation-layer regression test — "an in-transaction update of
one such row must not disturb the other" — **cannot be written yet**, and not because
of this bug. A separate defect makes any UPDATE or DELETE of a row whose JSON column
holds a string scalar either mutate the value or fail outright, on every backend. That
is filed as `bug-json-string-scalar-not-round-trip-safe` and is independent of this
fix (verified: it still reproduces with the fix above applied). Write the isolation
regression here against `insert or replace` only, which does not go through that path
and which was verified to behave correctly with the fix.

## TODO

Phase 1 — the fix

- Apply the one-line change to the two-strings branch of `JSON_TYPE.compare` in
  `packages/quereus/src/types/json-type.ts`.
- Update that branch's comment: it currently explains why the branch is
  collation-conditional. It is no longer. State instead that string scalars always
  compare as text, under the supplied collation or BINARY, so equality here agrees with
  `deepCompareJson`'s string leaves and with the store's structural key bytes.

Phase 2 — retire the stale notes

- `packages/quereus-store/src/common/store-table.ts`: delete the `BUG:` paragraph in
  the `resolvePkSemanticEquality` doc comment (it names this ticket slug). Keep the
  surrounding contract text.
- `packages/quereus-store/src/common/json-key.ts`: rewrite the header `NOTE:`
  (~line 55) that says bare `JSON_TYPE.compare` with no collation re-parses a string
  leaf and so calls `'9'` and `'9.0'` equal. Replace with a positive statement that
  top-level string values order by code point in both the key bytes and every
  comparator, collation argument or not.
- `packages/quereus-isolation/src/isolated-table.ts`: check the
  `pkSemanticCache` / `getPkSemanticComparators` doc comment (~lines 77-100) for any
  claim that depends on the old behaviour; adjust only if it does.

Phase 3 — regression tests, in
`packages/quereus-store/test/json-semantic-key-order.spec.ts`

- Under `describe('primary key identity')`: the repro above — a `json primary key`
  plus a `text unique` column, insert `'"9"'` then `'"9.0"'` with the same `u`, assert
  the store raises a UNIQUE error and holds one row, and assert the memory table
  behaves identically (the file's existing oracle pattern).
- Under `describe('plain-scan order matches the memory table')`: assert `'"9"'`,
  `'"9.0"'` and `'"10"'` are three distinct rows in the store and scan in code-point
  order (`"10"` < `"9"` < `"9.0"`), matching the memory table.
- Under `describe('JSON structural key order (isolated store)')`: a committed row
  `('"9"', 'committed')`, then in a transaction
  `insert or replace into o values ('"9.0"', 'staged')`; assert the staged view and the
  post-commit table both hold **two** rows. (Verified to fail before the fix path and
  pass after.) Do **not** use UPDATE or DELETE here — see the scope note.

Phase 4 — validate

- `yarn workspace @quereus/quereus run build`, then
  `yarn workspace @quereus/store run test`, then `yarn test` from the repo root.
- `yarn lint` and `yarn typecheck`.
