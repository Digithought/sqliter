description: The document that catalogs the query planner's rewrite rules has hit its size limit, so the next person who adds a rule cannot document it without first deleting something else — it needs to be split into two documents.
files: docs/optimizer-rules.md, docs/optimizer.md, docs/.doc-budget.json, scripts/check-docs.mjs, docs/doc-conventions.md
difficulty: easy

## Problem

`docs/optimizer-rules.md` is checked by `scripts/check-docs.mjs`, which enforces a
12,000-word cap on any doc that is not individually exempted in
`docs/.doc-budget.json`. The file currently measures 11,998 words — two words of
headroom.

The last rule to land (`filter-conjunct-ordering`) could only add its one-line
catalog entry by deleting explanatory text from three unrelated entries (the
retired IN-subquery cache, the materialization advisory, and constant folding).
That trade is not repeatable: the next rule author has nothing left to trim that
is not load-bearing, and the only escape hatches are to exempt the doc from the
cap (which defeats the check) or to split it — under time pressure, in the middle
of unrelated work.

The doc itself already carries a note naming the intended split point, so the
decision is made; what is missing is someone doing it before it blocks a ticket.

## What "split" means here

The file has two distinct halves:

1. **The catalog** — a flat list of every rewrite rule, grouped by the
   subdirectory it lives in under `packages/quereus/src/planner/rules/`
   (access, aggregate, cache, distinct, join, predicate, retrieve, subquery).
   This is a lookup table; readers arrive knowing a rule name and wanting one
   sentence about it.
2. **The deep-dives** — long prose sections below the catalog explaining
   specific rule families in detail (materialized-view read-side rewrite,
   sargable range rewrites, predicate contradiction detection, empty-relation
   folding, inclusion-dependency reasoning, and the cardinality material).
   These are read start-to-finish by someone changing that family.

The deep-dives are what make the file large, and they are not what a reader
skimming the catalog wants. Moving them into their own topic doc leaves the
catalog small enough to grow for a long time.

## Expected outcome

- Two docs, each comfortably under the cap, with the catalog entries still
  one-line and still grouped by rules subdirectory.
- Every inbound link that currently points at a moved section still resolves —
  `scripts/check-docs.mjs` verifies links, so a broken anchor fails the build.
  `docs/optimizer.md` is the main hub and links here in several places.
- The stale note at the top of `docs/optimizer-rules.md` (the one instructing a
  future author to split) is removed once the split exists.
- No content is deleted as part of this work. If something genuinely reads as
  obsolete, that is a separate judgement call and should be raised rather than
  folded into a mechanical move.
- `node scripts/check-docs.mjs` passes without adding either doc to the ratchet
  in `docs/.doc-budget.json`.

## Out of scope

Rewriting or condensing the deep-dive prose. This is a move, not an edit pass.
