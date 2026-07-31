---
description: A table rule saying "these two columns must be equal" makes the query planner assume the two columns hold identical text. When one of them is a duration or JSON column, the same value can be written several ways, so the assumption is wrong and rows silently vanish from query results.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts   # the fix: handleEquality + recognizeGuardedBody
  - packages/quereus/src/planner/analysis/comparison-collation.ts # DeclaredColumnInfo carries the logicalType the gate needs
  - packages/quereus/src/util/comparison.ts                     # semanticOrderingsAgree — the predicate to apply
  - packages/quereus/src/planner/nodes/filter.ts                # consumer: guard activation + EC-closed constant bindings
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # consumer that drops the row
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts   # unit net for the extractor
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # end-to-end net (see § "Filter-level cross-column equality facts", line ~292)
  - docs/invariants.md                                          # OPT-051 — remove the "known hole" paragraph, add the site
  - docs/optimizer-fd.md                                        # § Semantic-ordering gate on cross-column facts
  - docs/types.md                                               # § Semantic ordering (line ~350)
  - packages/quereus/src/planner/nodes/plan-node.ts             # ConstantBinding declaration comment (line ~227)
difficulty: medium
repro: verified
---

# Gate CHECK-derived cross-column equality facts on semantic ordering

## Plain statement

Some column types compare by *meaning* rather than by the exact text stored. A `timespan`
column holding `'PT1H'` (one hour) compares equal to `'PT60M'` (sixty minutes); a `json`
column holding `'{"x":1}'` compares equal to `'{ "x" : 1 }'`. Plain `text` columns do not
work that way — for them only the identical string is equal.

When a table declares `check (d = s)` and `d` is one of those meaning-compared types while
`s` is plain text, the planner records "column `d` and column `s` always hold the same
value". That is false: a row can legitimately store `d = 'PT1H'` and `s = 'PT60M'` — the
CHECK passes, because `=` compares them by meaning — yet the two columns hold different
strings. The planner then uses the false claim to rewrite queries, and rows disappear.

The three other extractors that mint this same kind of fact already decline mixed pairs
(`semanticOrderingsAgree`, invariant OPT-051). This ticket adds the same gate to the fourth.

## Reproductions (all run and observed at HEAD)

Setup used for each: a temporary mocha spec driving `Database.eval`; deleted afterwards.

**R1 — timespan vs text, the headline case.**

```sql
create table ck (id integer primary key, d timespan, s text, check (d = s)) using memory;
insert into ck values (1, 'PT1H', 'PT60M');   -- accepted: 'PT1H' = 'PT60M' as durations

select id, d, s from ck;              -- [{"id":1,"d":"PT1H","s":"PT60M"}]
select id from ck where d = 'PT1H';   -- []      ← WRONG, must be [{"id":1}]
```

**R2 — operand order reversed.** `check (s = d)` behaves identically (`[]`), so the fix must
be symmetric.

**R3 — json vs text.**

```sql
create table j (id integer primary key, a json, b text, check (a = b)) using memory;
insert into j values (1, '{"x":1}', '{ "x" : 1 }');
select id from j where a = '{"x":1}';   -- []    ← WRONG
```

**R4 — same-type control passes today and must keep passing.** `d timespan, e timespan,
check (d = e)` with a row `('PT1H','PT60M')` returns the row from `where d = 'PT1H'`, still
carrying its own stored spellings. The gate must not decline this pair.

**R5 — a partial UNIQUE index in play drops a row too.**

```sql
create table pu (id integer primary key, d timespan, s text, v integer, check (d = s)) using memory;
create unique index pu_v on pu (v) where s = 'PT60M';
insert into pu values (1, 'PT60M', 'PT60M', 7);
insert into pu values (2, 'PT1H',  'PT1H',  7);   -- legal: row 2 is outside the partial index
select id from pu where d = 'PT60M' and v = 7;    -- [{"id":1}]   ← WRONG, both rows match
```

Note on attribution: R5 is **not** independent evidence about the guard-discharge route.
The same false equivalence class also feeds `rule-predicate-inference-equivalence`, which
synthesizes `s = 'PT60M'` and drops row 2 by itself. The `clauseEntailed` route
(`planner/util/fd-utils.ts`) — where an equivalence-class peer pinned to a literal
discharges a partial index's `where` clause and activates a `kind: 'unique'` functional
dependency that does not hold — could not be isolated from it: any shape that discharges the
guard also gains the inferred conjunct. Both close together when the class is no longer
minted. Keep R5 as a regression case, but do not describe it as proving the second route.

