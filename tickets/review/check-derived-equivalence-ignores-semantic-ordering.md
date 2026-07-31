---
description: A table rule saying "these two columns must be equal" no longer makes the query planner assume the two columns hold identical text when one of them is a duration or JSON column, where the same value can be written several ways. Rows that used to silently vanish from query results now come back.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts   # the fix — columnPairSemanticsAgree + 6 gate sites
  - packages/quereus/src/planner/nodes/plan-node.ts             # ConstantBinding comment restored (~line 227)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts   # new § "extractCheckConstraints semantic-ordering gate"
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # new § "CHECK-derived cross-column equality facts" (~line 350)
  - docs/invariants.md                                          # OPT-051
  - docs/optimizer-fd.md                                        # § Semantic-ordering gate on cross-column facts
  - docs/types.md                                               # § Semantic ordering
difficulty: medium
---

# Review: gate CHECK-derived cross-column equality facts on semantic ordering

## What the bug was

Some column types compare by *meaning* rather than by the exact text stored. A `timespan`
column holding `'PT1H'` compares equal to one holding `'PT60M'`; a `json` column holding
`'{"x":1}'` compares equal to `'{ "x" : 1 }'`. Plain `text` columns do not work that way.

When a table declared `check (d = s)` with `d` a meaning-compared type and `s` plain text,
`check-extraction.ts` recorded "columns `d` and `s` always hold the same value" onto the
table reference. False: a row may legitimately store `d = 'PT1H'`, `s = 'PT60M'` — the CHECK
passes because `=` compares them by meaning. `rule-predicate-inference-equivalence` then read
that equivalence class off the Filter's source and rewrote `where d = 'PT1H'` into
`… and s = 'PT1H'`, dropping the row.

The three sibling extractors that mint the same kind of fact already declined mixed pairs
(invariant OPT-051). This adds the same gate to the fourth.

## What changed

One new local helper in `check-extraction.ts`:

```typescript
function columnPairSemanticsAgree(a: number, b: number, columns: ReadonlyArray<DeclaredColumnInfo>): boolean {
	return semanticOrderingsAgree(columns[a]?.logicalType, columns[b]?.logicalType);
}
```

applied at **six** sites — every cross-*column* fact the file mints:

- `handleEquality` col=col branch → mirror FDs + `equivPairs` entry (the arm the reproductions hit).
- `handleEquality`'s two single-column `col = expr` one-way determinations.
- `recognizeGuardedBody` col=col branch → the `valueEquality: true` mirror pair.
- `recognizeGuardedBody`'s two single-column `col = expr` one-way determinations.

**Constant pins stay ungated** (`check (d = 'PT60M')` ⇒ `∅ → d` + a `ConstantBinding`),
unconditional and guarded alike: the claim is only that the column *compares equal to* that
value under its own comparison, which is true. Gating them would decline every pin on a
`timespan`/`json` column, since a literal never declares a semantic-ordering type.
**Guard scopes** (`recognizeNegatedGuard`) stay ungated, unchanged.

The gate is deliberately symmetric on the one-way arms even though the
`{text} → {timespan}` direction is actually sound — over-declining is the safe direction and
one predicate beats two.

## Verification and use cases

