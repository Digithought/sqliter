---
description: Adding a field to the engine's table-access plan nodes means hand-editing four separate copy-this-node helpers; forget one and the field is silently lost at runtime instead of failing to compile.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts
difficulty: medium
tradeoffs: Nothing is broken today, and the fix is a constructor-shape change across three node classes and eight clone sites - churn landing entirely on code that currently works.
---

# Physical access leaf nodes are cloned by re-listing positional constructor arguments

## What the shape is today

`IndexSeekNode` takes **13** positional constructor parameters, `IndexScanNode` **10**,
`SeqScanNode` **6** (measured by reading
`packages/quereus/src/planner/nodes/table-access-nodes.ts` at commit `bae2d740`). Every
trailing parameter is optional or has a default.

Four places clone one of these nodes by re-typing the whole argument list in order:

| Site | Purpose |
| --- | --- |
| `IndexSeekNode.withChildren` | re-mint after a child rewrite |
| `IndexSeekNode.withProvenance` | attach the recorded pushed predicate |
| `leafWithRangeBound` (`rule-monotonic-range-access.ts`) | attach `rangeBoundedOn` |
| `leafWithMonotonicSuppressed` (same file) | drop a monotonic advertisement |

The last two also each clone `IndexScanNode` and `SeqScanNode` the same way, so the real
count of hand-maintained argument lists across the three node classes is eight.

## Why this is a defect and not a style preference

Because every new field is optional with a default, a clone site that does not mention it
**compiles clean and silently produces a node with the field reset to its default**. There
is no type error, no lint error, and no test that would notice unless a test happens to
assert that specific field survived that specific rewrite.

This is not hypothetical. The change that added `orderingLoadBearing` and
`pushedConstraints` to `IndexSeekNode` (commit `bae2d740`) had to separately patch
`rule-monotonic-range-access.ts` because both of its clone helpers would otherwise have
dropped both new fields on any plan where a monotonic annotation fired — a wrong-answer
class of bug (`orderingLoadBearing` reset to `false` re-permits a rewrite that must
decline). It was caught only because the implementer went looking; nothing in the build or
the suite pointed at it.

The hazard grows with each field added, and fields are being added: `rangeBoundedOn`,
`suppressMonotonic`, `orderingLoadBearing`, and `pushedConstraints` are all recent.

## What "fixed" would look like

Any shape where adding a field to one of these nodes either (a) requires no edit at the
clone sites, or (b) fails to compile until every clone site is updated. Candidate
directions, not a decision:

- An options object for the non-identity parameters (everything after `filterInfo`), so a
  clone spreads the old options and overrides one key.
- A single generic `withOverrides(partial)` on each class replacing the four bespoke
  helpers, with the positional constructor kept private.
- Keeping the positional constructor but adding an exhaustiveness check the compiler can
  enforce.

The behaviour of every existing plan must be unchanged — this is a refactor with no
intended plan or result differences, so the golden-plan suite
(`packages/quereus/test/plan/golden-plans.spec.ts`) passing unmodified is the primary
signal that it landed correctly.

## Scope note

Only the physical access leaves in `table-access-nodes.ts` are in scope. Other plan nodes
in `planner/nodes/` have their own constructor shapes; whether the same treatment helps
them is a separate question and should not be bundled here.
