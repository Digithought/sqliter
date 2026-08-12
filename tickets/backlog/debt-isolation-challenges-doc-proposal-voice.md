---
description: A design note about the transaction isolation layer describes four of its six topics as things somebody intends to do, not as what the shipped code does, so a reader cannot tell built behaviour from the original wish list.
files:
  - docs/design-isolation-challenges.md              # the four sections written in proposal voice
  - docs/design-isolation-layer.md                   # hub; § Overlay Module Selection is the reference for § 5
  - packages/quereus-isolation/src/merge-iterator.ts # the reality behind § 1
  - packages/quereus-isolation/src/isolated-table.ts # the read fast paths behind § 2 and § 4
  - packages/quereus-isolation/test/merge-iterator.spec.ts
difficulty: medium
tradeoffs: This is a documentation-accuracy fix with no user-visible effect, the sections are short enough that a reader who also reads the hub will not be badly misled, and rewriting them means re-deriving four behaviours from source — work a maintainer may prefer to spend on the isolation layer's open correctness tickets instead.
---

# The problem

`docs/design-isolation-challenges.md` is six numbered sections, each a `**Challenge:**` paragraph
followed by a `**Mitigation:**` block. Two of the six (§ 3 Commit Failure Recovery, § 6 Schema
Operations) have been rewritten over time into present-tense descriptions of shipped code, naming
real functions and real invariants. The other four are still the original design sketch: bullet
lists of things the author intended to do, with no way for a reader to tell which of them
happened.

`docs/doc-conventions.md` names exactly this failure mode — "A doc describing an unimplemented
capability is indistinguishable, to a reader, from a doc that has drifted."

## What is actually wrong, per section

| Section | State |
| --- | --- |
| § 1 Merge Iteration Complexity | Mixed. The standalone `MergeIterator` it proposes exists (`packages/quereus-isolation/src/merge-iterator.ts`, with `test/merge-iterator.spec.ts`). "Use property-based testing (fast-check)" did not happen — `fast-check` is not a dependency of the package. |
| § 2 Cursor Invalidation During Mutation | Proposal voice throughout, including a bullet that is an instruction to a future author rather than a fact: "Document behavior based on overlay module's capabilities". |
| § 4 Performance Overhead | Mixed, and the mix is invisible. Its first two bullets (empty-overlay delegation, a has-changes flag) describe the shipped fast path at `isolated-table.ts:417-422`. Its third — "For point lookups: check overlay first (O(log n)), only hit underlying if not found" — is a read-path claim that was not verified against the code when this was filed. |
| § 5 Large Transaction Storage | Proposal voice. Whether a persistent overlay module can in fact be configured is answered by the hub's § Overlay Module Selection, and this section does not say. |

## Expected outcome

Each of those four sections says what the layer does today, in the same voice § 3 and § 6 already
use. Anything still unbuilt either leaves `docs/` (per `docs/doc-conventions.md`, the home for
unimplemented work is `docs/todo.md` or a ticket) or is labelled unambiguously as not built.

The `**Challenge:** / **Mitigation:**` framing itself is worth reconsidering while doing this: it
reads as a design-review artifact, and § 3 and § 6 already abandoned it in favour of prose that
states the mechanism.

## How this got here

The doc was created by the `docs-split-isolation-design` ticket, which lifted the
`## Challenges and Mitigations` chapter out of `docs/design-isolation-layer.md` verbatim to get
that document under its size cap. Same ticket removed a neighbouring `## Optimization Strategies`
chapter from `docs/` entirely — on the grounds that it described unbuilt work — and preserved it
in `tickets/backlog/feat-isolation-overlay-fast-paths.md`. The rule was applied to one chapter and
not the other. Nothing was made worse by the move; the prose is as old as it was before. The
review pass for that split raised this rather than expanding a mechanical file split into a
four-section rewrite.
