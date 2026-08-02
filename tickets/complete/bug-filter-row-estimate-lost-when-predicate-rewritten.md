description: The query planner worked out how many rows a WHERE clause would keep, then threw that number away when a later step rewrote the condition — so any query with a subquery in its WHERE ended up planned on a crude 50% guess. The planner now works the number out again after the rewrite.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md, docs/optimizer-rules.md
----

## What shipped

`FilterNode` carries an optional `selectivity` — the fraction of source rows the `where` clause
is expected to keep. It was stamped once, by `rule-filter-selectivity` in the Physical pass.
`FilterNode.withChildren` drops that stamp whenever the predicate child is a different object,
and the PostOptimization pass routinely re-mints predicates (`scalar-subquery-cache` wraps an
uncorrelated scalar subquery's inner in a `CacheNode`, which bottom-up re-mints every scalar
ancestor up to the Filter's predicate). Nothing re-stamped afterwards, so any plan with a
subquery in a `where` reached emission unstamped and every consumer fell back to
`DEFAULT_FILTER_SELECTIVITY` (0.5).

The fix registers the **same rule function a second time**, in `PassId.PostOptimization` under
the distinct id `filter-selectivity-restamp`, placed first in that pass's block so it precedes
`filter-conjunct-ordering`. The Physical registration is untouched. The rule's first line
(`if (filter.selectivity !== undefined) return null`) makes the second registration a pure
fill-in: it never overwrites a surviving stamp.

Also landed: rewritten invariant comment in `FilterNode.withChildren`, rewritten header
doc-comment on `rule-filter-selectivity.ts`, a two-pass description in `docs/optimizer.md`, and
a full catalogue entry for `ruleFilterSelectivity` in `docs/optimizer-rules.md`.

Most of the code landed in commit `74a20a59` (a prior, interrupted run of this ticket whose tree
was swept into another ticket's commit); the docs catalogue entry landed in `7f7f328d`.

## Review findings

### Validation run (review pass, current tree)

- `yarn workspace @quereus/quereus run test --no-bail` → **8324 passing, 13 pending, 0 failing**.
  The two failures the implement handoff reported as pre-existing were fixed out-of-band by the
  runner's triage commit `84e6fbaa` before this review ran; `tickets/.pre-existing-error.md` is
  gone and nothing was skipped or loosened.
- `yarn lint` → clean across all workspaces (includes the `tsc -p tsconfig.test.json` pass over
  spec files).
- `yarn docs:check` → passes. `docs/sync.md` sits 132 words into its 500-word grace band, which
  is the already-tracked `debt-doc-size-ratchet-red-at-head` and unrelated to this ticket.

### Major — one new defect found, ticket filed

**The tripwire the implementer parked is a live, reachable bug, not a conditional concern.** The
handoff recorded "a pass running after PostOptimization that re-mints a Filter's predicate would
drop the stamp again — no query exhibiting this was found" and parked it as a `NOTE:`. A query
exhibiting it does exist and is not exotic:

```sql
-- stamped at 1/ndv(o.qty)
with c as (select cat, qty from o)
select * from o where o.qty = (select max(qty) from c) and o.cat = 'a';

-- same query plus one hint: upper Filter reaches emission with selectivity === undefined
with c as materialized (select cat, qty from o)
select * from o where o.qty = (select max(qty) from c) and o.cat = 'a';
```

Referencing the same `with` clause twice (at least once from inside a `where` scalar subquery)
reproduces it without any hint. Isolated by disabling `cte-optimization` and
`scalar-subquery-cache` in every combination — neither changes the outcome, so the re-mint is
the **Materialization** pass (order 35), which runs after the new re-stamp point. Filed as
`tickets/fix/bug-filter-row-estimate-lost-in-materialization-pass.md` with the repro, the
isolation already done, and the three candidate fix shapes; it is a genuine design choice
(Materialization is a custom-execute pass with no rule slots), not something to patch inline
during review.

### Minor — fixed in this pass

- **Two stale claims corrected.** `docs/optimizer.md` and the manifest `NOTE:` in
  `planner/optimizer.ts` both asserted "no such case is known today". Both now state the gap
  explicitly, carry the repro, and name the new ticket. `docs/optimizer-rules.md` gained the
  same one-clause caveat.
- **Doc paragraph was orphaned.** The "registered in two passes" paragraph had ended up three
  paragraphs below the "Filter row estimates" text it belongs to, after two unrelated
  paragraphs about base-table estimates and module sizes — so "The rule is registered in two
  passes" read as if it described the access-path discussion above it. Moved back under its
  own heading text.

### Checked and found sound

- **Placement.** `filter-selectivity-restamp` is genuinely the first `PassId.PostOptimization`
  entry in `RULE_MANIFEST` (line 917, ahead of `monotonic-merge-join` at 936). `phase` is inert
  today (`framework/context.ts` documents it as always `'rewrite'`), so registration order is
  the real contract and the entry honours it.
- **Cost claim.** The `selectivity !== undefined` guard is the rule's first statement, ahead of
  the O(subtree) `collectColumnOrigins` walk, so a surviving stamp really does cost O(1). One
  caveat the handoff missed is recorded below.
- **Test isolation.** The negative-control test mutates `db.optimizer.tuning`, which would be
  a cross-test contamination hazard if the optimizer were shared — it is not (`Database`
  constructs its own `new Optimizer(DEFAULT_TUNING)`, and `updateTuning` replaces the tuning
  reference rather than mutating `DEFAULT_TUNING`, with a fresh `Set` for `disabledRules`), and
  each test in that block gets a fresh `Database` from `beforeEach`.
- **Ordering-dependence.** The comment claims first-placement matters so `filter-conjunct-ordering`
  sees a stamped Filter. Tracing it: even reversed, the fixpoint loop would re-stamp the
  reordered Filter, and conjunct-ordering ranks by per-conjunct estimates rather than by the
  Filter's stamp — so the placement is a robustness choice, not a correctness requirement. The
  comment says exactly that ("rather than relying on `applyPassRules`' fixpoint loop"), so it is
  not overclaiming.
- **Re-derivation at PostOptimization time.** By then the source may be a physical join.
  `collectColumnOrigins` keys on `TableReferenceNode` / `CTEReferenceNode` and recurses
  generically, so a lowered source attributes identically; a shape it cannot read declines to
  `undefined` (the old behaviour), never a wrong number.
- **Docs sweep.** Every doc mentioning `filter-selectivity` was read (`docs/optimizer.md`,
  `docs/optimizer-rules.md` — grep finds no others) and now matches the code.

### Tripwire recorded, not filed

- **Third origin walk on permanently-unstampable Filters.** The handoff costed the second
  registration as "one declined call per Filter that kept a stamp". True for stamped Filters,
  but a Filter that can *never* be stamped (computed projection, set-operation output,
  un-analyzed table) cannot short-circuit, so it pays the full `collectColumnOrigins` walk a
  third time per plan (Physical, re-stamp, conjunct-ordering). Magnitude unmeasured; the
  existing `NOTE:` in `rule-filter-selectivity.ts` already carries the memoization fix, and this
  case is now named in that same `NOTE:` rather than filed as a ticket.

### Empty categories

- **No test was weakened, skipped, or removed**, and no pre-existing failure was papered over —
  there were none left to paper over by the time this pass ran.
- **No resource-cleanup, error-handling, or type-safety findings.** The rule allocates nothing,
  holds no handles, and neither the rule nor the spec introduces `any` — the spec's
  `db as unknown as {...}` casts to reach `getPlan` / `_buildPlan` match the pattern already
  used throughout that file.
- **No source-hygiene findings.** `rule-filter-selectivity.ts` is 197 lines (`wc -l`) with a
  56-line rationale header, and `filter-selectivity.spec.ts` is 1139 lines; both are within the
  norm this package already sets for rule files and their subject-cohesive specs, and neither
  is near a size that would warrant a split ticket.
