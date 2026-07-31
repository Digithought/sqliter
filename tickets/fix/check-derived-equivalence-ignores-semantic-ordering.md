---
description: A table rule saying "these two columns must be equal" makes the query planner assume the two columns hold identical text. When one of them is a duration column, one hour can be written several ways, so the assumption is wrong and rows silently vanish from query results.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts   # root cause: handleEquality + recognizeGuardedBody
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts  # reuses the same extraction; no change expected
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # the consumer that loses the row
  - packages/quereus/src/util/comparison.ts                     # semanticOrderingsAgree — the gate to apply
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts   # unit net for the extractor
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # end-to-end net for semantic ordering
  - docs/invariants.md                                          # OPT-051 currently records this as a known hole
  - docs/optimizer-fd.md                                        # § Semantic-ordering gate on cross-column facts
  - docs/types.md                                               # § Semantic ordering
difficulty: medium
repro: verified
---

# CHECK-derived column equivalences ignore semantic ordering

## Plain statement

Some column types compare by *meaning* rather than by the exact text stored. A `timespan`
column holding `'PT1H'` (one hour) compares equal to `'PT60M'` (sixty minutes); a `json`
column holding `'{"a":1}'` compares equal to `'{ "a" : 1 }'`. Plain `text` columns do not
work that way — for them only the identical string is equal.

When a table declares `check (d = s)` and `d` is one of those meaning-compared types while
`s` is plain text, the planner records "column `d` and column `s` always hold the same
value". That is false: a row can legitimately store `d = 'PT1H'` and `s = 'PT60M'` — the
CHECK passes, because `=` compares them by meaning — yet the two columns hold different
strings. The planner then uses the false claim to rewrite queries, and rows disappear.

## Reproduction (verified — run and observed)

```sql
create table ck (id integer primary key, d timespan, s text, check (d = s)) using memory;
insert into ck values (1, 'PT1H', 'PT60M');   -- accepted: 'PT1H' = 'PT60M' as durations

select id, d, s from ck;                       -- [{"id":1,"d":"PT1H","s":"PT60M"}]
select id from ck where d = 'PT1H';            -- []      ← wrong, must be [{"id":1}]
```

The table reference's physical properties carry `equivClasses: [[1, 2]]` (i.e. `{d, s}`).
`rule-predicate-inference-equivalence` reads that class straight off the source, sees the
filter pin `d = 'PT1H'`, and synthesizes an extra conjunct `s = 'PT1H'`. `s` is text and
stores `'PT60M'`, so the row is filtered out.

## Root cause — one file, two arms

`packages/quereus/src/planner/analysis/check-extraction.ts` mints the same kind of
cross-column pairing fact the predicate and join extractors do, but without the
semantic-ordering gate those three already apply (`semanticOrderingsAgree` in
`packages/quereus/src/util/comparison.ts`, invariant OPT-051):

- **`handleEquality`** — the `col = col` branch pushes mirror functional dependencies plus
  an `equivPairs` entry. This is the arm the reproduction above hits.
- **`recognizeGuardedBody`** — the implication form (`check (g <> 1 or d = s)`) pushes the
  same mirror pair tagged `valueEquality: true`, which the Filter's guard-activation path
  lifts into an equivalence class once the guard is discharged. Same falsehood, reached by a
  different route. Not separately reproduced; inferred by reading the two call sites.

Both arms already receive the declared logical type of every column
(`columns: ReadonlyArray<DeclaredColumnInfo>`, whose `logicalType` field feeds the existing
collation gate), so the information the gate needs is in hand at both sites.

`assertion-hoist-cache.ts` funnels hoisted assertions through the same
`extractCheckConstraints` entry point, so fixing the two arms covers that route too — it
should need no change of its own.

## Second consequence to check while fixing

`clauseEntailed` (`planner/util/fd-utils.ts`) discharges an `eq-literal` guard clause by
finding any equivalence-class peer pinned to that literal, which can activate a partial
UNIQUE index's `kind: 'unique'` functional dependency. It consumes whatever equivalence
classes reach the Filter, including ones lifted from a CHECK — so a false `{d, s}` class can
also activate a uniqueness claim that does not hold. Not reproduced; worth a case either way,
since the sibling ticket that closed the filter-side route left this arm untested.

## Expected behaviour

A cross-column equality fact — mirror FDs, an equivalence class, a `valueEquality` mirror
pair — is minted from a CHECK only when the two columns agree on semantic ordering: neither
declares a meaning-comparing type, or both declare the *same* one. A mixed pair contributes
nothing, exactly as the filter and join extractors already behave. Constant pins
(`check (d = 'PT60M')`) stay ungated for the reason recorded in `docs/optimizer-fd.md`: they
claim only that the column *compares equal to* the value under its own comparison.

Over-declining is the safe direction. `semanticOrderingsAgree` compares logical types by
object identity, matching the three existing call sites.

## Coverage the fix should leave behind

- The reproduction above, as an end-to-end case in
  `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`, alongside a same-type
  control (`d timespan, e timespan, check (d = e)`) that must keep its equivalence class and
  must still return rows carrying their own stored spellings.
- Extractor-level cases in `packages/quereus/test/optimizer/check-derived-fds.spec.ts`:
  mixed pair declined in both operand orders, `timespan`/`json` cross pair declined, same-type
  pair still admitted, constant pin on a `timespan` column still admitted.
- One case for the implication form, so the `recognizeGuardedBody` arm is not fixed blind.
- A case for the partial-UNIQUE guard-discharge route described above, whichever way it turns
  out to behave.

## Docs to correct once it lands

`docs/invariants.md` (OPT-051), `docs/optimizer-fd.md` (§ "Semantic-ordering gate on
cross-column facts"), `docs/types.md` (§ "Semantic ordering") and the `ConstantBinding`
declaration comment in `packages/quereus/src/planner/nodes/plan-node.ts` all currently record
this site as a known, tracked hole and point at this ticket. Each needs its exception text
removed and the site added to OPT-051's gated list.
