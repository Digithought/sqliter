---
description: Checking whether a JSON document is one of the values a subquery returns used to never find a match. Fixed in two places — the per-row membership check, and the rewrite that turns a correlated version of the query into a join.
files:
  - packages/quereus/src/types/cast-semantics.ts                  # lenientCast() + per-row-throw tripwire
  - packages/quereus/src/runtime/emit/cast.ts                     # emitCast now calls it
  - packages/quereus/src/runtime/emit/subquery.ts                 # inMembershipKeys + all 5 emitIn arms
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # extractInCorrelation
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic        # § 5.1 / § 5.2
  - docs/types.md, docs/optimizer-rules.md, docs/runtime-caching.md
difficulty: medium
---

# `json_col in (select text_col from …)` matches structurally

## What shipped

A JSON value lives in memory as a native JavaScript object; SQL text is a string. The
engine's generic value comparison ranks the two by storage class and never calls them
equal. Every comparison site reconciles this by wrapping the non-JSON side in
`cast(… as json)`. Two sites skipped it; both now do it.

**Site A — per-row membership (`runtime/emit/subquery.ts`).** An `in` whose right-hand
side is a subquery has no fixed operand list to wrap at plan time, so the conversion
happens per row inside membership evaluation. `inMembershipKey` (one symmetric transform)
became `inMembershipKeys`, returning `{ probe, member, note }`. Arm 1 (new): exactly one
side object-physical → convert **only the non-object side** via the new shared
`lenientCast`. Arm 2: the pre-existing symmetric TIMESPAN normalization, unchanged.

The asymmetry is load-bearing. Re-running the JSON side through `JSON_TYPE.parse` would
re-parse JSON **string scalars**: a JSON column holding the document `"[1,2]"` is stored
as the plain JS string `[1,2]`, and re-parsing turns it into the JSON *array* `[1,2]`,
colliding two distinct documents.

All five `emitIn` arms are threaded. The `=== null` checks moved to **after** the
transform, because the conversion can produce NULL — a blob is a JSON value under no
reading, so `lenientCast` returns NULL for it. A member that coerces to NULL sets
`hasNull`; a condition that coerces to NULL returns NULL, and in the set-probe arm that
return happens **before** the set is built, preserving the "a NULL probe does not force
the build" short-circuit.

**Site B — IN decorrelation (`extractInCorrelation`).** A *correlated* `col in (subquery)`
is rewritten into a semi join (WHERE position) or an existence-flag LEFT join (SELECT-list
position), and the rule synthesizes the membership `=` by constructing a `BinaryOpNode`
directly — bypassing the coercion a hand-written `=` gets. It now reconciles the two
operands through `coerceObjectPhysicalSet` first. That helper, not
`insertCrossTypeCoercion`: the latter also applies its numeric-vs-textual arm, which would
make a correlated `int_col in (select text_col …)` start matching while the uncorrelated
form kept missing.

**Shared helper.** `lenientCast(value, type)` in `types/cast-semantics.ts` is the one
definition of "convert the way `CAST` does" (`parse`, falling back to `castFallback`).
`emitCast` is now a caller and lost its inline duplicate.

## Plan shapes, as rendered

| Query | Plan |
| --- | --- |
| `v in (select s from t)` (uncorrelated, mixed JSON/TEXT) | `IN \| v IN (subquery)` — set probe. `extractUncorrelatedIn` declines: `semanticOrderingsAgree` refuses a JSON/TEXT pair. |
| `s in (select v from j)` (reverse) | set probe, same reason |
| `j.v in (select t.s … where t.id = j.id)` (correlated, WHERE) | `SEMI MERGE JOIN on [id=id]`, `j.v = cast(s as json)` demoted to the residual |
| same, SELECT-list position | `LEFT JOIN` + `__exists_N` flag, condition `j.v = cast(s as json) AND t.id = j.id` |
| `j.v in (select k.v from j2 k)` (both JSON) | `SEMI HASH JOIN` — semantic orderings agree, so this one still decorrelates; `emitIn` untouched |

## Validation

- `yarn test` — full monorepo green (quereus 8072 passing, 13 pending; every other package
  passing). No pre-existing failures surfaced.
- `node test-runner.mjs --store --grep "06.9"` — all 5 JSON logic files passing under
  LevelDB. None carries `using memory`, so store mode exercises the persisted byte-key path.
- `yarn lint` clean, `yarn build` clean, `yarn typecheck` clean.
- Full `yarn test:store` suite **not** run (wall-clock); the 06.9.x subset stands in.

## Review findings

Reviewed the implement diff before the handoff summary. Axes covered: correctness of all
five `emitIn` arms, reachability of the new arm across every `InNode` construction site,
`lenientCast` behavior per operand storage class, decorrelation in both operand
directions, downstream plan traversal over the new `CastNode`, docs, DRY, comment density,
error handling, resource cleanup, lint/build/typecheck/tests in both storage modes.

### Fixed in this pass (minor)

- **`runDynamicValues` was not actually threaded.** The handoff claimed all five arms
  were; the dynamic value-list arm still used `memberKey(condition)` for the *probe* and
  never treated a member coercing to NULL as `hasNull`. Under arm 1 that re-parses the
  JSON side — precisely the collision the asymmetry exists to prevent — and returns FALSE
  where the answer is UNKNOWN. Dormant today (see below), wrong the moment it isn't.
  Fixed to `probeKey` + post-transform null checks, matching the other four arms.
