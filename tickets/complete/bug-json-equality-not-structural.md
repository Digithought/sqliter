---
description: Searching a column that holds JSON documents with `=` now finds matching documents regardless of spacing or key order, works in `case` and `in` too, and no longer crashes when that column is indexed.
files:
  - packages/quereus/src/planner/building/expression.ts               # insertCrossTypeCoercion + coerceObjectPhysicalSet (IN list and simple CASE)
  - packages/quereus/src/planner/nodes/scalar.ts                      # LiteralNode.getType — JSON backstop for object values
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts   # object literals fingerprint by canonical JSON (review fix)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # typed seek keys
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts
  - packages/quereus/src/util/comparison.ts                           # NOTE: the two JSON orderings disagree for ranges
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic
  - packages/quereus/test/json-parameter-equality.spec.ts
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts
  - docs/types.md
---

# `=` against a JSON column is structural, and indexed JSON columns no longer crash

## What shipped

JSON documents live in memory as native JavaScript objects; SQL text is a string, and the
engine never treats those two as equal. Two defects followed from that:

- Every comparison of a JSON column against SQL text was false, even for byte-identical
  text. Only an operand already JSON-typed at plan time (`json('…')`, `cast('…' as json)`)
  worked.
- With an index on the JSON column, those two working forms raised
  `QuereusError: Unknown literal type object` at plan time, because the access-path rule
  rebuilds a seek key as an untyped literal and type inference had no arm for an object.

The implementation fixed both:

- **Object-valued literals stop crashing the planner.** `LiteralNode.getType()` types a
  non-null, non-`Uint8Array` object as `JSON_TYPE` — exact, since JSON is the only
  `PhysicalType.OBJECT` logical type. Belt-and-braces on top, the access-path rule and
  `rule-predicate-inference-equivalence` now thread the constrained column's `ScalarType`
  into every rebuilt seek-key literal (NULL values deliberately keep `NULL_TYPE`).
- **A text operand is converted to JSON at plan time.** `insertCrossTypeCoercion` gained an
  object-physical ↔ non-object arm, ordered before the numeric ↔ textual arm. The
  non-object side is wrapped in `cast(… as json)`, never the reverse — casting the JSON
  side to text would make equality spelling-sensitive and put `=` out of step with the
  index. The gate is `physicalType === OBJECT`, not `semanticOrdering`, so the temporal
  types keep their existing runtime path. The cast is lenient, so `json_col = 'not json'`
  is false rather than an error.

The review pass added two more pieces (details under *Review findings*): a simple `case`
now reconciles its base operand the same way an `IN` list does, and object-valued literals
are fingerprinted by their canonical JSON instead of collapsing onto `[object Object]`.

## Behavior changes agreed during review, not bugs

- `text_col = json_col` is now structurally true where it was always false. Pinned by
  section 7 of `06.9.2-json-structural-equality.sqllogic`.
- A JSON string scalar matches the bare text form: a column holding `"hello"` matches both
  `'"hello"'` and `'hello'`, because the lenient cast returns the unparseable text
  unchanged and two string scalars then compare as text. Reviewed and kept — it is the
  natural consequence of lenient casting, and the stricter reading would make
  `json_col = 'not json'` an error instead of false.
- A seek-key literal now reports the column's declared type rather than one inferred from
  the raw JavaScript value (`multi-filter-keyed.plan.json`: the literal `3` seeking an
  `integer primary key` types as INTEGER, was REAL). Reviewed as more accurate; probed
  against collated TEXT keys, DATETIME keys, and fractional bounds on an INTEGER key with
  no behavior change.

## Review findings

### Fixed in this pass

- **Wrong rows: scalar CSE folded two different JSON comparisons into one.**
  `select id from j where v = '{"a":1}' and v = '{"a":2}'` returned row 1, and
  `… where v = '{"a":1}' or v = '{"a":2}'` returned only row 1 — on both indexed and
  unindexed tables. Root cause: `fingerprintLiteral` (`planner/analysis/expression-fingerprint.ts`)
  ended in `String(value)`, which renders *every* object as `[object Object]`, so
  `ruleScalarCSE` treated the two comparisons as one expression and evaluated only the
  first. Pre-existing — the `json(...)` operand form reached it before this ticket, and
  `06.9-json-canonical-key.sqllogic` records the same class of bug being fixed once before
  for hash keys, with this site missed — but the coercion made it reachable from any plain
  text literal, which is why it is fixed here rather than deferred. Object literals now
  fingerprint as canonical JSON (the same key derivation the comparator and index agree
  on), with a logged per-node fallback for a non-serializable object. Covered by four unit
  tests in `test/optimizer/expression-fingerprint.spec.ts` and section 9 of the
  `.sqllogic` file.
