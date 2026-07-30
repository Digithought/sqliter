---
description: Checking whether a JSON document is one of the values a subquery returns used to never find a match. Fixed in two places — the per-row membership check, and the rewrite that turns a correlated version of the query into a join.
files:
  - packages/quereus/src/types/cast-semantics.ts                  # new lenientCast()
  - packages/quereus/src/runtime/emit/cast.ts                     # emitCast now calls it
  - packages/quereus/src/runtime/emit/subquery.ts                 # inMembershipKeys (was inMembershipKey) + all 5 emitIn arms
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # extractInCorrelation
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic        # new § 5.1 / § 5.2
  - docs/types.md                                                 # JSON "Comparison against SQL text" bullet
difficulty: medium
---

# `json_col in (select text_col from …)` now matches structurally

## What changed

A JSON value lives in memory as a native JavaScript object; SQL text is a string. The
engine's generic value comparison ranks the two by storage class and never calls them
equal. Every comparison site fixes this at plan time by wrapping the non-JSON side in
`cast(… as json)`. Two sites skipped it; both now do it.

**Site A — per-row membership (`runtime/emit/subquery.ts`).** An `in` whose right-hand
side is a subquery has no fixed operand list to wrap at plan time, so the conversion
happens per row inside membership evaluation.

- `inMembershipKey` (one transform, applied symmetrically) became `inMembershipKeys`,
  returning `{ probe, member, note }` — one transform for the probe (the `condition`), one
  for each right-hand member value.
- Arm 1 (new): exactly one side object-physical (`PhysicalType.OBJECT`, i.e. JSON) →
  convert **only the non-object side** via the new `lenientCast`. Arm 2: the pre-existing
  symmetric semantic-normalization transform (TIMESPAN), unchanged.
- The asymmetry is load-bearing. Re-running the JSON side through `JSON_TYPE.parse` would
  re-parse JSON **string scalars**: a JSON column holding the document `"[1,2]"` is stored
  as the plain JS string `[1,2]`, and re-parsing turns it into the JSON *array* `[1,2]`,
  colliding two distinct documents.
- All five `emitIn` arms (impure drain, uncorrelated set-probe, correlated streaming,
  constant value list, dynamic value list) were threaded. The `=== null` checks moved to
  **after** the transform, because the conversion can produce NULL — a blob is a JSON
  value under no reading, so `lenientCast` returns NULL for it. A member that coerces to
  NULL sets `hasNull`; a condition that coerces to NULL returns NULL. In the set-probe arm
  that return happens **before** the set is built, preserving the existing "a NULL probe
  does not force the build" short-circuit.
- The set-probe memo `Symbol` local was renamed `probeKey` → `probeSlot` (the name now
  belongs to the probe transform).

**Site B — IN decorrelation (`rule-subquery-decorrelation.ts`, `extractInCorrelation`).**
A *correlated* `col in (subquery)` is rewritten into a semi join (WHERE position) or an
existence-flag LEFT join (SELECT-list position), and the rule synthesizes the membership
`=` itself by constructing a `BinaryOpNode` directly — bypassing the coercion a
hand-written `=` gets. It now reconciles the two operands through
`coerceObjectPhysicalSet` first.

`coerceObjectPhysicalSet`, deliberately, not `insertCrossTypeCoercion`: the latter also
applies its numeric-vs-textual arm, which would make a correlated
`int_col in (select text_col …)` start matching while the uncorrelated form kept missing —
a new disagreement, in the direction this ticket removes.

**Shared helper.** `lenientCast(value, type)` in `types/cast-semantics.ts` is the one
definition of "convert the way `CAST` does" (`parse`, falling back to `castFallback`).
`emitCast` is now a caller; it lost its inline duplicate. The `NOTE:` about parse-less
types moved onto `lenientCast`.

**New import edge:** `planner/rules/subquery/` → `planner/building/coercion.js`. Nothing
under `planner/rules/` imported from `planner/building/` before. No cycle
(`building/coercion.ts` depends only on `parser/ast`, `planner/scopes`, `planner/nodes`,
`types/`), and `yarn build` is clean — but it is a new architectural edge and worth a
reviewer's opinion. If unwanted, move `coercion.ts` to `planner/analysis/` or
`planner/util/` and update its now-five importers rather than duplicating the logic.

## Plan shapes, as actually rendered

Verified with a throwaway plan-dump spec (since deleted); useful for orienting a review:

