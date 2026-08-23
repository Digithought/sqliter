description: Fixed a bug where using two different constant subqueries in one query — such as adding `(select 1)` in one column and `(select 2)` in another — made the engine treat them as the same value, returning wrong numbers and silently dropping rows.
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts   # the fix
  - packages/quereus/src/planner/analysis/predicate-shape.ts          # the two shared accessors
  - packages/quereus/src/planner/analysis/change-scope.ts             # last unguarded site, closed during review
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/planner/analysis/sat-checker.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/stats/catalog-stats.ts
  - packages/quereus/src/runtime/emit/binary.ts
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic
  - packages/quereus/test/logic/change-scope.spec.ts
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts
  - docs/optimizer-const.md
  - docs/optimizer-rules.md
repro: verified
---

# Complete: constant subquery literals no longer collide in CSE

## The defect

Constant folding is a synchronous optimizer pass, but the value it folds may be async. So
`const-pass.ts` builds a `LiteralNode` whose `expression.value` can be a **still-pending
Promise** that only the emitter awaits. Every uncorrelated constant scalar subquery —
`(select 1)` — folds to exactly that shape.

`fingerprintLiteral` dispatched on the JavaScript type of that raw value. A Promise
matched none of the scalar arms, fell into the JSON-document branch, and canonicalized to
the empty object — so **every** promise-valued literal fingerprinted as `LI:j{}`.
`rule-scalar-cse.ts` groups subexpressions by fingerprint and collapses each duplicate
group into one shared computation, so two expressions differing only in which constant
subquery they contained became one.

Three verified symptoms:

| query | before | after |
| --- | --- | --- |
| `select x + (select 1) as a, x + (select 2) as b from t where id = 1` | `[{a:11,b:11}]` | `[{a:11,b:12}]` |
| `select id from t where x = (select 10) or x = (select 20) order by id` | `[{id:1}]` | `[{id:1},{id:2}]` |
| `select x + (select 1) as a from t where x + (select 2) > 21 order by id` | `[]` | `[{a:21}]` |

The second and third silently dropped qualifying rows with no error. The third is the
Project→Filter chain `ruleScalarCSE` actually targets; it was added during review and
confirmed to return zero rows against the pre-fix code.

## The fix

`fingerprintLiteral` now calls `literalValue(node.expression)` — the shared plan-time
accessor in `predicate-shape.ts` — and returns a per-node-unique `LI:?<node id>` when it
comes back `undefined`. The trailing "unexpected host value" arm was changed from
`LI:?${String(value)}` to `LI:?${node.id}` too, so the invariant is uniform: **any literal
without a plan-time value gets a node-unique fingerprint.**

The rest of the change closes the class. `AST.LiteralExpr.value` is honestly typed
`MaybePromise<SqlValue>`, so the compiler already stops any *honest* reader — the only way
back into the bug is a cast or an open-coded `instanceof Promise` test. Every such site is
now routed through `literalValue` / `planTimeLiteralValue`:

| site | reader before |
| --- | --- |
| `expression-fingerprint.ts` | raw read (the bug) |
| `rule-monotonic-range-access.ts` | `as SqlValue` cast hiding the Promise arm |
| `schema/function.ts` `evaluateLiteralOperand` | duck-typed `{ type?, value? }` annotation |
| `change-scope.ts` `scopeValueFromExpr` | `as unknown as { expression: { value: SqlValue } }` — found in review, see below |
| `sat-checker.ts`, `limit-offset.ts`, `fd-utils.ts` ×2, `catalog-stats.ts` ×2, `runtime/emit/binary.ts` | open-coded `instanceof Promise` guards |

Docs: `docs/optimizer-const.md` §4 names both accessors and what `undefined` vs `null`
mean; `docs/optimizer-rules.md`'s `ruleScalarCSE` entry now states that an expression
enclosing a folded async constant is never deduplicated; `predicate-shape.ts`'s header
says these two functions are the shared answer and that a cast is the only remaining way
to reintroduce the bug.

## Review findings

