---
description: Searching a column that holds JSON documents with `=` now finds matching documents regardless of spacing or key order, and no longer crashes when that column is indexed.
files:
  - packages/quereus/src/planner/building/expression.ts               # insertCrossTypeCoercion (object-physical arm) + coerceInListOperands
  - packages/quereus/src/planner/nodes/scalar.ts                      # LiteralNode.getType — JSON backstop for object values
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # literalFromValue / columnScalarType / equalitySeekKey — typed seek keys
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts # synthesizeEquality types its literal from attr.type
  - packages/quereus/src/util/comparison.ts                           # NOTE added: the two JSON orderings disagree for ranges
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # NEW — main coverage
  - packages/quereus/test/json-parameter-equality.spec.ts             # NEW — bound-parameter forms
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic # 9b/9c re-pinned to correct behavior
  - packages/quereus/test/plan/basic/multi-filter-keyed.plan.json     # golden updated (seek literal now INTEGER, was REAL)
  - docs/types.md                                                     # JSON comparison-against-text + ordering caveat
difficulty: medium
---

# `=` against a JSON column is now structural, and indexed JSON columns no longer crash

## What was wrong

Two defects, both reproduced before touching anything:

- **A.** Every comparison of a JSON column against SQL text was unconditionally false —
  even byte-identical text. JSON values live in memory as native JS objects; a text
  operand is a string; `compareSqlValuesFast` short-circuits on the storage-class
  mismatch, so nothing ever canonicalized and nothing ever compared. Only an operand
  already JSON-typed at plan time (`json('…')`, `cast('…' as json)`) worked.
- **B.** With an index on the JSON column, those two working forms became a hard planner
  error: `QuereusError: Unknown literal type object`. The access-path rule rebuilds a seek
  key as a fresh `LiteralNode` from the constraint's plain value, with no type attached;
  `LiteralNode.getType()`'s inference ladder had no arm for a native object and fell off
  the end into a `quereusError`.

B blocked A, because fixing A means synthesizing exactly the object-valued literal that
tripped B.

## What was built

**Phase 1 — object-valued literals stop crashing the planner.**

- `LiteralNode.getType()` (`planner/nodes/scalar.ts`) gained an arm before the
  `quereusError`: a non-null, non-`Uint8Array` object types as `JSON_TYPE`. JSON is the
  engine's only `PhysicalType.OBJECT` type, so this is exact rather than a guess. The
  `quereusError` stays for everything genuinely unknown (functions, symbols) — a widening,
  not a removal. This one change fixes the crash at *every* site that rebuilds a literal.
- Belt-and-braces on top: `rule-select-access-path.ts` now threads the constrained
  column's `ScalarType` into the rebuilt seek-key literal, via a new
  `columnScalarType(tableRef, colIdx)` helper wired through `literalFromValue` and
  `equalitySeekKey`. Applied at every seek-key construction site (equality, multi-value
  IN, composite cross-product, prefix-range, range, OR_RANGE, legacy PK). Mirrors what
  `rule-sargable-range-rewrite.ts:120` already does. A NULL value deliberately keeps the
  inferred `NULL_TYPE` — the column's type would claim `nullable: false` for a null.
- `rule-predicate-inference-equivalence.ts`'s `synthesizeEquality` types its literal from
  `attr.type` the same way, with the same NULL carve-out.

**Phase 2 — coerce a text operand against a JSON operand.**

- `insertCrossTypeCoercion` (`planner/building/expression.ts`) gained an
  object-physical ↔ non-object arm, ordered *before* the existing numeric ↔ textual arm
  and returning early so that arm is untouched. The non-object side is wrapped in
  `cast(… as <json type name>)`. Direction is always text → JSON, never the reverse:
  casting the JSON side to text would make equality spelling-sensitive and put `=` back
  out of step with the index.
