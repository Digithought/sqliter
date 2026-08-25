---
description: A query that filters one table with `in (select ...)` and also joins that table to another one used to read the filtered table end-to-end; the planner now applies the `in (...)` filter before the second join, so only the matching rows are read.
repro: verified
files:
  - packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts        # the rule
  - packages/quereus/src/planner/optimizer.ts                                 # registration (Structural, right after subquery-decorrelation)
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts     # REVIEW FIX — failure-sentinel bug found here
  - packages/quereus/test/optimizer/semi-join-pushdown.spec.ts                # the rule's own plan shape
  - packages/quereus/test/optimizer/key-set-seek.spec.ts                      # compound-shape seek assertions
  - packages/quereus/test/optimizer/join-quickpick.spec.ts                    # REVIEW — regression tests for the fix above
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic               # row equality (memory + store)
  - packages/quereus-store/test/key-set-seek-store.spec.ts                    # store-backed idxStr capture
  - docs/optimizer-rules.md, docs/optimizer.md, docs/quickpick-design.md
---

# Apply a semi join before an unrelated join, so the key-set seek can fire

## What shipped

`rule-key-set-seek` turns `where col in (select …)` into "materialize the key set once,
then seek the target's index per key". It only fires when the side being filtered peels
down to a bare table read. In the compound query

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.txn_id in (select txn_id from entry where account_id = ?);
```

the filtered side is a *join*, so the rule declined and `entry` was scanned end-to-end.

A Structural-pass rule, `rule-semi-join-pushdown`, reassociates the semi join below the
inner/cross join first:

```
Join(semi, Join(inner|cross, L, R), K, cond)      cond reads L (and K) only
  →  Join(inner|cross, Join(semi, L, K, cond), R)         (mirror form for R)
```

The filtered side is then a bare leaf again and the existing key-set rule fires unchanged.
Nothing in `rule-key-set-seek` or `shared/access-leaf.ts` was touched. Measured on the
repro (memory backend), both full scans are gone; on the persistent store backend the
store's `query()` is handed `idx=ix_entry_txn(0);plan=5;inCount=20` and never a `plan=0`
walk of `entry`, captured rather than inferred.

Deliberately out of scope, with greppable `NOTE:` lines in the rule header stating each
revisit condition: `anti` joins (sound, but `rule-key-set-seek` admits `semi` only, so
nothing downstream gains), and a LEFT join on the probe side with the condition on the
preserved side (sound, scoped out). The header also records which LEFT-join variant is
*unsound* and must stay declined permanently.

## Review findings

### Checked

- Read the implement diff first, before the handoff summary: the rule, its registration,
  four test files, two doc edits.
- Re-derived the rewrite's soundness by hand against `buildJoinAttributes`,
  `buildJoinRelationType` and `JoinNode.withChildren`: output attribute identity and
  order, `isSet`, key propagation, `usingColumns` / `existence` threading. All hold.
- **Closed the differential-harness gap the handoff named.** Ran 17 compound shapes with
  the rule on and with `disabledRules: {'semi-join-pushdown'}`, comparing rows: the
  repro, a residual filter spanning both branches, a residual on one branch, a three-way
  join, `distinct`, a bare aggregate, `group by`, the right arm, `cross join`,
  `join … using`, `order by` on the joined-away column, `limit`, `join lateral`, two
  stacked `IN` predicates on both branches, `not in`, and the whole thing nested inside a
  correlated outer query. Every pair matched.
- Probed shapes the ticket did not list, for plan shape rather than rows: a derived-table
  branch, a grouped-subquery branch, a `Filter` surviving between the anchor and the join,
  `join lateral`, and 4- and 5-relation spines.
- Checked the interaction with the other Join-anchored rules — `join-greedy-commute`,
  `quickpick-join-enumeration`, both existence-recovery rules, the IND folders. This is
  where the finding below came from.
- `yarn lint`, `yarn typecheck`, `yarn test`, `yarn test:store` — all clean (below).

### Major — found and fixed in this pass

**`rule-quickpick-enumeration` silently dropped part of the join graph, returning wrong
rows.** `extractJoinGraph`'s walk signalled "non-inner join found, give up" by writing
`relations.length = 0` mid-recursion. The ancestor frames kept walking, refilled the list
from the siblings the bail had not reached, and the resulting **partial** graph passed the
`>= 3 relations` gate — so enumeration rebuilt a join over the survivors and dropped the
bailed subtree along with every predicate referencing it.

Reachable from plain SQL with no part of this ticket involved (verified, memory backend,
3 txn rows / 3 entry rows):

```sql
select count(*) from entry e left join txn w on w.id = e.amount
  join txn t on t.id = e.txn_id join txn u on u.id = e.id join txn v on v.id = e.account_id;
