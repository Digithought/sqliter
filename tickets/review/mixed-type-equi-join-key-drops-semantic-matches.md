---
description: Joining a duration column to a plain text column used to silently return no rows even though the same comparison in a WHERE clause matched; the join now agrees with the comparison operator. Review the fix.
files:
  - packages/quereus/src/util/comparison.ts                          # new `semanticOrderingsAgree` predicate
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # the gate, applied to both extractors
  - packages/quereus/src/runtime/emit/join.ts                        # USING comparator now routes through makeOperandComparator
  - packages/quereus/src/runtime/emit/bloom-join.ts                  # comment only
  - packages/quereus/src/runtime/emit/merge-join.ts                  # comment only
  - packages/quereus/src/runtime/emit/asof-scan.ts                   # NOTE repointed only
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic      # new "Mixed-type equi-join keys" section
  - docs/types.md                                                    # § Semantic ordering — join-key rule
difficulty: medium
---

# Review: mixed-type equi-join keys now agree with `=`

## What was wrong

Some column types define "same value" as something other than byte-equality of the
stored text (`docs/types.md` § "Semantic ordering"). `TIMESPAN` is the motivating case:
`'PT1H'` and `'PT60M'` are two spellings of one hour, and `=` treats them as equal.

Before this change, the same comparison gave two different answers depending on how it
was written:

```sql
create table a (id integer primary key, d timespan);
create table b (id integer primary key, s text);
insert into a values (1, 'PT1H');
insert into b values (1, 'PT60M');

select a.id from a cross join b where a.d = b.s;   -- 1 row  (correct)
select a.id from a join b on a.d = b.s;            -- 0 rows (wrong, now fixed)
```

The `on` form planned to a hash join keyed on the raw stored text. The same 0-row
answer came back from `where exists (…)`, from `left join … where … is not null`, and
from the `using (d)` spelling.

## What landed

**The rule.** A physical equi-join key pair is admissible only when its two sides agree
on semantic ordering: either neither side declares a semantic-ordering logical type, or
both declare the same one. A pair that fails demotes to the join's residual predicate —
or, for `USING`, sinks the whole extraction — so the generic nested-loop join evaluates
it with the `=` operator's own semantics.

Concretely:

- `util/comparison.ts` — new `semanticOrderingsAgree(a, b)`. Its docstring records why
  it is deliberately NOT `comparisonSemanticsDiffer` (that one compares `compare`
  function identity, and every builtin type has its own `compare`, so it would decline
  an ordinary `integer` ↔ `real` join key for no correctness gain).
