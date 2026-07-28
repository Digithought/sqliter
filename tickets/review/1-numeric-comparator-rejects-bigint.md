description: A column declared with the loose "numeric" type is allowed to hold whole numbers too large for a JavaScript number, but the code that orders and compares those columns used to crash the moment it saw one — fixed so ordering and comparison now work correctly.
files:
  - packages/quereus/src/types/builtin-types.ts       # NUMERIC_TYPE.compare — now its own implementation
  - packages/quereus/test/type-system.spec.ts          # NUMERIC_TYPE describe block — new compare unit tests
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # new NUMERIC bigint regression section
difficulty: easy
---

# `NUMERIC`'s comparator no longer throws on bigint values

## What changed

`NUMERIC_TYPE.compare` in `packages/quereus/src/types/builtin-types.ts` previously
delegated to `REAL_TYPE.compare`, which does `isNaN(a as number)` — this throws
`TypeError: Cannot convert a BigInt value to a number` whenever a `numeric`-declared
column holds a whole number too large for a JS `number` (magnitude > 2^53), because
`NUMERIC`'s `validate`/`parse` legitimately accept both `number` and `bigint`.

`NUMERIC_TYPE.compare` now has its own body:

1. `compareNulls(a, b)` first (shared convention across all builtin types).
2. NaN handling matching `REAL_TYPE`'s: a `NaN` (checked via `typeof a === 'number' &&
   isNaN(a)` — safe on bigint operands, unlike bare `isNaN`) sorts smallest; two NaNs
   compare equal.
3. Plain `<` / `>` on the `number | bigint` pair — same pattern `INTEGER_TYPE.compare`
   already uses — which JS evaluates exactly across both representations with no
   precision loss.

`REAL_TYPE.compare` itself was deliberately left untouched: `bigint` is genuinely
outside `REAL`'s value space (its `validate` only accepts `number`), so a bigint
reaching `REAL_TYPE.compare` is a real upstream defect and throwing is correct
there. (Ticket `set-op-numeric-promotion-skips-conversion`, gated on this one,
addresses one such upstream defect — a set operation that was routing a bigint
into `REAL`.)

## Reproduction now fixed

```sql
create table n (v numeric primary key);
insert into n values (9007199254740993);   -- bigint, past 2^53
insert into n values (3);                  -- previously threw here
select cast(v as text) from n order by v;  -- ["3","9007199254740993"]
```

## Test coverage added

- `packages/quereus/test/type-system.spec.ts`, `NUMERIC_TYPE` describe block:
  - `9007199254740993n` vs `9007199254740992` compares as `1` (not `0`) — the
    precision case a `Number()`-based comparator would silently get wrong.
  - `9007199254740993n` vs a plain small number doesn't throw.
  - NaN placement: NaN < 1, 1 > NaN, NaN == NaN (matches `REAL_TYPE`).
- `packages/quereus/test/logic/03.6-type-system.sqllogic`, new section
  "NUMERIC comparator across the number/bigint boundary": a `numeric primary key`
  table holding one bigint-range value and one small value — both inserts
  succeed, `order by` puts them in value order. Uses `cast(v as text)` to pin the
  exact large value, per the harness's `normalizeBigInts` (in `test/logic.spec.ts`)
  rounding BigInt results to Number before comparing raw numeric output.

## Gaps / things not exercised

- No test drives this through an actual B-tree rebalance with many bigint keys —
  coverage is a two-row insert (matches the ticket's minimal repro) plus a direct
  unit comparator check. If there's a suspicion the memory B-tree does something
  bigint-unsafe beyond comparison (e.g. key hashing/encoding), that's outside this
  ticket's diff and unverified here.
- Didn't check every other call site that might assume `NUMERIC_TYPE.compare`
  never throws on NaN specifically for bigint-adjacent values (e.g. `MIN`/`MAX`
  aggregates, `BETWEEN`) — only ordering/comparison via the type's `compare` was
  in scope per the ticket. Aggregates route through `createSemanticValueComparator`
  which uses the same `type.compare`, so they should inherit the fix, but this
  wasn't independently re-tested end-to-end.
- `REAL_TYPE.compare` was intentionally left throwing on bigint — confirmed
  correct per the ticket's scope note, not re-verified against
  `set-op-numeric-promotion-skips-conversion` (separate ticket, prereq direction
  is the other way: that ticket depends on this one, not vice versa).

## Validation run

- `yarn build` — passed (repo root).
- `yarn test` — passed, full workspace suite (7455 + others, all green; no new
  failures).
- `yarn lint` — passed, including `packages/quereus`'s eslint + `tsc -p
  tsconfig.test.json --noEmit` pass (covers the new test file's types too).

No pre-existing failures encountered.
