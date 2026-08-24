---
description: A query that filters one table with `in (select ...)` and also joins that table to another one used to read the filtered table end-to-end; the planner now applies the `in (...)` filter before the second join, so only the matching rows are read.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts        # NEW — the rule
  - packages/quereus/src/planner/optimizer.ts                                 # registration (Structural, ~line 578, right after subquery-decorrelation)
  - packages/quereus/test/optimizer/semi-join-pushdown.spec.ts                # NEW — the rule's own plan shape
  - packages/quereus/test/optimizer/key-set-seek.spec.ts                      # new describe: "compound shape: a semi join reassociated below an inner join"
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic               # new section: "Compound shape …" (also runs under `yarn test:store`)
  - packages/quereus-store/test/key-set-seek-store.spec.ts                    # new describe: "compound shape: the filtered table is also joined to another table"
  - docs/optimizer-rules.md                                                   # new bullet in the Join section, after ruleKeySetSeek
  - docs/optimizer.md                                                         # line ~119, appended to "Where an `IN (SELECT …)` predicate ends up"
---

# Apply a semi join before an unrelated join, so the key-set seek can fire

## What changed

`rule-key-set-seek` turns `where col in (select …)` into "materialize the key set once,
then seek the target's index per key". It only fires when the side being filtered peels
down to a bare table read. In the compound query

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.txn_id in (select txn_id from entry where account_id = ?);
```

the filtered side is a *join*, so the rule declined and `entry` was scanned end-to-end.

A new Structural-pass rule, `rule-semi-join-pushdown`, reassociates the semi join below
the inner/cross join first:

```
Join(semi, Join(inner|cross, L, R), K, cond)      cond reads L (and K) only
  →  Join(inner|cross, Join(semi, L, K, cond), R)         (mirror form for R)
```

The filtered side is then a bare leaf again and the existing key-set rule fires unchanged.
Nothing in `rule-key-set-seek` or `shared/access-leaf.ts` was touched.

Measured before/after on the repro (memory backend):

```
before                                   after
HashJoin [SEMI]                          Join [INNER]
 ├─ HashJoin [INNER]                      ├─ Alias e
 │   ├─ IndexScan entry _primary_   <-    │   └─ KeySetSemiJoin via idx_entry_txn
 │   └─ IndexScan txn   _primary_   <-    │        ├─ IndexScan entry _primary_
 └─ IndexSeek entry idx_entry_account     │        └─ IndexSeek entry idx_entry_account
                                          └─ Alias t
                                              └─ IndexSeek txn primary