- `planner/rules/join/equi-pair-extractor.ts` — the gate applied in both
  `extractEquiPairs` (reading each operand's `getType().logicalType`) and
  `extractEquiPairsFromUsing` (whose attribute parameter shape widened to carry
  `logicalType`; extracted as a named `UsingAttr` type). A new
  "**Semantic-ordering gate**" paragraph sits alongside the existing "Collation gate"
  paragraph.
- `runtime/emit/join.ts` — `evaluateUsingCondition` now compares through
  `makeOperandComparator` (the single shared routing rule `emitComparisonOp` uses)
  instead of `compareSqlValuesFast`. Gating alone does not fix USING: a declined USING
  pair falls to the generic join, which was equally semantic-ordering-blind.
- `bloom-join.ts` / `merge-join.ts` — comments only, recording that a mixed pair can no
  longer arrive and naming the gate that keeps it out.
- `asof-scan.ts` — NOTE repointed: AS OF has no residual to demote into, so the gate
  does not apply there; the NOTE now names the backlog ticket instead of suggesting a
  fix that would not work.
- `docs/types.md` — the previous "one surface does not yet follow the rule" bullet
  (which named this ticket) is replaced by the mixed-pair rule, the reason for
  declining rather than canonicalizing, and the two remaining gaps.

**Why decline, not canonicalize the hash key.** Canonicalizing would fix hash join and
leave merge join unsound: merge needs both inputs physically sorted in its comparator's
order, and a `timespan` side is sorted by elapsed time while a `text` side is sorted by
text — no single comparator merges those two orders. Canonicalizing also carries a
false-positive hazard: `TIMESPAN.groupKey('PT1H')` returns the *number* `3600`, so a
`timespan` ↔ `integer` pair would hash-match values `=` reports unequal. The cost of
declining is that a rare join shape drops to nested loop; losing rows is worse.

## How to exercise it

`packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`, section
"=== Mixed-type equi-join keys agree with `=` ===". Run:

```
yarn workspace @quereus/quereus run test --grep "15.1-semantic-ordering"
```

Covered there:

- `timespan` ↔ `text` across five spellings — `cross join … where` (the baseline that
  always worked), `join … on`, the flipped operand order, `where exists (…)`, and both
  `left join … where … is not null` / `… is null`. All previously returned the wrong
  row set except the `where` baseline.
- `timespan` ↔ `text` via `using (d)`, in both table orders.
- A same-type `timespan` ↔ `timespan` control (`on` and `using`) so a future change that
  over-declines is noticed.
- `json` ↔ `text` for `on` and `where`. **These already passed before the change**, for
  a structural reason pinned in a comment: `insertCrossTypeCoercion` wraps the text side
  in `cast(… as json)`, so the operand is a `CastNode` and was never recognized as an
  equi-pair. If that coercion stops firing, the new gate is what must catch it.

Plan shape was verified out-of-band with `query_plan()`:

| query | join operator |
| --- | --- |
| `mxa join mxb on mxa.d = mxb.s` (timespan ↔ text) | `JOIN` (nested loop) |
| `mxa join smb on mxa.d = smb.d` (timespan ↔ timespan) | `HASHJOIN` |
| `mxa join umb using (d)` (timespan ↔ text) | `JOIN` |
| `mxa join smb using (d)` (timespan ↔ timespan) | `HASHJOIN` |

This is not asserted by any committed test — see the gaps below.

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsconfig.test.json`
  type pass).
- `yarn workspace @quereus/quereus run test` — **7434 passing, 13 pending, 0 failing.**
  Test count is unchanged because each `.sqllogic` file is a single mocha `it()`; the
  new assertions ran inside the existing one (confirmed by the `--grep` run above).
- `yarn build` — clean across all packages.
- `yarn test:store` was **not** run. This ticket touches planner/runtime join paths, not
  storage, but the store module re-runs the same logic file, so a reviewer with time may
  want to confirm.

## Known gaps — please probe these

**1. No committed test pins the plan shape.** The sqllogic assertions prove the *answer*
is right, but nothing fails if a future change makes the mixed pair go back to a hash
join that happens to be canonicalized (right answer, wrong reason) or makes the
same-type pair fall to nested loop (right answer, silent perf loss). A `test/plan/`
spec asserting the four rows in the table above would close this. Judgement call left to
review: it may be worth a `debt-` ticket rather than inline work.

**2. `semanticOrderingsAgree` has no direct unit test.** It is exercised only through
the sqllogic file, and only for the `timespan` ↔ `text` and `timespan` ↔ `timespan`
shapes. The `json` ↔ `json`, `json` ↔ `timespan` and `undefined` argument branches are
untested.

**3. The USING comparator swap is wider than the ticket's motivating case.** *Every*
USING join that reaches the generic nested-loop emitter now compares through
`makeOperandComparator` rather than `compareSqlValuesFast`, including same-type and
plain-text pairs. `makeOperandComparator` reduces to `compareSqlValuesFast` under the
resolved collation whenever no operand is temporal and both share a category, so plain
text/numeric USING joins are unchanged by construction — and the full suite agrees — but
the *temporal* branch is new behavior for `date`/`time`/`datetime` USING columns, which
now take a runtime temporal check. I probed `date`, `datetime` and `time` against `text`
with non-canonical spellings (`'2024-01-05'` vs `'2024-01-05T00:00:00Z'`,
`'10:00:00'` vs `'10:00:00.000'`) and the `on` and `where` forms agreed in every case
(both returned zero rows — the temporal check does not equate those spellings), so I
found no divergence. That probing was manual and not committed.

**4. NULL behavior in USING is unchanged but unpinned.** `makeOperandComparator` returns
0 for a NULL/NULL pair on every branch, exactly as the `compareSqlValuesFast` call it
replaced did, so no short-circuit was added. There is no test asserting
`p join q using (k)` over two all-NULL `k` columns returns no rows.

**5. Deliberately out of scope, per the implement ticket — verify the reasoning holds:**

- **Fact extraction.** `planner/nodes/join-node.ts`'s `extractEquiPairsFromCondition`
  mints value-level facts (functional dependencies, key coverage, join elimination) and
  still gates only on collation, so it admits a semantic-ordering pair on the claim that
  matched rows are *value*-equal — false when `'PT1H'` matches `'PT60M'`. The implement
  ticket reports probing join elimination against a `timespan` primary key, constant
  pinning, GROUP BY, and DISTINCT over a UNION ALL, and finding no observable
  over-claim. I did not re-probe this. If a reviewer can construct a query where a fact
  derived there substitutes one spelling for another, that is a real bug and belongs in
  a new `fix/` ticket.
- **`emitIn`'s `inMembershipKey`** has the same false-positive shape the canonicalize
  option would have introduced (a `groupKey` that returns a number). Untouched, and
  deliberately not copied.

**6. Two adjacent defects stay open, both already filed:**

- `tickets/backlog/bug-using-join-skips-cross-type-coercion` — `using (d)` over a JSON
  column and a TEXT column still returns no rows, because USING skips the plan-time
  `cast(… as json)` that `=` gets. The test file has a comment saying explicitly not to
  add a passing assertion for this.
- `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering` — AS OF match and
  partition columns still compare by storage class + collation. The gate cannot apply
  (no residual to demote into); the `asof-scan.ts` NOTE now says so.
