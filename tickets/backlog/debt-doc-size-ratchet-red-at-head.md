----
description: The documentation size check fails on the main branch — two documents are longer than the maximum length recorded for them — so the project's standard verification command stops at its first step for everyone, on every change.
files:
  - docs/sync.md (14,247 words; recorded maximum 13,797 — 450 over)
  - docs/schema.md (13,802 words; recorded maximum 13,459 — 343 over)
  - docs/.doc-budget.json (the register of per-document maximums)
  - scripts/check-docs.mjs (the check; `--update-ratchet` lowers an entry)
  - docs/doc-conventions.md (what belongs in a doc; how to lower an entry)
difficulty: medium
----

## What is wrong

Every document has a recorded maximum word count in `docs/.doc-budget.json`. The rule is
one-way: a document may shrink (and the recorded maximum then drops to match), but it may
never grow past what is recorded. `yarn docs:check` enforces this, and it is the **first**
step of `yarn check` — so while it fails, `yarn check` never reaches lint, build, typecheck
or tests.

Two documents are currently over:

```
docs/schema.md: 13802 words exceeds its ratchet of 13459 (+343)
docs/sync.md:   14247 words exceeds its ratchet of 13797 (+450)
```

Measured by running `node scripts/check-docs.mjs` from the repository root on a clean
checkout of `main`. Neither overrun belongs to any one change — both predate the tickets
that have been working in these files, and agents working in `docs/sync.md` have been
paying a hidden tax to stay word-neutral (offsetting each sentence they add by compressing
an unrelated one nearby), which is a poor way to decide what prose survives.

## What "done" looks like

Both documents back under their recorded maximums, with the recorded maximums lowered to
match (`node scripts/check-docs.mjs --update-ratchet`), and `yarn docs:check` green.

The 793 words have to come out of genuine redundancy, not out of load-bearing detail.
`docs/sync.md` in particular has several places where one fact is stated in the prose, again
in an embedded code comment, and again in a summary list — those restatements are the
target, not the explanations. If it turns out the content is all load-bearing and the
documents genuinely need to be that long, the alternative is splitting one of them along a
section boundary (`docs/lens.md` has an open decision of exactly this shape in
`blocked/debt-docs-split-lens-when-stable`); raising a recorded maximum is explicitly not an
option the convention allows.
