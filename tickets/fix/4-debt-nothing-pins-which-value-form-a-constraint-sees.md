---
description: Nothing in the test suite records which form of a written value a CHECK constraint is handed — the value as the caller wrote it, or the value after conversion to the column's declared type. That contract changed between two patch releases, silently broke a downstream project's whole test suite, and could move again tomorrow without a single test going red.
files:
  - packages/quereus/src/runtime/emit/insert.ts              # buildRowCoercion at the top of the INSERT pipeline — where the form is decided
  - packages/quereus/src/runtime/emit/update.ts              # the mirror site for UPDATE (regular + generated cells)
  - packages/quereus/src/runtime/emit/constraint-check.ts    # immediate CHECK evaluation; once held its own coerceNewSection for the deferred path
  - packages/quereus/src/runtime/deferred-constraint-queue.ts # deferred CHECK evaluation — the other half of the contract
  - packages/quereus/src/runtime/emit/dml-executor.ts        # passes preCoerced: true to vtab.update
  - packages/quereus/src/types/validation.ts                 # buildRowCoercion / buildCellCoercion
  - packages/quereus/test/dml-write-representation.spec.ts   # pins what STORAGE sees; says nothing about what a CHECK sees
  - docs/types.md                                            # § Where coercion happens (and why exactly once) — states the rule, names no test
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: The behaviour being pinned is already the intended one and is already described in docs/types.md, so this buys no new capability — a maintainer may read it as writing tests for something that is not broken. The counter-argument is the measured one: it silently broke and nothing noticed.
---

# Nothing pins which form of a value a CHECK constraint sees

## What happened

GitHub issue [#28](https://github.com/gotchoices/quereus/issues/28) reports that an
IMMEDIATE `CHECK` on a `datetime` column changed what value it was handed between
`@quereus/quereus@4.3.1` and `4.4.1` — a patch-level release, with no note.

- **4.3.1** — `runtime/emit/insert.ts` passed the source row through unconverted, so an
  immediate CHECK saw the value **as the caller provided it**. A separate
  `coerceNewSection()` in `constraint-check.ts` converted the row on the *deferred* path
  only, so a deferred CHECK saw the **declared form**. The split was deliberate: the
  deleted function's own comment says deferred checks were coerced specifically so that a
  `new.*` value compares equal to an already-converted stored row in another table.
- **4.4.1** — `buildRowCoercion(...)` moved to the top of the DML pipeline and
  `coerceNewSection` was deleted. Both paths now see the **declared form**.

That collapse is the *right* end state and it is what `docs/types.md` §
"Where coercion happens (and why exactly once)" documents — a value converts once, at the
top of the DML pipeline, because conversion is not repeatable (`JSON_TYPE.parse` is not
idempotent). It also fixed issue [#25](https://github.com/gotchoices/quereus/issues/25),
where a deferred CHECK subquery compared a raw numeric `new.ParentTS` against an already
converted `Parent.TS` and never matched. Verified on `main` at `v4.17.1`: #25's
reproduction now passes.

**The defect is not the behaviour. The defect is that nothing holds it in place.**

## Measured

Reproduced on `main` at `v4.17.1` (`bd52505ba`), against `packages/quereus/dist`:

```
create table Ev (Id text primary key, Ts datetime,
                 constraint TsHasZ check (like('%Z', Ts)));
insert into Ev (Id, Ts) values ('e1', '2099-01-01T00:00:00.000Z');
-- CHECK constraint failed: TsHasZ (like('%Z', Ts))
-- the CHECK is handed '2099-01-01T00:00:00' — the declared form, Z stripped
```

Downstream cost when it moved, as reported on #28: the VoteTorrent vote-engine suite went
from 1027 passing / 0 failing to 948 / 80 on stock 4.4.1 — 71 × a datetime shape CHECK,
plus 3 whose content-addressed digest is computed over the value the CHECK sees. The
reporter also measured that reverting *only* the up-front conversion (raw everywhere)
trades those 71 failures for 71 new ones on the deferred cross-table path — direct
evidence that both halves of the old split were load-bearing and that "make it all raw"
is not an available answer.

## What is missing

Searching the suite for what pins this:

- `test/dml-write-representation.spec.ts` pins what **storage** receives. It says nothing
  about constraint evaluation.
- `test/logic/06.9.1-json-coerce-once.sqllogic` (+ `.1-index`) pin that conversion happens
  **once**, for JSON. Neither asserts which form a CHECK sees.
- Nothing at all covers the immediate-vs-deferred agreement that #25 was about.

So the entire contract rests on two source comments and a docs paragraph.

## What this ticket wants

1. **A test that states the contract in one place**, covering all four expression kinds
   that evaluate against a written row and could each drift separately:
   - immediate `CHECK` (row-local),
   - deferred `CHECK` (subquery-bearing — and the #25 shape specifically: `new.*` compared
     against an already-stored value in another table),
   - `DEFAULT` expressions that reference `new.<col>`,
   - `GENERATED ALWAYS AS` expressions.

   Assert each is handed the **declared form**, on a type where the two forms are visibly
   different. `datetime` is the sharpest (`'2099-01-01T00:00:00.000Z'` → `2099-01-01T00:00:00`);
   JSON is the second (`'"Bob"'` → `Bob`); an INTEGER column fed a text literal is a third.
   Cover INSERT and UPDATE — `update.ts` carries its own mirror of the conversion and can
   drift independently.

2. **A line in `docs/types.md`** stating "a CHECK / DEFAULT / GENERATED expression is
   evaluated against the declared form, not the value as written" as a *contract* rather
   than as a consequence, and naming the test that guards it. Consider an entry in
   `docs/invariants.md`, which exists precisely for statements that name their file and
   their guarding test.

3. **A release note** for the 4.3.1 → 4.4.1 change. It is long past, but the project's
   own record should say the immediate-CHECK form changed and why, so the next person to
   read #28 does not have to reconstruct it from a `git diff`.

## What this ticket does NOT decide

Whether a `datetime` column should preserve a `Z` suffix at all — i.e. whether the
reporter's `like('%Z', Ts)` could ever be meaningful — is the canonical-spelling question
tracked in `bug-datetime-literal-with-timezone-never-matches`, which now carries GH #28 as
evidence in its Arm C. This ticket pins the coercion *timing* contract and is independent
of how that one lands.