- **Inconsistent surface: a simple `case` did not coerce its base.**
  `case v when '{"a":1}' then …` returned the else branch while `where v = '{"a":1}'`
  matched. A simple CASE is the same one-probe-against-many-values shape as an IN list, so
  the IN helper was generalized (`coerceInListOperands` → `coerceObjectPhysicalSet`) and
  applied to both. Covered by section 10 of the `.sqllogic` file.
- **Docs.** `docs/types.md` now lists the simple-`case` coercion site, names the one
  surface that is still not covered, and records that canonical JSON also backs expression
  fingerprinting.
- **Stale ticket.** `tickets/backlog/bug-json-column-not-matchable-in-where.md` claimed no
  spelling of a JSON where-clause works. Two of its three repros now pass; a status note
  says so and points the survivor at its real duplicate rather than leaving a triager to
  rediscover it.

### Filed as new tickets

- `tickets/backlog/bug-json-in-subquery-not-structural.md` — `json_col in (select text_col …)`
  is still always false. Every other comparison surface is fixed by a plan-time operand
  wrap; the subquery form has no fixed operand, so it needs per-row conversion inside
  membership evaluation. A genuine gap in the contract, not a regression.
- `tickets/backlog/bug-datetime-literal-with-timezone-never-matches.md` — found while
  probing comparison behavior, unrelated to this diff: a `datetime` written as
  `'2020-01-01T00:00:00Z'` stores as `'2020-01-01T00:00:00'` and can never be found again
  using the text it was written with. Reproduces identically indexed and unindexed, so no
  plan-time coercion is involved.

### Tripwires recorded (not tickets)

- `planner/analysis/expression-fingerprint.ts` — `NOTE:` at the new arm: the fingerprint
  inlines the whole canonical document, so it grows with the literal. Fine for hand-written
  and small folded constants; hash it if large JSON constants become common.
- `planner/building/expression.ts` — `NOTE:` in `insertCrossTypeCoercion`: two
  object-physical operands of *different* logical types fall through both arms onto the
  generic runtime path. Unreachable while JSON is the only `PhysicalType.OBJECT` type;
  adding a second one forces a which-side-converts decision.
- `util/comparison.ts` — the implementer's `NOTE:` about the two JSON orderings disagreeing
  for ranges stands, backed by `tickets/fix/bug-json-index-range-seek-order`.

### Checked, nothing found

- **The implementer's flagged gap — `sat-checker` / covered-key reasoning under
  object-valued literals.** Probed contradictory (`v = A and v = B`), redundant
  (`v = A and v = <A respaced>`), and disjunctive (`v = A or v = B`) JSON equality
  predicates against indexed and unindexed tables. All correct after the fingerprint fix:
  the contradiction collapses to `EMPTYRELATION`, the redundant pair still seeks, the
  disjunction returns both rows. Reorder-equal literals are correctly treated as one value
  and structurally distinct ones never are.
- **Seek-key typing regressions.** Drove typed seek keys on a `text collate nocase`
  primary key, a `datetime` primary key, a `json` primary key, and fractional range bounds
  against an `integer` key. No behavior change; the single golden-plan movement is the only
  one in the corpus.
- **Operand types the coercion was not designed for.** `json_col = <blob literal>` (the
  cast falls back to the value unchanged, comparison stays false), `any_col = json_col`
  (converts, consistent with the stated rule), `json_col = null` (UNKNOWN, no cast
  inserted), JSON boolean/number scalars, and `json_col` in `update` / `delete` predicates
  and `check` constraints — all correct.
- **No regression on the deliberately-untouched case.** `int_col in ('1')` is still `[]`,
  exactly as before; `coerceObjectPhysicalSet` remains scoped to the object-physical
  pairing.
- **`json_quote(j) = '<text>'` is still false.** Verified unchanged by this diff; it is the
  separately-filed `bug-json-typed-comparison-reparses-text-literal`.
- **Source hygiene.** No file grew past its subsystem's norms, no dead code, no `any`, no
  swallowed exceptions (the one new `catch` logs). The doc comment on
  `insertCrossTypeCoercion` is long relative to the function, but it records *why* each arm
  is ordered and gated as it is — judged worth keeping rather than trimming.

## Validation

- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — **7237 passing, 0 failing** (all workspaces green).
- `yarn test:store` — **7229 passing, 0 failing**.
- New coverage this pass: sections 9 and 10 of
  `test/logic/06.9.2-json-structural-equality.sqllogic` (CSE distinctness across AND / OR /
  projection, plus simple `case`), and an `object (JSON) literals` block in
  `test/optimizer/expression-fingerprint.spec.ts` (distinct documents, reorder-equal
  documents, object-vs-string collision, non-serializable fallback).
