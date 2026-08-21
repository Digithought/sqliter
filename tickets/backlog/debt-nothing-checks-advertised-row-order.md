description: Query plan steps each publish a claim about what order their rows come out in, and the optimizer trusts those claims to skip work — but nothing checks a claim is true, so a wrong one silently returns wrong answers. Add a check that catches wrong claims.
files:
  - packages/quereus/src/planner/validation/plan-validator.ts        # today's only ordering check — bounds only
  - packages/quereus/src/planner/nodes/aggregate-node.ts             # line ~313: known wrong claim (see below)
  - packages/quereus/src/planner/nodes/window-node.ts                # the instance that motivated this, now fixed
  - packages/quereus/src/planner/nodes/plan-node.ts                  # `PhysicalProperties.ordering` / `monotonicOn`
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The one reachable instance has been fixed and the remaining one is unreachable today, so a maintainer could reasonably rank a guard against a hypothetical future regression below feature work — especially since a runtime-checked variant costs time on every debug-mode test run.
----

## What is wrong

Every plan node publishes `physical.ordering` — "my rows come out sorted like
this" — and the optimizer acts on it: a merge join, for instance, is only legal
because both of its inputs claim to arrive in the join key's order. Nothing
verifies the claim. A node that reorders its rows but keeps relaying its input's
claim produces no error, no warning, and a wrong answer.

That is not hypothetical. `bug-window-node-advertises-source-row-order` (fixed,
see `tickets/complete/`) was exactly this: a window that sorted its own rows kept
advertising the source's order, and the merge join above it stopped matching
after the first row — three of four rows vanished with no error raised.

The only guard that exists is `plan-validator.ts`'s `validateOrdering`, and it
checks one thing: that each claimed column index is within the node's column
count. A claim can be entirely fictional and still pass.

## The second instance, found while reviewing the first

`AggregateNode.computePhysical` (the logical `GROUP BY` node) relays
`ordering: sourcePhysical?.ordering` unchanged. Two things are wrong with that:

- A grouped aggregate collapses rows; the surviving rows are not in the input's
  order in general.
- Worse, the indices are meaningless. The claim's `column` numbers are positions
  in the *input* row, but `AggregateNode`'s output row is `[GROUP BY columns...,
  aggregate columns...]` — a different column space entirely. Column 4 of the
  input is not column 4 of the output; it may not exist in the output at all.

Its two physical counterparts get this right: `HashAggregateNode` advertises no
ordering, and `StreamAggregateNode` advertises the GROUP BY column positions in
its own output space.

**This is dormant, not reachable today.** The logical `AggregateNode` has no
runtime emitter (`runtime/register.ts` explicitly leaves it unregistered), so it
is always replaced by a hash or stream aggregate before execution, and the
optimizer visits children before parents — so by the time any rule reads a
child's ordering, the aggregate below it has already been physicalized. What
would confirm reachability: a rule that inspects `physical.ordering` on a node
whose `AggregateNode` child has not been rewritten yet. None does today. A future
rule that runs earlier, or a pre-pass that reads physical properties, makes it
reachable — and it would fail silently the same way the window bug did.

## What is wanted

A guard that makes a false ordering claim *fail loudly* instead of returning
wrong rows. Two shapes are worth weighing; they catch different things and are
not mutually exclusive:

- **Static, at plan-validation time.** Reject an unchanged relay of a source's
  ordering by a node whose output columns are not the source's columns in the
  same positions. This catches the `AggregateNode` case above (and any future
  node that reshapes its row and forwards its input's claim), including dormant
  ones that never execute.
- **Runtime, under a debug/validation flag.** Wrap any node advertising an
  ordering and assert each emitted row is not "before" its predecessor under the
  claimed order, failing with the node's identity. Run over the existing
  `test/logic/*.sqllogic` corpus, this checks every claim any real query relies
  on — which is what would have caught the window bug at the moment it was
  introduced. It cannot see nodes that never execute.

Success criterion either way: reintroducing the window bug (relay the source's
ordering from a buffered, sorted `WindowNode`) must produce a diagnostic naming
the offending node, not a short result set.

The same argument applies to `monotonicOn`, which is documented as the stronger
claim and drives the same family of rules; whether the guard covers both or only
`ordering` first is an open call for whoever picks this up.

## Third instance: the same alignment algorithm, written twice, in two packages

Found while reviewing `feat-store-index-seek-ordering`, which gave the persistent-storage
backend's secondary-index plans the ability to say "these rows already arrive sorted".

That claim is decided by a small pointer-walk that lines an index's declared column order
up against what the query asked for, skipping columns the seek has already pinned to a
single value. There are now **two independent copies** of that walk:

- `MemoryTableModule.indexSatisfiesOrdering` (`packages/quereus/src/vtab/memory/module.ts`,
  ~line 1023) — over an `IndexSchema`.
- `indexOrderingSatisfies` (`packages/quereus-store/src/common/store-module-access-plan.ts`,
  end of file) — over `OrderingSpec[]`.

They agree today, deliberately and by hand: the store version's comment says it mirrors
the memory one, and it carries a branch that is unreachable from its own caller purely to
keep the two shapes identical. That is the whole problem — the only thing holding them in
step is a comment. Either copy drifting produces a plan that elides a `Sort` it needed,
which is the exact failure mode this ticket exists to catch, in the backend where it is
hardest to notice (the store's own test suite is the only place it runs).

Two ways to take it, and they compose rather than compete:

- **The runtime check this ticket already proposes** covers it directly and needs no
  refactor: run the ordering assertion over the store suite and a divergence in either
  copy fails at the row that breaks the order, naming the plan.
- **One shared implementation**, which retires the class rather than detecting it. The
  store version's `OrderingSpec[]` signature is the more general of the two — it takes the
  ordering as data instead of as a schema — so the direction is to lift it into
  `packages/quereus` beside `OrderingSpec` in `src/vtab/best-access-plan.ts` and have the
  memory module map its `IndexSchema` into that call. The store already depends on
  `@quereus/quereus`, so the dependency direction works.

Worth noting that the ordering claims themselves keep multiplying — the store gained
secondary-index claims here, and `feat-store-secondary-index-monotonic-advertisement`
queues up the stronger `monotonicOn` version over the same walks. Each new claim is
another producer this ticket's guard would have to cover, and another chance for a
hand-mirrored copy to drift.
