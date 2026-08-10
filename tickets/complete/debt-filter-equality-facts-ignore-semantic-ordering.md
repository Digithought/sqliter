---
description: The planner used to record "these two columns always hold the same text" when a query compared a duration column against a plain text column, which is not true — one hour can be spelled several ways. That false note is no longer recorded. Reviewed and accepted; a sibling defect of the same kind was found in a neighbouring code path and filed separately.
files:
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/test/planner/collation-soundness.spec.ts
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/types.md
  - docs/optimizer-fd.md
  - docs/invariants.md
  - docs/optimizer-rule-families.md
---

# Semantic-ordering gate on filter-level cross-column equality facts

## What shipped

`extractEqualityFds` (`packages/quereus/src/planner/util/fd-utils.ts`) mints value-level
facts from `where` equality conjuncts. Its `col1 = col2` arm now also requires
`semanticOrderingsAgree` on the two declared logical types — the same predicate the two
join-side extractors already applied.

A column whose type compares by *meaning* rather than by stored text (`timespan`:
`'PT1H'` = `'PT60M'`; `json`: `'{"a":1}'` = `'{ "a" : 1 }'`) shares no notion of "same
value" with a plain `text` column, so `where d = s` over such a mixed pair no longer
contributes mirror functional dependencies or an equivalence class. Same-type pairs are
unaffected.

Two neighbouring arms stay deliberately ungated, each now stating why at its own site:
constant pins (`where d = 'PT60M'`, whose claim is "compares equal to", not "is stored
as"), and `buildPredicateFacts`' `columnEqs` (which only discharges a guard clause
re-evaluated under the same declared types).

New invariant **OPT-051** in `docs/invariants.md`.

## Review findings

### Checked

The implement-stage diff read first, before its handoff summary. Reviewed against: the
three sibling extractors that mint the same fact; every consumer of equivalence classes and
constant bindings (`rule-predicate-inference-equivalence`, `deriveFilterAttributeDefaults`,
`clauseEntailed`, `computeCoveredKeysForConstraints`); over-decline risk on same-type and
`any`-typed pairs; gate ordering against the pre-existing collation gate; the new unit,
plan-level, and end-to-end tests; and every doc section the change touches or should have
touched. `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus
run test` 8267 passing, 13 pending, 0 failing; `yarn docs:check` at the three known
pre-existing word-count ratchets and nothing else.

### Major — one found, filed as `tickets/fix/check-derived-equivalence-ignores-semantic-ordering`

**The invariant this ticket wrote down is not actually held by every site it claims.**
OPT-051 asserted that *every* extractor minting a cross-column pairing fact applies the
gate, and named three. There is a fourth: `planner/analysis/check-extraction.ts` lifts the
same mirror FDs and equivalence class out of a declared `check (d = s)`, ungated. Unlike
the filter-side path — which the handoff correctly described as dormant, because the pin and
the cross-column conjunct merge into one Filter — the CHECK-derived class lands on the
`TableReferenceNode`'s physical properties, where `rule-predicate-inference-equivalence`
reads it directly off the source. It returns wrong rows today:

```sql
create table ck (id integer primary key, d timespan, s text, check (d = s)) using memory;
insert into ck values (1, 'PT1H', 'PT60M');   -- accepted; equal as durations
select id, d, s from ck;                       -- [{"id":1,"d":"PT1H","s":"PT60M"}]
select id from ck where d = 'PT1H';            -- []   ← wrong; row exists and matches
```

Run and observed, not inferred (temporary spec, removed afterwards). The ticket carries the
second arm too — `recognizeGuardedBody`'s `valueEquality` mirror pair, same file, same
falsehood via the implication form — and both resolve at the same site, so it is one ticket
with two arms. `assertion-hoist-cache.ts` routes through the same extraction entry point and
should need no change of its own.

This is not a defect *introduced* here; it is a pre-existing hole the new invariant's wording
would have hidden.

### Minor — fixed in this pass

- `docs/invariants.md` OPT-051, `docs/optimizer-fd.md` § "Semantic-ordering gate on
  cross-column facts", and `docs/types.md` § "Semantic ordering" each stated or implied that
  all minting sites are now gated ("all three extractors", "one surface still does not follow
  the rule"). Corrected to name the CHECK-extraction site as a known hole and point at the
  new ticket. `docs:check` enforces a 120-word cap per invariant body, so OPT-051 was
  tightened rather than extended.
- The `ConstantBinding` declaration comment in `planner/nodes/plan-node.ts` argued that
  `rule-predicate-inference-equivalence` is sound *because* equivalence-class transfers are
  gated at extraction. That is the exact claim the reproduction above falsifies. Reworded to
  a conditional and pointed at the ticket.

### Considered and deliberately not filed

- **The handoff's own flagged gap** — no positive test that the partial-UNIQUE
  guard-discharge route can no longer activate a bogus uniqueness FD. On the filter side that
  route is now closed by construction: the plan-level test asserts no mixed equivalence class
  is produced at all, so a positive test would be asserting the absence of an absence. The
  route is *still* live through the CHECK-derived class, so the test belongs with that fix and
  is listed in the new ticket's coverage section rather than duplicated here.
- **`semanticOrderingsAgree` compares logical types by object identity**, so two distinct
  instances of a same-named type over-decline. Safe direction, already documented in
  `docs/optimizer-fd.md`, and shared by every call site — no action.
- **The gate is now spelled out at three plan-node call sites** rather than factored into a
  shared helper. Not worth extracting: the fourth site works on raw AST plus declared column
  metadata, not plan nodes, so it needs an AST twin the way the collation gate already has one
  (`isValueDiscriminatingEquality` / `isValueDiscriminatingAstComparison`). A single helper
  would not cover it.

### Tripwires

None recorded. Nothing in this diff was of the "fine now, becomes work if X grows" shape —
the one conditional concern considered (identity comparison over-declining) is already stated
in `docs/optimizer-fd.md` at the place a reader meets it.

### Empty categories

- **Test quality**: no gaps found beyond the one folded into the new ticket. The plan-level
  pair was verified by the implementer to actually discriminate (gate short-circuited → mixed
  case fails), and the same-type control keeps the mixed assertion non-vacuous. The
  end-to-end cases pass at HEAD as well as after, which is correct for a regression net over
  a path that is dormant by accident.
- **Resource cleanup / error handling**: nothing to check — the change is a pure predicate
  guarding a `continue`.
- **Source hygiene**: no file grew past its neighbours' norms; the added doc comments are long
  but each states a decision a future reader would otherwise re-litigate, which is this repo's
  established style.

## Pre-existing, not from this ticket

`yarn docs:check` fails on word-count ratchets in `docs/module-authoring.md`,
`docs/schema.md`, and `docs/sync.md`. Already triaged and listed in
`tickets/.pre-existing-known.md` against `debt-doc-size-ratchet-red-at-head`; none of the
three is touched by this ticket or by the review's edits.