## Root cause — one file, three arms

`packages/quereus/src/planner/analysis/check-extraction.ts` mints cross-column facts without
the semantic-ordering gate the sibling extractors apply. Every arm already receives
`columns: ReadonlyArray<DeclaredColumnInfo>` (`comparison-collation.ts`), whose optional
`logicalType` field is exactly what `semanticOrderingsAgree` consumes — no plumbing needed.

**Arm 1 — `handleEquality`, the `col = col` branch (~line 311).** Pushes mirror functional
dependencies plus an `equivPairs` entry. This is what R1/R2/R3/R5 hit. The equivalence pair
lands on the `TableReferenceNode`'s physical properties, where
`rule-predicate-inference-equivalence` reads it straight off the Filter's source.

**Arm 2 — `recognizeGuardedBody`, the `col = col` branch (~line 561).** The implication form
(`check (g <> 1 or d = s)`) pushes the same mirror pair tagged `valueEquality: true`.
`FilterNode.computePhysical` (`nodes/filter.ts`, ~line 153) lifts it into an equivalence
class once the guard is discharged, then re-closes constant bindings over it — so a pin on
`d` produces a *false constant binding on `s`* on that Filter's physical properties.

*Status: latent, not observable in the shapes tried.* `rule-predicate-inference-equivalence`
reads `source.physical.equivClasses`, but guard activation writes the class onto the Filter
*itself*, so the rule never sees it in a single-Filter plan. These all returned correct rows
at HEAD: flat (`where g = 1 and d = 'PT1H'`), nested sub-select, CTE, `order by` barrier,
`distinct` barrier, and projecting `s` out. Treat it as a real latent defect on the same
site, not a tripwire — the fact minted is false, and only plan shape hides it.

**Arm 3 — the single-column `col = expr` one-way FDs (`handleEquality` ~line 326/343, and
the guarded twins in `recognizeGuardedBody` ~line 578/594).** `check (s = trim(d))` mints
FD `{d} → {s}`. Not reproduced (`static`: read from the code). It is unsound in one
direction: consumers judge "rows agreeing on the determinant" using that column's own
identity, so two rows with `d = 'PT1H'` and `d = 'PT60M'` *agree* on `d` while their `s`
values differ as text — e.g. `minimalCover` would drop `s` from a `group by d, s`. The
reverse direction (`{text} → {timespan}`) is actually sound, but apply the same symmetric
gate anyway: over-declining is the safe direction and one predicate is simpler than two.

`assertion-hoist-cache.ts` funnels hoisted assertions through the same
`extractCheckConstraints` entry point, so fixing these arms covers that route too — expect
no change there.

## Expected behaviour

A **cross-column** fact — mirror FDs, an equivalence pair, a `valueEquality` mirror pair, a
one-way `col = expr` determination — is minted from a CHECK only when the two columns agree
on semantic ordering: neither declares a meaning-comparing type, or both declare the *same*
one. A mixed pair contributes nothing, exactly as the filter and join extractors behave.

**Constant pins stay ungated** (`check (d = 'PT60M')` ⇒ `∅ → d` plus a `ConstantBinding`),
for the reason already recorded in `docs/optimizer-fd.md`: the claim is only that the column
*compares equal to* that value under its own comparison, which is true. Gating them would
decline every pin on a `timespan`/`json` column, since a literal never declares a
semantic-ordering type.

**Guard scopes stay ungated** (`recognizeNegatedGuard`), unchanged — same argument the
collation gate already documents at that site.

`semanticOrderingsAgree` compares logical types by object identity, matching the three
existing call sites. `DeclaredColumnInfo.logicalType` is optional; an absent type is treated
as non-semantic, so `semanticOrderingsAgree(undefined, TIMESPAN)` is `false` (declines) and
`(undefined, undefined)` is `true` (admits). That keeps the existing unit tests — which
build minimal `DeclaredColumnInfo` literals with no `logicalType` — passing unchanged.

## Shape of the change

The two AST sites want one small local helper rather than the gate spelled twice:

```typescript
/** True when two declared columns may carry a cross-column equality fact. */
function columnPairSemanticsAgree(
	a: number,
	b: number,
	columns: ReadonlyArray<DeclaredColumnInfo>,
): boolean {
	return semanticOrderingsAgree(columns[a]?.logicalType, columns[b]?.logicalType);
}
```

Deliberately *not* hoisted into a shared module: the three plan-node call sites work on
`ScalarPlanNode` types, this one on declared column metadata — the same split the collation
gate already carries (`isValueDiscriminatingEquality` / `isValueDiscriminatingAstComparison`).

## TODO

**Phase 1 — the gate**

- Add the `columnPairSemanticsAgree` helper (or equivalent) to `check-extraction.ts`,
  importing `semanticOrderingsAgree` from `../../util/comparison.js`.
- Gate arm 1: `handleEquality`'s `lIdx !== undefined && rIdx !== undefined` branch returns
  without pushing when the pair disagrees.
- Gate arm 2: the matching branch in `recognizeGuardedBody`.
- Gate arm 3: the four single-column `col = expr` sites (two in each function), comparing the
  expression's single column against the target column.
- Comment each site with *why* — mixed pairs share no notion of "same value" — and point at
  invariant OPT-051. Keep it short; the reasoning lives in `docs/optimizer-fd.md`.

**Phase 2 — coverage**

- `packages/quereus/test/optimizer/check-derived-fds.spec.ts` (extractor level; import
  `TIMESPAN_TYPE` / `JSON_TYPE` from `../../src/types/builtin-types.js`):
  - mixed `timespan`/`text` pair declined — both operand orders, no FDs and no equiv pair;
  - `timespan`/`json` cross pair declined;
  - same-type `timespan`/`timespan` pair still admitted with both mirror FDs and the pair;
  - constant pin on a `timespan` column still admitted (FD `∅ → col` + binding);
  - implication form `g <> 1 or d = s` declined for a mixed pair, admitted for a same-type
    pair (assert the `valueEquality` tag survives on the admitted one);
  - a one-way `col = expr` case for arm 3, mixed declined and same-type admitted.
  - Verify each negative case actually discriminates: short-circuit the new gate to `true`
    locally and confirm the mixed cases fail.
- `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`, extending the existing
  § "Filter-level cross-column equality facts" block (~line 292) with a CHECK-derived
  sibling block: R1, R2, R3, the R4 same-type control (asserting the row comes back with its
  own stored spellings — a canonicalizing "fix" would rewrite them), and R5. Say in the
  comment which cases return wrong rows at HEAD and which are regression nets over a path
  plan shape currently hides.
- One case for the implication form so arm 2 is not fixed blind. If it cannot be made to
  return a wrong row at HEAD (expected — see arm 2 above), assert the extractor output in the
  unit spec instead of asserting query rows in sqllogic, and say so in the handoff.

**Phase 3 — docs**

- `docs/invariants.md` OPT-051: drop the "Known hole" paragraph, add
  `planner/analysis/check-extraction.ts` to the `code:` list, and add the new guard test.
  Watch the 120-word cap per invariant body that `yarn docs:check` enforces — tighten rather
  than extend.
- `docs/optimizer-fd.md` § "Semantic-ordering gate on cross-column facts": rewrite the
  "Three of the four extractors" framing and delete the paragraph describing the CHECK site
  as ungated; fold the CHECK site into the gated list. Also update the closing paragraph
  about `clauseEntailed`, which currently says the CHECK site "can still feed it" a false
  class.
- `docs/optimizer-fd.md` line ~104 (the CHECK/assertion collation-gate bullet): note that the
  same site now carries the semantic-ordering gate on its cross-column arms.
- `docs/types.md` § "Semantic ordering" (~line 350): replace the `check (d = s)` known-hole
  paragraph with the fixed behaviour.
- `packages/quereus/src/planner/nodes/plan-node.ts` `ConstantBinding` comment (~line 227):
  restore the unconditional claim — every extractor that mints an equivalence class is now
  gated — and drop the ticket reference.

**Phase 4 — validation**

- `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck).
- `yarn test` from the repo root, streamed:
  `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.
- `yarn docs:check` — three word-count ratchets are known-failing at HEAD; anything else is
  yours.