**End-to-end (`test/logic/15.1-semantic-ordering.sqllogic`, § "CHECK-derived cross-column
equality facts").** Five cases, all run against a build with the gate short-circuited to
confirm they discriminate:

| case | shape | ungated | gated |
|---|---|---|---|
| R1 | `d timespan, s text, check (d = s)`; row `('PT1H','PT60M')`; `where d = 'PT1H'` | `[]` | `[{"id":1}]` |
| R2 | same with `check (s = d)` — operand order reversed | `[]` | `[{"id":1}]` |
| R3 | `a json, b text, check (a = b)`; `where a = '{"x":1}'` | `[]` | `[{"id":1}]` |
| R4 | same-type control `d timespan, e timespan, check (d = e)` | correct | correct, rows keep their own stored spellings |
| R5 | partial `unique index … where s = 'PT60M'`, two rows sharing `v = 7` | `[{"id":1}]` | both rows |

R4 is the over-declining control and also pins that nothing canonicalizes stored values — it
asserts the returned row still reads `d = 'PT1H', e = 'PT60M'`.

**Extractor level (`test/optimizer/check-derived-fds.spec.ts`, § "extractCheckConstraints
semantic-ordering gate").** Ten cases: mixed `timespan`/`text` declined in both operand
orders; `timespan`/`json` (two *different* semantic types) declined; `json`/`text` declined;
same-type `timespan`/`timespan` still mints both mirror FDs and the EC pair; a constant pin on
a `timespan` column still mints its `∅ → col` FD and binding; one-way `col = trim(other)`
declined mixed / kept same-type in both operand orders; the implication form
`status <> 1 or d = s` declined mixed, and kept for a same-type pair with the `valueEquality`
tag and guard both asserted present. Each of the six negative cases was confirmed to fail with
the gate short-circuited to `true`.

**Validation run.** `yarn workspace @quereus/quereus run lint` clean; `yarn test` from the
repo root — 8277 passing in `packages/quereus`, no failures anywhere in the monorepo;
`yarn docs:check` reports the same three pre-existing word-count ratchet failures as at HEAD
(`docs/module-authoring.md`, `docs/schema.md`, `docs/sync.md`) and nothing new.

## Known gaps — read these before signing off

- **Arm 2 (the implication form) has no query-row test, only an extractor-output test.** As
  the ticket predicted, no plan shape returns a wrong row for a guarded mixed pair:
  `FilterNode.computePhysical` writes the activated equivalence class onto the Filter
  *itself*, while `rule-predicate-inference-equivalence` reads `source.physical.equivClasses`,
  so a single-Filter plan never sees it. Flat, nested sub-select, CTE, `order by` barrier and
  `distinct` barrier shapes were all tried at HEAD and all returned correct rows. The fact
  minted was still false, so it is gated; the assertion is on the extractor's output. **If a
  reviewer finds a shape that surfaces it, that is a real end-to-end case worth adding.**
- **R5 does not isolate the guard-discharge route.** The same false class feeds both
  `rule-predicate-inference-equivalence` (which synthesizes `s = 'PT60M'` and drops row 2 on
  its own) and `clauseEntailed` in `planner/util/fd-utils.ts` (where an equivalence peer
  pinned to a literal discharges the partial index's `where` clause and activates a
  `kind: 'unique'` FD that does not hold). Any shape that discharges the guard also gains the
  inferred conjunct, so the two could not be separated. Both close when the class is no longer
  minted; R5 is a regression net, not proof of the second route.
- **R5 must not carry `order by`.** Adding one changes the plan enough that the query returned
  both rows even ungated — the bare form is the one that discriminates. There is a comment
  saying so at the site; a future tidy-up that "adds a deterministic order by" would silently
  neuter the case.
- **`docs/invariants.md` allows exactly one `guard:` line per invariant** (`check-docs.mjs`
  fails on any other count), so OPT-051 keeps its existing pointer at
  `test/planner/collation-soundness.spec.ts`. The new CHECK-side spec is recorded as a `code:`
  pointer (`columnPairSemanticsAgree`) and named explicitly in `docs/optimizer-fd.md`'s
  extractor list. The ticket asked for it as a guard; the format would not take it. Worth a
  second opinion on whether the guard pointer should instead move to the new spec.
- **No end-to-end test for the hoisted-assertion route.** `assertion-hoist-cache.ts` funnels
  through the same `extractCheckConstraints` entry point with the same column metadata, so it
  is gated by construction and the unit tests cover the function — but nothing asserts an
  `assert (d = s)` over a mixed pair behaves like the declared-CHECK case.
- **`semanticOrderingsAgree` compares logical types by object identity**, matching the three
  existing call sites: two distinct instances of a same-named type over-decline. Safe
  direction, unchanged behaviour, but it is a shared property of all four gates now.
- **Absent `logicalType` counts as non-semantic.** `semanticOrderingsAgree(undefined, TIMESPAN)`
  is `false` (declines), `(undefined, undefined)` is `true` (admits) — which is what keeps the
  pre-existing unit tests, whose `DeclaredColumnInfo` literals carry no `logicalType`, passing
  untouched.
