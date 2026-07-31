---
description: The planner used to record "these two columns always hold the same text" when a query compared a duration column against a plain text column, which is not true — one hour can be spelled several ways. That false note is no longer recorded. Review the change.
files:
  - packages/quereus/src/planner/util/fd-utils.ts                     # the gate + the two rewritten doc comments
  - packages/quereus/src/planner/nodes/plan-node.ts                   # ConstantBinding — the "compares equal to" contract
  - packages/quereus/test/planner/collation-soundness.spec.ts         # new unit block + new plan-level block
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic       # new end-to-end section
  - docs/types.md                                                     # § "Semantic ordering"
  - docs/optimizer-fd.md                                              # § retitled + new subsection
  - docs/invariants.md                                                # OPT-051
  - docs/optimizer-rule-families.md                                   # one link repointed at the retitled section
difficulty: medium
---

# Review: semantic-ordering gate on filter-level cross-column equality facts

## What the change is

A few column types compare by *meaning* rather than by the text stored in them: a
`timespan` holding `'PT1H'` equals `'PT60M'`, a `json` holding `'{"a":1}'` equals
`'{ "a" : 1 }'`. When the planner reads a `where` clause it records shortcut facts about
the surviving rows. For `where col1 = col2` it recorded mirror functional dependencies
plus an *equivalence class* — "these two columns always hold the same value". That claim
is false when one side compares by meaning and the other by text: two rows can agree on
the duration column (both one hour) while disagreeing on the text column (`'PT1H'` and
`'PT60M'` are distinct strings).

One line of behavior changed. In `extractEqualityFds`
(`packages/quereus/src/planner/util/fd-utils.ts`), the `col1 = col2` branch now also
requires `semanticOrderingsAgree(left.getType().logicalType, right.getType().logicalType)`
— the same predicate the two join-side extractors already used. Everything else in this
ticket is comments, tests, and docs.

New invariant **OPT-051** in `docs/invariants.md`. The three extractors that mint a
cross-column pairing fact are now identical in this respect:

| site | function |
|---|---|
| `planner/util/fd-utils.ts` | `extractEqualityFds` — **changed here** |
| `planner/nodes/join-node.ts` | `extractEquiPairsFromCondition` — already gated |
| `planner/rules/join/equi-pair-extractor.ts` | `extractEquiPairs` — already gated |

## Two things deliberately left ungated — please do not read these as oversights

Both were settled in the plan stage, and both are now stated in code comments so a future
reader does not "fix" them for symmetry.

**Constant pins stay ungated.** `where d = 'PT60M'` keeps every row whose `d` is one hour,
whatever text it stores. Under the engine's identity for a `timespan` column — the same
identity `distinct` / `group by` / `unique` already use — those rows all hold *the same
value*, so the FD `∅ → d` is true. The `ConstantBinding` is true as well, once you read
its claim correctly, which is why this ticket writes that claim down on the type's
declaration in `planner/nodes/plan-node.ts`: **the bound value is one the column compares
equal to under its own comparison, not necessarily its raw stored representation.** A
consumer needing raw-value identity must not read a binding; both current consumers
(`rule-predicate-inference-equivalence`, which re-types the synthesized literal from the
*target* attribute, and `deriveFilterAttributeDefaults`, which only needs a value that
satisfies the view predicate) need only the "compares equal to" reading. Gating this arm
would decline **every** pin on a `timespan`/`json` column, since a literal never declares
a semantic-ordering type.

**`buildPredicateFacts`' `columnEqs` stays ungated.** It only ever discharges an
`eq-column` guard clause, which is the same comparison re-evaluated under the same
declared types at index-maintenance time — filter-rows and guard-scope-rows coincide
either way. A `NOTE:` at the site says so.

## Known gap the reviewer should weigh

**The guard-discharge route was closed as a side effect and is not separately tested.**
`clauseEntailed` (same file) discharges an `eq-literal` guard clause by looking for any
equivalence-class peer pinned to that literal. With a false `{d, s}` class, an
`s = 'PT1H'` guard on a partial UNIQUE index would have discharged from `d = 'PT1H'`,
activating a `kind: 'unique'` FD that does not hold. Removing the class removes that route
— but no test drives a partial-UNIQUE guard over a mixed `timespan`/`text` pair. The full
suite is green, so nothing *depended* on the old behavior, and the plan-level test below
pins that the class is gone; what is missing is a positive test that the bogus uniqueness
FD can no longer be activated. Worth deciding whether that deserves its own case.