-- returned 27 (a cross product of txn); correct answer is 0
```

When the dropped relation *is* projected it surfaces as
`No row context found for column id` instead of wrong rows. It needs three or more
relations *after* the bailed one, which is why nothing caught it: a 3-relation spine falls
under the enumeration gate and returns correctly by accident.

This ticket's rule makes the shape ordinary — the pushed semi join is itself a non-inner
join sitting at the bottom of the spine — so `a join b join c join d where a.x in (select …)`
started hitting it. Fixed at the root cause: the sentinel is replaced with a latched
`bailed` flag that short-circuits the recursion and is checked at the end, so a partial
relation list can no longer masquerade as a complete graph. Three regression tests added
to `test/optimizer/join-quickpick.spec.ts` — the outer-join spine (both the wrong-rows and
the wrong-projection spellings) and the semi-pushdown spine — each asserting the rows
*and* that the dropped table is still present in the emitted plan. The semi-pushdown one
also covers three-level nesting, which the handoff listed as argued-but-untested.

### Tripwires (recorded at the site, not filed)

- Bailing on a non-inner join is stricter than necessary — the subtree could be admitted
  as one opaque leaf and the spine still enumerated. Because of this ticket, a
  3+-relation join under an `IN (SELECT …)` filter now loses enumeration it used to get.
  `NOTE:` at the bail in `rule-quickpick-enumeration.ts`, a matching one in
  `rule-semi-join-pushdown.ts`, and a bullet in `docs/quickpick-design.md`; the revisit
  condition is a query of that shape showing up with a bad join order. The opaque-leaf
  variant needs its own correlation guard first (a LATERAL leaf must not be reordered
  below the relation it reads).
- The anchor's left input must be the `JoinNode` itself; no wrapper is peeled, so a
  derived table around the join, or a residual `Filter` spanning both branches that
  survived predicate pushdown, declines. `NOTE:` in the rule header.

### Appended to an existing ticket, not filed fresh

`backlog/debt-seek-leaf-admission-gates-duplicated` already owns the theme "optimizer
rules hand-copy the same admission checklist". This rule copies a *second* such checklist
— the "may this relation be drained exactly once" trio (uncorrelated / deterministic /
write-free) that `rule-key-set-seek`'s `admitJoin` and the decorrelation path also spell
out by hand. Added as a second arm to that ticket with the new site, rather than a new
ticket for the instance.

### Considered and cleared — no action

- **Right-arm push puts the key source inside a nested-loop right pipeline.** Pushing onto
  the `R` branch means the semi join (and its key source) sits on the inner join's right
  side, which a nested loop re-opens per left row. Cleared: physical selection prefers a
  hash join for these equi-shapes, and `rule-nested-loop-right-cache` explicitly wraps a
  pure, uncorrelated, size-bounded right side. Correctness is unaffected either way — the
  rule already refuses a correlated / non-deterministic / write-bearing key source.
- **`existence` flags threaded onto a rebuilt INNER join.** A right-arm push changes the
  `componentTable` id the lineage walk derives for a flag. Unreachable from SQL (the
  parser accepts `exists … as` on `left join` only) and the rule's attribute-id gate
  already declines any condition that reads a flag. The header states this; no change.
- **The defensive gates the handoff flagged as untestable** (correlated / non-deterministic
  / write-bearing key source, write-bearing or correlated inner-join branch) — re-read
  them against `rule-key-set-seek`'s `admitJoin` and `isCorrelatedSubquery`; they are
  conservative in the safe direction and cost nothing. The correlated-key-source case is
  pinned indirectly by an existing test on the upstream fact.
- **Source hygiene.** 209-line rule file, ~95 of it header. Comment-dense, but that is the
  house style in `planner/rules/` and every paragraph carries a soundness argument or a
  revisit condition. Helpers are small and named. No finding.

### Not checked

- `yarn bench:gate` — not run, same reason the handoff gave (over the agent time budget).
  The pushdown is unconditional with no cost gate; the one shape that does extra work (a
  strongly *filtering* inner join, where the semi join probes `|L|` rows instead of the
  smaller `|L ⋈ R|`) remains an argued, unmeasured `NOTE:` at the admission site. So does
  the enumeration loss above. If a perf gate matters here it is a CI job.
- No timing measurement of the win; it stays asserted structurally (the `plan=5`
  multi-seek reaches the store, the full scan is gone).

## Validation

- `yarn build` — clean (needed before the store tests: `packages/quereus-store` resolves
  `@quereus/quereus` to `packages/quereus/dist`, not `src`, so editing engine source and
  running the store tests without a build silently tests the old engine).
- `yarn lint` — clean, including the `tsc -p tsconfig.test.json` pass over the specs.
- `yarn typecheck` — clean.
- `yarn test` — green. `@quereus/quereus`: **10248 passing, 0 failing, 25 pending**
  (10245 before, plus the 3 regression tests added here); `@quereus/store`: 1931 passing;
  all other workspaces passing.
- `yarn test:store` — green: 10240 passing, 0 failing, 33 pending.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
