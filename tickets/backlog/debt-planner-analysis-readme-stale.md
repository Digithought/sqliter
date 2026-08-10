---
description: A README that is supposed to introduce a folder of about thirty query-analysis modules actually describes only one old feature, so anyone opening it gets a misleading picture of what lives there.
files:
  - packages/quereus/src/planner/analysis/README.md   # the stale file
  - docs/architecture.md                              # where the real orientation lives
difficulty: easy
tradeoffs: A single stale README a reader can route around via docs/architecture.md, and deleting the file may beat maintaining a second orientation document alongside it.
---

# The analysis folder's README describes only constant folding

## What a reader sees today

`packages/quereus/src/planner/analysis/README.md` opens with the title
"Constant Folding Implementation" and a "## Files" section listing three entries:
`const-pass.ts`, `const-evaluator.ts`, and `constraint-extractor.ts`. The folder it
sits in currently holds around thirty modules — predicate normalization, conjunct
splitting, predicate dependencies, binding extraction, key filtering, coverage
proving, collation comparison, and more. None of those are mentioned.

The README also carries a "## Current Status" checklist with in-progress markers
that date from when constant folding was being built.

## Why it matters

It is the first file an agent or a newcomer opens when asked "what is in
`planner/analysis`?", and it answers a much narrower question than the one asked —
while looking authoritative. A reader can reasonably conclude the folder is the
constant-folding implementation and go looking elsewhere for predicate analysis,
which is also here.

## What "done" looks like

Either outcome is acceptable; the choice is a judgement call for whoever picks
this up:

- Rewrite it as a genuine orientation to the folder — what kind of module belongs
  here (read-only analysis over plan trees, no rewriting), and pointers to the
  deeper topic docs in `docs/` rather than a per-file list that will rot again.
- Or delete it and let `docs/architecture.md` be the single entry point, moving
  anything still true about constant folding into `docs/optimizer-const.md`.

The per-file inventory style is what rotted; whatever replaces it should not
re-create a list that has to be edited every time a module is added.

## Not in scope

The content of the analysis modules themselves. This is purely about the
orientation text.
