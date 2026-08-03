---
description: Nothing in the test suite checks that a query operator hands back its result columns in the same order it told the rest of the engine to expect, so an operator can quietly reorder its output and only some queries notice.
prereq: bug-hash-join-side-swap-keeps-logical-attribute-order
files:
  - packages/quereus/test/property.spec.ts                       # Key Soundness tiers — the model for a per-node walk
  - packages/quereus/src/util/row-descriptor.ts                  # buildRowDescriptor — the attr-id → column-index map every consumer uses
  - packages/quereus/src/runtime/emit/bloom-join.ts
  - packages/quereus/src/runtime/emit/merge-join.ts
  - packages/quereus/src/runtime/emit/fanout-lookup-join.ts
  - packages/quereus/src/runtime/emit/async-gather.ts
  - packages/quereus/src/runtime/emit/hash-aggregate.ts
---

# No test asserts a physical node's emitted row matches the attributes it advertises

Consumers convert an attribute id into a column index by walking a child's
`getAttributes()` (`buildRowDescriptor`), then index straight into the row array the
child yields. That only works if every relational node emits its columns in exactly the
order it advertises. Nothing checks it.

The hash-join build/probe swap violated the contract for an unknown number of releases
and the suite stayed green (see `bug-hash-join-side-swap-keeps-logical-attribute-order`),
because the two consumer styles disagree about how much they notice:

- operators that read through the per-side row **slots** an emitter installs are
  correct even when the parent's advertised order is wrong — a plain `select` over the
  broken join returned correct rows;
- operators that build their **own** descriptor over `source.getAttributes()` and index
  the child's row array positionally — `emitHashAggregate` is one — read the wrong
  column and return wrong values with no error.

So the failure surfaces only through the second style, and only when a cost decision
happens to take the reordering branch.

## What a guard would look like

The Key Soundness property test (`test/property.spec.ts`) already walks every relational
node of an optimized plan, materializes each in isolation, and asserts a property about
that node's own rows. The same walk supports this invariant: for each physical
relational node, assert `row.length === node.getAttributes().length`, and that a value
read at the index `buildRowDescriptor(node.getAttributes())` assigns to an attribute is
the value that attribute's own producing subtree yields — i.e. the advertised order and
the emitted order name the same columns. `getType().columns` should be reconciled in the
same assertion: on a swapped hash join it disagreed with `getAttributes()` as well.

Nodes that legitimately reorder (a swapped hash join, if the fix keeps the swap and
re-derives the attribute order) must satisfy the invariant *after* re-derivation, so the
guard is what makes such a rewrite safe to attempt rather than a source of silent
corruption.

## Why this is filed separately

The immediate defect is one rule keeping a stale attribute order, and its regression
test belongs with the fix. This ticket is the cross-cutting guard over every physical
relational emitter — a different size of work, and one worth doing once the fix has
settled which direction the hash join reconciles.