| Query | Plan |
| --- | --- |
| `v in (select s from t)` (uncorrelated, mixed JSON/TEXT) | `IN \| v IN (subquery)` — set probe. Decorrelation declines: `extractEquiPairs`' `semanticOrderingsAgree` refuses a JSON/TEXT pair. |
| `s in (select v from j)` (reverse) | set probe, same reason |
| `j.v in (select t.s … where t.id = j.id)` (correlated, WHERE) | `SEMI MERGE JOIN on [id=id]` with `j.v = cast(s as json)` demoted to the residual |
| same, SELECT-list position | `LEFT JOIN` + `__exists_N` flag, condition `j.v = cast(s as json) AND t.id = j.id` |
| `j.v in (select k.v from j2 k)` (both JSON) | `SEMI HASH JOIN` — semantic orderings agree, so this one still decorrelates; the emitIn path is untouched here |

## Validation

- `node test-runner.mjs --grep "06.9.2"` — 2 passing (memory) and 2 passing under
  `--store` (LevelDB). The file carries no `using memory`, so store mode exercises the
  persisted byte-key path.
- `yarn test` — full monorepo green (quereus 8072 passing, 13 pending; every other
  package passing). No pre-existing failures surfaced.
- `yarn lint` — clean. `yarn build` — clean. `tsc -p tsconfig.json --noEmit` — clean.

## Coverage added — and what a reviewer should push on

`test/logic/06.9.2-json-structural-equality.sqllogic` gained **§ 5.1 IN subquery** and
**§ 5.2 numeric ↔ textual pairing was NOT widened**. `create table jse_txt` moved up from
§ 7 into § 5.1 (§ 5.1 needs it first); § 7 now notes where it lives.

§ 5.1 covers: uncorrelated set probe; reverse direction (TEXT probe, JSON members);
correlated WHERE semi join; SELECT-list existence-flag join; SELECT-list on a nullable
JSON column (declines the flag rewrite, so it lands on the correlated **streaming** arm —
the third source path); array element order still significant; a non-JSON inner value
inert rather than an error; both-sides-JSON regression guard; a multi-row mixed-spelling
inner; a blob inner value making membership UNKNOWN for both `in` and `not in`; inner NULL
three-valued logic for both.

**Known gaps — treat the tests as a floor:**

- **The "two spellings are ONE member" case is a weak pin.** `IN` is a membership test, so
  `count(*)` over the outer table is 1 whether the probe set holds one member or two. What
  it actually pins is that a multi-row mixed-spelling inner still matches. The real
  one-member-ness (duplicate BTree insert being a no-op) is not observable from SQL that I
  found; it rests on `compareSqlValuesFast`'s OBJECT branch comparing canonical JSON text,
  which is argued in a comment rather than tested. A unit test on the value set would pin
  it properly.
- **The impure arm (`IN(impure)`, a DML-with-RETURNING inner) has no JSON test.** It is
  threaded and reads correctly, but the object arm is unexercised there. Same for the
  **dynamic value-list** arm — the plan-time coercion already handles value lists, so arm 1
  cannot reach it today; the threading is defensive.
- **`text_col in (select json_col …)` is only covered uncorrelated.** The correlated
  reverse direction (TEXT outer, JSON inner, decorrelated) is untested.
- **§ 5.2's first two cases don't test what the section name suggests.** I checked the
  plans: `int_col in (select text_col …)`, both correlated and uncorrelated, decorrelate to
  a semi join and never reach `emitIn`. They pin result consistency only. The two cases
  added after them (a non-column left side, and projection position) are the ones that
  actually stay on the membership path and pin `inMembershipKeys` to the object pairing.
  Worth confirming those two really do decline decorrelation on every future plan change —
  a plan-shape spec would be sturdier than my inference from the sqllogic result.
- **Store mode was run for `06.9.2` only**, not the full `yarn test:store` suite (wall-clock).
- The impure arm now applies `memberKey` to every drained row even when the answer is
  already NULL. Harmless (the drain is mandatory for side effects) and I left it for
  clarity, but it is wasted JSON parsing in that corner.

## Docs

`docs/types.md`, the JSON type's "Comparison against SQL text" bullet: the "One surface is
**not** covered" sentence is replaced with the closed behavior (per-row conversion inside
membership evaluation, asymmetric so JSON string scalars are not re-parsed, and the
decorrelated form carrying the same coercion in its synthesized `=`). Ticket link dropped.

## Tripwires parked

None new. Two pre-existing pointers were preserved verbatim rather than acted on: the
numeric-vs-textual IN/CASE gap (`bug-numeric-text-coercion-skips-in-and-case`) is
referenced from both `coercion.ts` and the new `inMembershipKeys` doc comment, and the
set-probe "no size cap" NOTE in `emitIn` is unchanged.