**Checked:** the full implement diff read before the handoff summary; every remaining raw
`expression.value` read in `src/` (17 sites); every cast that narrows
`MaybePromise<SqlValue>` to `SqlValue`; the blast radius of `fingerprintExpression`; the
`literalValue` migration at each of the 10 call sites for null/undefined semantic drift;
the ESM import graph for the new `schema/` → `planner/analysis/` and
`runtime/emit/` → `planner/analysis/` edges; every doc mentioning fingerprinting or CSE;
`yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (10181 + 420 + 179 + 89 + 78 + 89
+ 1922 + 736 + 85 + 31 + 34 + 134 + 22 passing, 25 pending, **0 failing**).

**Found and fixed in this pass:**

- **`change-scope.ts` `scopeValueFromExpr` was the same bug, one layer up, and the
  implement pass missed it.** It read the literal's value behind
  `as unknown as { expression: { value: SqlValue } }` — a cast that lies about the runtime
  type, exactly the pattern the ticket deleted from `schema/function.ts` — and returned a
  pending Promise as a watch scope value. `stringifyScopeValue` renders any unrecognized
  value as `j:{}`, so two distinct constant-subquery-pinned key values would have deduped
  to one and a change watch would have missed changes to the other. Verified **dormant
  today**: probed six query shapes (`k = (select 1)`, `k in ((select 1),(select 2))`,
  cast-wrapped, arithmetic, disjunctions) and all degrade to `{kind:'full'}`, because the
  constraint extractor — fixed by the sibling ticket
  `bug-constant-subquery-literal-crashes-predicate-rewrite` — already declines to surface
  the folded literal. So it was a latent defect protected only by a distant caller, not a
  live one. Now routed through `planTimeLiteralValue`, cast deleted, with a regression test
  in `test/logic/change-scope.spec.ts` pinning the full-watch degradation for three shapes
  plus an ordinary-literal control. **This was the last such cast in `src/`** — the class
  is now closed and compiler-enforced.
- **The strongest repro shape was untested.** The implement pass covered
  projection-only, one Filter's disjunction, and the Sort chain — but not the
  Project→Filter chain, the case where collapsing changes the *row set* rather than a
  column value. Added to `96-subquery-edge-cases.sqllogic` and confirmed it returns 0 rows
  instead of 1 with the fix line reverted.
- **The trailing "unexpected host value" arm had no test.** Its hardening was the same
  collision class one line down and was unverified. Added a unit case: four literals over
  values matching no `SqlValue` shape all fingerprint distinctly and node-uniquely.
- **`docs/optimizer-rules.md`'s `ruleScalarCSE` entry was stale** — it described the dedup
  criterion without the new "no plan-time value ⇒ never deduplicated" rule. Extended.
- **`predicate-shape.ts`'s header enumerated its callers**, a list already missing four
  and guaranteed to rot. Replaced with the durable statement: the AST type is honest, so
  only a cast can reintroduce the bug.
- **`fingerprintLiteral`'s comment block was ~18 lines for a 40-line function**, with the
  Promise explanation stated twice. Condensed to the essential why plus the tripwire,
  pointing at `docs/optimizer-const.md` §4 for the full account.

**Filed:** `tickets/backlog/debt-planner-test-doubles-duck-typed.md`. The implement pass
had to correct `mockLiteral` in three spec files that built `expression: { value }` with
no `type: 'literal'` tag — unfaithful doubles that made catalog-statistics tests silently
exercise a fallback path instead of the code they name. That correction was right, but the
mechanism survives: 27 `as unknown as ScalarPlanNode` casts across 5 files, each one a
place the compiler has been told to stop checking. Filed at the representation rung — one
shared factory returning *real* nodes, as `expression-fingerprint.spec.ts` already does —
rather than as a point fix, because the failure mode is a green test covering nothing.

**Considered and not filed:**

- The two gaps the handoff flagged — no new test for `rule-monotonic-range-access.ts` or
  `schema/function.ts` — are correctly non-issues. Both sites are unreachable from SQL
  today, both changes are strictly more conservative, and both are now type-checked rather
  than cast-hidden. A test would pin a path that cannot be driven.
- The handoff's "no plan-shape assertion" gap is already covered:
  `test/optimizer/scalar-cse.spec.ts` asserts via `query_plan()` that a genuinely-shared
  expression still injects a CSE projection, so a future change that "fixed" results by
  disabling CSE wholesale would fail there.
- The remaining raw `expression.value` readers — `scalar-invertibility.ts`,
  `rule-lateral-top1-asof.ts` ×3, `rule-semijoin-existence-recovery.ts`,
  `rule-empty-relation-folding.ts`, `rule-grow-retrieve.ts` ×2, `func/builtins/json.ts` —
  all guard with *positive* type tests (`typeof v === 'number'`, `=== true`, …), so a
  Promise falls through to the safe non-match branch. Correct as written; migrating them
  would be churn.
- `LiteralNode.computePhysical()` returns `constant: true` for a promise-valued literal.
  Accurate — the value is constant per statement, just not known at plan time — and no
  consumer of `physical.constant` reads the value unguarded.

**Tripwire (parked in code, not filed):** `NOTE:` at `expression-fingerprint.ts`
`fingerprintLiteral` — two textually identical constant subqueries in one statement no
longer share a computation. Near-free today, since each occurrence const-folds separately
anyway and CSE only ever saved the enclosing arithmetic. Trips only if a workload repeats
an expensive constant subquery many times in one statement; the note names the fix
(key on the folded subquery's identity rather than the node id).

## Validation

From repo root, foreground, after the review changes: `yarn build`, `yarn lint`,
`yarn typecheck` all clean; `yarn test` **0 failing** (10181 passing in `packages/quereus`,
+2 from the review's new unit and change-scope cases). `yarn test:store` not run — slow,
and nothing here touches the store path. No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.