## How to validate

```
yarn workspace @quereus/quereus run test     # 8267 passing, 13 pending, 0 failing
yarn workspace @quereus/quereus run lint     # clean
yarn docs:check                              # see "Pre-existing" below
```

### Unit — `packages/quereus/test/planner/collation-soundness.spec.ts`

New `describe('semantic-ordering gate')`, nested inside the existing
`extractEqualityFds collation gate (unit)` block so it reuses its node-construction
helpers. The `colRef` helper grew an optional `logicalType` (existing call sites are
unchanged — it still defaults to `TEXT_TYPE` / `INTEGER_TYPE`).

Declined (zero FDs, zero equivalence pairs, zero bindings): `timespan = text` and
`text = timespan`; `json = text` and `text = json`; `timespan = json`; `any = timespan`.
Still admitted with 2 mirror FDs + 1 equivalence pair — the over-declining controls:
`timespan = timespan`, `json = json`, `any = text`. Arm-2 controls, all still extracting
1 FD + 1 binding: `timespan = 'PT60M'`, `json = '{"a":1}'`, `timespan = ?`, and a
cast-wrapped literal (`timespan = cast('PT60M' as timespan)`, which peels through
`constantValueOf`). Two interaction cases: a cast-wrapped *column* reaches neither arm
(unchanged), and a `timespan collate nocase = timespan` pair is still rejected — the
collation gate fires first and adding the second gate did not reorder them.

### Plan level — same file, `semantic-ordering gate on filter equality facts (plan level)`

Reads the `physical` column of `query_plan()` and inspects every `FILTER` row. Over
`create table tso_mixed (id integer primary key, d timespan, s text)`, the query
`select id from tso_mixed where d = s and d = 'PT1H'` must carry no `equivClasses` entry
containing both column 1 (`d`) and column 2 (`s`), and no `constantBindings` entry whose
`attrs` spans both. Control: the same query with `s` re-declared `timespan` must carry
**both**.

**This pair was verified to actually discriminate.** With the gate temporarily
short-circuited, the mixed test fails with `false {d,s} equivalence class: expected true
to equal false` — i.e. at HEAD the Filter really did report `equivClasses: [[1,2]]` and a
binding claiming the text column holds `'PT1H'`. With the gate restored both pass. The
same-type control passing is what keeps the mixed assertion non-vacuous (it proves
`FILTER` rows with populated `equivClasses` do reach the assertion).

### End-to-end — `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`

New section after the `Mixed-type equi-join keys agree with =` block, covering the
filter-only spellings the join gate never saw: a nested sub-select and a CTE, each pairing
an inner `where d = s` with an outer `where d = 'PT1H'`, plus the text-side pin asymmetry
(`where s = 'PT1H'` correctly finds nothing; `where s = 'PT60M'` finds the row). Then a
same-type control table (`d timespan, e timespan`) whose rows must come back **carrying
their own stored spellings** (`{"d":"PT1H","e":"PT60M"}`) — a canonicalizing "fix" would
have rewritten those.

These pass at HEAD as well as after. They exist because the dormant path is only dormant
by accident: `rule-predicate-inference-equivalence` reads equivalence classes off the
Filter's **source**, and adjacent filters merge into a single Filter before that rule
runs. One filter-merge change, or CTE references starting to carry physical properties,
would have re-opened it.

## Pre-existing, not from this ticket

`yarn docs:check` fails on three word-count ratchets in `docs/module-authoring.md`,
`docs/schema.md`, and `docs/sync.md` — none of which this ticket touches (`git status`
confirms they are unmodified). The link/anchor half passes clean, including the two new
anchors. Recorded in `tickets/.pre-existing-error.md`.

## Doc changes worth a second read

- `docs/optimizer-fd.md`: § "Collation gate on equality facts" was **retitled** to
  "Soundness gates on equality facts" and gained a subsection "Semantic-ordering gate on
  cross-column facts" (the OPT-051 anchor target). Retitling moved the anchor, so the two
  inbound links — `docs/invariants.md` OPT-050 and `docs/optimizer-rule-families.md` —
  were repointed. `docs:check` verifies these; both resolve.
- `docs/types.md` § "Semantic ordering": "Two surfaces still do **not** follow the rule"
  is now one (AS OF), and the filter-facts paragraph states the resolved asymmetry.
- `docs/invariants.md`: OPT-051 added next to OPT-050.