- **`docs/optimizer-rules.md`** described `extractInCorrelation`'s three inner-shape gates
  but not the new coercion. Added: both decorrelation arms synthesize a raw
  `BinaryOpNode`, why only the correlated one needs `coerceObjectPhysicalSet`, why only
  its object-physical arm, that the resulting `CastNode` demotes the conjunct into the
  join residual, and why `extractUncorrelatedIn` needs no coercion.
- **`docs/runtime-caching.md`** § IN-subquery set probe listed `condition NULL → NULL
  (without forcing the build)` as the only short-circuit; now also names the
  coerce-to-NULL case and why the key is computed before the build.
- **Coverage — three of the handoff's four declared gaps closed:**
  - correlated **reverse** direction (TEXT outer, JSON inner). This is the probe-side
    branch of `coerceObjectPhysicalSet` inside the decorrelation, which the forward case
    never reaches; it was untested.
  - `not in` over a NULL-free inner. Both existing `not in` cases landed on UNKNOWN, so
    neither pinned the FALSE-becomes-TRUE direction of the negation.
  - the **impure arm** (`IN(impure)`, DML-with-RETURNING inner) with a JSON probe, plus a
    sink `count(*)` confirming the full drain still runs past the match. Verified
    non-vacuous: without arm 1 the probe is an object against text members and `found`
    would be false.

### Found, deliberately not acted on

- **The "two spellings are ONE member" weak pin** the handoff flagged as needing a unit
  test: the underlying property is already covered. `06.9-json-canonical-key.sqllogic`
  pins reorder-equal JSON objects collapsing to a single GROUP BY / DISTINCT bucket, which
  is the same canonical-text OBJECT equality the BTree's no-op duplicate insert rests on.
  No new test, no ticket.
- **The handoff asked for confirmation that § 5.2's last two cases really decline
  decorrelation.** Confirmed from code rather than inferred from results:
  `extractUncorrelatedIn` returns null when the IN condition is not a bare
  `ColumnReferenceNode` (`n + 0`), and the uncorrelated arm is filter-position only, so a
  projection-position IN never reaches it. The existing comments are accurate; a
  plan-shape spec would add nothing.
- **Arm 1 genuinely cannot reach the dynamic value-list arm**, so the fix above is
  defensive rather than a live bug. Traced every `InNode` construction site: the two in
  `planner/building/expression.ts` (value list goes through `coerceObjectPhysicalSet`,
  subquery has no values), `analysis/predicate-normalizer.ts` (OR-to-IN collapse, whose
  shape gate demands `PlanNodeType.Literal` on one side — a surviving `CastNode` from the
  disjuncts' own build-time coercion is rejected, and a folded literal carries the object
  type), and `nodes/subquery.ts`'s `withChildren`. Only the constant arm is reachable with
  a non-object member type, and it was already correct.
- **New import edge** `planner/rules/subquery/` → `planner/building/coercion.js`, which
  the handoff flagged for an opinion: **accept it.** `coercion.ts` holds pure type
  reconciliation with no build-phase state, its own dependencies are `parser/ast` +
  `planner/scopes` + `planner/nodes` + `types/`, and the alternative — duplicating the
  object-physical arm inside the rule — is strictly worse. If a second rule ever imports
  it, move the module to `planner/analysis/` then rather than now.
- **DRY:** `physicalType === PhysicalType.OBJECT` is now spelled inline at four sites
  (`coercion.ts` ×2, `analysis/set-op-type-merge.ts`, and `subquery.ts`'s new
  `isObjectPhysical`). A shared predicate on `types/logical-type.ts` would be tidier, but
  two of the four are outside this ticket's diff; not worth churning unrelated files for
  a one-line expression.
- **Comment density on `inMembershipKeys`:** a 45-line doc over a 28-line body is heavy,
  but it matches the surrounding `coercion.ts` / `json-type.ts` style and every paragraph
  earns its place — the asymmetry rationale *is* the bug. Left as-is.
- **`lenientCast` swallows the type's parse `TypeError` without logging**, against
  AGENTS.md's "don't eat exceptions silently". Deliberate and pre-existing (moved verbatim
  out of `emitCast`): the throw is how a `LogicalType` signals rejection, CAST leniency is
  defined semantics rather than an error path, and logging it would fire per row.
- **`lenientCast` is safe against a member whose declared type is not JSON but whose
  runtime value already is an object** — `JSON_TYPE.parse` passes objects through
  unchanged, so only strings are ever re-read. Checked because that is the one way the
  asymmetry could be defeated through a mis-declared subquery column type.
- The handoff's own note that the impure arm applies `memberKey` to every drained row even
  when the answer is already NULL: correct, harmless (the drain is mandatory for side
  effects), left for clarity.

### Escalated to new tickets

None. Nothing found needed more than an inline fix.

### Tripwires parked

- `lenientCast`'s fallback costs one **thrown** exception per call, and both callers run
  per row — so a scan whose operands mostly fail to parse (`json_col in (select free_text
  from big_table)`) pays V8 exception construction on every row. Fine at current scale.
  `NOTE:` on `lenientCast` in `types/cast-semantics.ts`, with the remedy (an optional
  non-throwing `tryParse` hook on `LogicalType`).
- Two pre-existing pointers preserved rather than acted on: the numeric-vs-textual IN/CASE
  gap (`bug-numeric-text-coercion-skips-in-and-case`, referenced from both `coercion.ts`
  and the `inMembershipKeys` doc comment) and the set-probe "no size cap" NOTE in `emitIn`.

### Pre-existing failures

None. `yarn test` was fully green, and no test outside this diff's subsystems misbehaved.