```

Both full scans are gone. On the persistent store backend the store's `query()` is handed
`idx=ix_entry_txn(0);plan=5;inCount=20` and never a `plan=0` walk of `entry` — captured,
not inferred (`IdxStrCapturingStoreModule`).

## Use cases to exercise when reviewing

**Positives — the semi join should move below the join**

- Left arm (the repro): `from entry e join txn t on t.id = e.txn_id where e.txn_id in (select …)`.
- Right arm: same FROM, `where t.<col> in (select …)` — pushes onto `txn` instead.
- `cross join` on the probe side (neither side is null-extended, same argument).
- Two stacked inner joins — the rewrite's own output is descended into, so it pushes twice.
- Correlated `exists (…)` that decorrelation turns into the same semi join.
- A probe column with **no** index: the semi join still moves, no seek is won. This is the
  case that isolates the rule from `rule-key-set-seek` and is what
  `test/optimizer/semi-join-pushdown.spec.ts` uses throughout.

**Declines — the semi join must stay put**

- Condition spanning BOTH inner-join branches (`exists (… and m.txn_id = e.txn_id and m.id = t.id)`).
- `left join` / `full join` on the probe side (out of scope by design; the null-extended
  mirror is unsound and must stay declined permanently — see the rule header).
- `anti` join anchor (`not exists`) — declined by design, since `rule-key-set-seek` admits
  `semi` only.
- A bare (join-free) semi join — nothing to push below.

**Row equality** (`test/logic/08.4-key-set-semi-join.sqllogic`, memory + store): NULL join
keys, a key set containing NULL, duplicate matches on one key, an entry naming a
nonexistent txn (dropped by inner join, NULL-extended by left join), fan-out on the
untouched side, right-arm, correlated `exists`, `not in` / `not exists`, condition spanning
both branches, and read-your-own-writes inside a transaction.

## Validation run

- `yarn test` — green. `@quereus/quereus`: **10245 passing, 0 failing, 25 pending**
  (log: `tickets/.logs/1-bug-key-set-seek-declines-when-probe-is-join.test.log`);
  `@quereus/store`: 1931 passing, 0 failing; all other workspaces passing.
- `yarn lint` — clean (includes the `tsc -p tsconfig.test.json` pass over quereus specs).
- `yarn typecheck` — clean (this is what type-checks the quereus-store spec).
- `08.4-key-set-semi-join.sqllogic` run in **store mode** (`QUEREUS_TEST_STORE=1`) — passing.
- The new sqllogic cases were confirmed non-vacuous by deliberately corrupting one expected
  result and watching it fail.

## Known gaps — treat the above as a floor

- **`yarn bench:gate` was NOT run** (likely over the 10-minute agent budget). The rule is
  unconditional with no cost gate, matching `rule-join-predicate-pushdown`'s treatment of
  scalar conjuncts. The one shape that does extra work — a strongly *filtering* inner join,
  where the semi join now probes `|L|` rows instead of the smaller `|L ⋈ R|` — is recorded
  as a `NOTE:` at the rule's admission site with its revisit condition, but it is
  **unmeasured**. If a perf gate matters here, that is a reviewer/CI job.
- **No timing measurement of the win.** The improvement is asserted structurally (the
  `plan=5` multi-seek reaches the store, the full scan is gone), never timed.
- **Several admission gates are defensive and unreachable from SQL today**, so they have no
  direct test: a correlated / non-deterministic / write-bearing key source, a write-bearing
  or correlated inner-join branch, `exists … as` flags on the anchor or on the inner join.
  They mirror `rule-key-set-seek`'s `admitJoin` one-for-one and cost nothing, but a reviewer
  should know they are argued, not exercised. The correlated-key-source case is pinned
  indirectly: a test asserts the *upstream* fact that such an `IN` never decorrelates into a
  semi join at all, so it fails loudly if that ever changes.
- **One gate beyond the ticket's list**: `PlanNodeCharacteristics.isFunctional(node.condition)`.
  The reassociation changes how many rows the condition is evaluated against, so a
  non-deterministic or write-bearing condition must stay put. Conservative and (as far as I
  could construct) unreachable via SQL — flagging it as an addition, not an omission.
- **The prototype's "rule on vs off" differential harness was not reproduced.** Row equality
  is pinned as fixed expected values in sqllogic rather than by re-running each query with
  `disabledRules: {'semi-join-pushdown'}` and diffing. A differential test would be
  strictly stronger.
- **Nesting tested to two levels only** (`Join(semi, Join(inner, Join(inner, A, B), C), K)`);
  three-plus is argued from the traversal, not tested.
- **No coverage of the interaction with join reordering** (`join-greedy-commute`,
  `quickpick-enumeration`) once the semi join sits inside a branch.
- **Anti joins and LEFT-join-with-preserved-side-condition are deliberately unimplemented**
  (both sound; nothing downstream gains from the first, and the second was scoped out).
  Recorded as greppable `NOTE:` lines in the rule header with their revisit conditions.

## Gotcha for anyone re-running the store tests

`packages/quereus-store` resolves `@quereus/quereus` to `packages/quereus/**dist**`, not to
`src`. Editing engine source and running `yarn workspace @quereus/store test` without a
`yarn build` in between silently tests the *old* engine — the compound test will look like a
genuine failure. Build first.

## Review findings

- Cost tripwire parked as a `NOTE:` at the rule's admission site in
  `packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts` — unconditional
  pushdown does extra probing on a strongly filtering inner join; revisit if a
  filtering-join shape regresses in `yarn bench:gate`.
- Two scope decisions parked as `NOTE:` lines in the same file's header — `anti` joins, and
  a LEFT join on the probe side with the condition on the preserved side. Both are sound
  rewrites left unimplemented; the header also states which LEFT-join variant is *unsound*
  and must stay declined permanently.
