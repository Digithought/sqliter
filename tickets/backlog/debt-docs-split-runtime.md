---
description: The runtime documentation file has grown to within a few words of the size limit the project enforces, so the next person who adds a paragraph to it will have their build rejected.
files:
  - docs/runtime.md
  - scripts/check-docs.mjs
  - docs/doc-conventions.md
difficulty: medium
tradeoffs: Splitting a doc costs every existing inbound link a redirect or an edit, and a maintainer may reasonably prefer to raise the cap or record a ratchet for this one file instead — the cap is a convention, not a correctness property.
---

# The situation

`scripts/check-docs.mjs` enforces a 12000-word cap on any documentation file that has
not been given an explicit recorded size ("ratcheted"). `docs/runtime.md` is currently
**11995 words** — five words under. The check passes today, but it emits its near-cap
notice:

```
docs/runtime.md: 11995 words, 5 from the 12000-word cap — the cap has no grace band,
so split before the next section lands
```

The cap has no grace band, so the next contributor who adds anything at all to this
file gets a hard build failure and has to choose between splitting the doc themselves
(mid-task, unrelated to whatever they were doing) or force-recording a ratchet to get
unblocked. Neither is a decision that should be forced on someone by surprise.

This is not a new condition — the file was 392 words from the cap before the per-table
work-counter section landed, already inside the notice band. That section was trimmed
to fit rather than force-ratcheting, which is what makes the margin this thin.

# What a fix looks like

`docs/runtime.md` covers the whole runtime: the scheduler and instruction model, the
emitter contract, context and row descriptors, caching, scalar fusion, parallelism, and
the work-counter surface. Several of those already have their own sibling documents
(`runtime-caching.md`, `runtime-parallel.md`), so there is an established split pattern
to follow — the repo has done this before (see the completed `docs-split-*` tickets for
optimizer costing, SQL DDL, sync protocol, and isolation design).

The judgement call is where the seam goes, and that is the substance of the work. Two
constraints on any answer:

- Every inbound link must still resolve — `check-docs.mjs` validates links, and
  `docs/usage.md`, `docs/architecture.md` and several source comments deep-link into
  `runtime.md` by anchor, including
  `#work-counters-machine-independent-execution-counts`.
- Whatever stays in `runtime.md` should leave real headroom, not land at 11900.

The alternative — recording a ratchet for this file and letting it keep growing — is a
legitimate outcome if a maintainer decides the runtime doc is genuinely one topic. That
is a decision, not a default; making it deliberately is the point of this ticket.
