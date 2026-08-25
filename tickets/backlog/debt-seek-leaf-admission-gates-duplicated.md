---
description: Two optimizer rules each keep their own hand-written copy of the same safety checklist for reusing a storage lookup; a third rule could easily be written without one of the checks, and nothing would catch it.
files:
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                 # where the shared gate would live, next to peelToSeekableAccessLeaf
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # admitSeekLeaf (five gates)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts           # admitSeekLeaf (five gates, one of them checked differently)
  - packages/quereus/src/planner/rules/join/rule-semi-join-pushdown.ts        # second arm: the drained-once purity trio, hand-copied again
difficulty: medium
tradeoffs: The two copies are not identical — one checks correlation per recorded constraint, the other per subtree — so merging them means first deciding which check is correct for both, and a maintainer may reasonably prefer two clear, separately-documented gate lists over one shared helper with two behaviour flags.
---

# One shared admission gate for reusing an already-constrained storage lookup

## Background in plain terms

When the storage module can answer part of a `WHERE` clause itself, the planner hands the
predicate to the module and *removes it from the plan* — the module promised to enforce
it. The plan node that remains (`IndexSeekNode`) records what it is now solely responsible
for, in a field called `pushedConstraints`.

Any later rewrite that wants to replace that node has to deal with that promise, or the
predicate simply vanishes and the query returns extra rows. Two rules do this today:

- `rules/join/index-nested-loop.ts` — combines the promise with a join lookup.
- `rules/access/rule-key-set-seek.ts` — replaces the node with a set-membership lookup.

## The problem

Each rule has its own private function named `admitSeekLeaf`, and each hand-writes the
same five checks:

| Check | Why it exists |
| --- | --- |
| no pushed `limit` / `offset` | a row cap cannot be re-applied by a filter without changing which rows are dropped |
| `pushedConstraints` is non-empty | a promise the rule cannot read is a promise it cannot honour |
| emission order is not load-bearing | a sort was dropped because this node emitted in the right order |
| the recorded predicate holds no subquery | both rules run in the last optimizer pass, so anything re-inserted gets no further pass and would reach execution unprepared |
| the node is not itself somebody's per-outer-row lookup | re-planning it would re-plan their correlation |

Nothing enforces that a *third* rule which peels to one of these nodes applies any of
them. `peelToSeekableAccessLeaf` — the shared helper that finds the node — hands it back
with only a doc comment saying the caller must cope. A rule author who reads the comment
and re-applies the predicate, but forgets the limit check or the subquery check, gets a
clean compile, a clean lint, and a wrong plan.

## What "fixed" looks like

The gate set moves next to `peelToSeekableAccessLeaf` in
`rules/shared/access-leaf.ts`, so the only supported way to obtain a constrained leaf is
one that has already passed it. Sketch:

```ts
/** A constrained seek leaf that passed every re-plan safety gate, plus what it enforces. */
interface AdmittedSeekLeaf {
	readonly leaf: IndexSeekNode;
	readonly pushed: readonly PredicateConstraint[];
}

function admitSeekLeafForReplan(leaf: IndexSeekNode): AdmittedSeekLeaf | null;
```

Each rule then keeps only the gates that are genuinely its own (`rule-key-set-seek` also
needs the recorded predicate to combine into a single expression; `index-nested-loop`
does not).

## The one real decision this needs

The two copies disagree on how to detect "this node is already somebody's per-outer-row
lookup":

- `index-nested-loop` asks whether any **recorded constraint** carries `correlated: true`.
- `rule-key-set-seek` asks whether the **node's subtree** is correlated.

They agree today only because the one place that writes `pushedConstraints`
(`stampSeekProvenance` in `rule-select-access-path.ts`) records every constraint the seek
consumed, so a correlated lookup always has a correlated constraint recorded. A shared
helper should use the stronger of the two — read both, decide which, and say why in the
implementation. There is a `NOTE:` at the `index-nested-loop` site recording this.

## Not in scope

Changing what any gate decides. This is a consolidation: every plan the two rules produce
or decline today must be unchanged afterwards, with the existing gate tests in
`test/optimizer/index-nested-loop.spec.ts` and the `rule-key-set-seek` specs passing
unmodified.

## Second arm: the "may this relation be drained exactly once" checklist

Found while reviewing `1-bug-key-set-seek-declines-when-probe-is-join`. The same
copy-the-checklist pattern shows up a second time, over a different set of checks, so it
belongs with this ticket rather than in one of its own.

Before a rule may move or re-root the sub-query that supplies an `IN (SELECT …)` key set,
it has to establish that the sub-query can be run exactly once — it must not read the row
being tested, must return the same rows every time, and must not write anything. Three
sites hand-write that same trio:

- `rules/access/rule-key-set-seek.ts` — inside `admitJoin`.
- `rules/join/rule-semi-join-pushdown.ts` — inline, with a comment saying it mirrors the
  above "one-for-one".
- the runtime set-probe / decorrelation path, which the comments at both sites cite as the
  original.

A fourth rule that forgets one of the three compiles clean and produces a wrong plan.
Same fix shape as the arm above: one named predicate (`isDrainableOnce(relation)` or
similar) that the sites call, keeping only their own extra gates locally. The two arms
share a fix *style* but not a location, so they can land separately.