- The gate is `physicalType === PhysicalType.OBJECT`, **not** `semanticOrdering` —
  deliberately leaving DATE/TIME/DATETIME/TIMESPAN alone (physically text, already served
  by the runtime's `tryTemporalComparison`).
- A NULL-typed operand is skipped: the comparison is UNKNOWN regardless, so the cast would
  only add a runtime hop.
- `BETWEEN` needed no change — it already routes both bounds through the helper.
- The IN-value-list arm now calls a new `coerceInListOperands`, which applies **only** the
  object-physical pairing. The tested expression is shared across values, so it is wrapped
  at most once (if any listed value is object-physical and it is not).

`JSON_TYPE` did **not** get a `groupKey`. The ticket's original diagnosis blamed the
missing `groupKey`; that was wrong. The gate on `=` is operand-type identity in
`emitComparisonOp`, which a `groupKey` does not affect. GROUP BY / DISTINCT / IN identity /
hash joins were already structural for JSON and are unchanged (pinned by a section in the
new test file).

## Use cases to exercise when reviewing

All of the following were verified end-to-end against a live `Database`, and all are
covered by the two new test files. The most valuable review time is spent trying to break
the *edges*, not re-running the happy path.

Core contract — `create table j (id integer primary key, v json)` holding `{"a":1,"b":2}`:

| Query | Result |
| --- | --- |
| `where v = '{"a":1,"b":2}'` (byte-identical) | matches |
| `where v = '{ "a" : 1 , "b" : 2 }'` (respaced) | matches |
| `where v = '{"b":2,"a":1}'` (key-reordered) | matches |
| `where '{"b":2,"a":1}' = v` (text on the left) | matches |
| `where v = '[3,2,1]'` against a stored `[1,2,3]` | no rows (array order significant) |
| `where v in ('{ "b" : 2 , "a" : 1 }')` | matches |
| `where v between '{"a":0}' and '{"a":2}'` | matches |
| `where v = ?` bound to text, to a named param, or to a native JS object | matches |
| `where v = 'not json'` | **no rows, not an error** |
| `where v = null` | no rows (UNKNOWN) |
| `select v from j where v = '…'` | returns the native document, not the literal's text |

Repeat every row of that table with `create unique index j_v on j (v)` in place — that is
the combination that used to throw. The plan for the indexed case is
`BLOCK > PROJECT > INDEXSEEK > …`, i.e. the synthetic cast const-folds to an object-valued
literal that reaches the seek as a real seek key; it does not degrade to a scan.

Also worth driving by hand:

- A `text` column retyped with `alter table … alter column v set data type json`, indexed
  and not — must answer identically to a natively-declared `json` column.
- `insert` of a respaced duplicate into a table with a unique index on the JSON column —
  still `UNIQUE constraint failed`, and `=` now agrees with the index about what a
  duplicate is.
- Both memory and store modules. The new `.sqllogic` file omits `using memory` on purpose,
  so `yarn test:store` exercises the persisted `jsonStructuralKey` path for the indexed
  cases.

## Behavior changes a reviewer should agree with (not bugs)

- **`text_col = json_col` is now structurally true** where it was always false. This is the
  intended reading of "one side is JSON", but it is a real change and is covered explicitly
  by section 7 of the new test file so the choice is visible rather than incidental.
- **A JSON string scalar matches the bare text form.** A column holding `"hello"` matches
  both `'"hello"'` (parses to the JSON string) *and* `'hello'` (not valid JSON → the
  lenient cast returns the raw string → `JSON_TYPE.compare` compares two string scalars as
  text). The ticket predicted the bare form would *not* match; the lenient-cast fallback
  makes it match. Pinned deliberately in section 3 and documented at the coercion site and
  in `docs/types.md`. **If the reviewer prefers the stricter reading, this is the decision
  to revisit** — it is the one place where behavior was chosen rather than derived.
- **A seek-key literal now reports the column's type.** `multi-filter-keyed.plan.json`
  changed one line: the literal `3` seeking an `integer primary key` now types as INTEGER
  where it previously inferred REAL from the JS number. More accurate, but it is the only
  golden-plan movement and is worth a second opinion.

## Known gaps and things I could not close

- **Pre-existing defect found while probing, filed not fixed:**
  `tickets/fix/bug-json-index-range-seek-order`. JSON range queries (`<`, `>`, `BETWEEN`)
  return a *different row set* depending on whether the index is used, because `<`/`>`
  evaluate under `deepCompareJson` (type-rank order) while a memory-module index range seek
  walks canonical-JSON-text byte order. Confirmed pre-existing and independent of this
  change by reproducing it with `json(...)` operands on both sides, which never touch the
  new coercion. Equality is unaffected — the two orders agree there — which is why this
  ticket's actual subject is sound. Reproduced in the memory module; the store module
  returned the correct answer for the same probe, and *why* is not established. This
  change does make the defect far easier to reach (a plain text literal now gets there,
  where before it was unconditionally false), so it is worth prioritizing.
  A pointer NOTE sits at `util/comparison.ts` (~line 231), where the old comment claimed
  only one of the two orders was load-bearing.
- **The indexed `BETWEEN` case in section 6 of the new test file is not coverage for that
  defect** — its table happens to hold only documents whose two orderings agree. A comment
  in the file says so, to stop a future reader from mistaking it for a guard.
- **`where int_col in ('1')` is still broken** — the IN-list arm has never applied the
  numeric ↔ textual coercion, and `coerceInListOperands` is scoped to the object-physical
  pairing on purpose per the ticket's "out of scope" instruction. Verified still `[]`
  after this change (unchanged, not newly broken). Not filed as a ticket here — the ticket
  said to file it *if* the work turned it up as a regression, and it did not regress.
  Reviewer's call whether it deserves its own ticket now.
- **`sat-checker.ts` / `coarsened-key.ts` were reasoned about, not stress-tested.**
  `sat-checker` unwraps only *no-op* casts (`isNoOpCast`), so a converting cast to JSON
  stays opaque to it and it declines to claim anything — conservative, therefore safe. Its
  semantic-type map is built from `ColumnReferenceNode`s, not literals, so the typed seek
  keys do not perturb it. I did not construct adversarial predicates to try to force a
  bogus `≤1 row` witness or a false unsatisfiability verdict; that is the sharpest place to
  point an adversarial reviewer.
- **Two object-physical types on opposite sides** (JSON vs a hypothetical future custom
  OBJECT type) fall through both arms and land on the generic runtime path. Not reachable
  today — JSON is the only such type — and not handled.

## Validation actually run

- `yarn test` — **7233 passing, 0 failing** (plus the other workspaces' suites, all green).
- `yarn test:store` — **7225 passing, 0 failing**.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- New: `06.9.2-json-structural-equality.sqllogic` (9 sections, memory + store) and
  `json-parameter-equality.spec.ts` (22 cases: the full parameter contract run twice, once
  without an index and once with a unique index).
- `41.7.4` sections 9b/9c re-pinned from `[]` to `[{"id":1}]`, and the explanatory NOTE at
  lines 371-375 deleted — it documented the old, wrong diagnosis.

Treat the tests as a floor. The parameter spec and the `.sqllogic` file between them cover
the shapes I could think of; the coercion sits on a hot path (every comparison operator,
every BETWEEN bound, every IN list in the codebase now runs one extra `physicalType` check
per operand at build time), so a reviewer looking for damage should look for comparisons
whose operand types I did not anticipate rather than for more JSON cases.
