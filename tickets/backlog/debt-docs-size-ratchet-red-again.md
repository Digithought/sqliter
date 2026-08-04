description: The documentation size check is failing on the main branch again — two design documents have grown past the maximum length recorded for them — and because that check runs first, it blocks the project's standard verification command before anything else runs.
files:
  - docs/sync.md                # 13,544 words vs. its recorded 12,538
  - docs/schema.md              # 13,000 words vs. its recorded 12,109
  - docs/.doc-budget.json       # where the per-document limits live
  - docs/doc-conventions.md     # "The size ratchet" explains the rule
  - scripts/check-docs.mjs      # the checker (`yarn docs:check`)
difficulty: medium
----

## What is failing

`yarn docs:check` (equivalently `node scripts/check-docs.mjs`), the first step of
`yarn check`, exits non-zero:

```
docs/schema.md: 13000 words exceeds its ratchet of 12109 by 891, past the 500-word grace band
docs/sync.md:  13544 words exceeds its ratchet of 12538 by 1006, past the 500-word grace band
```

Every step after it in `yarn check` (lint, build, typecheck, tests) is therefore never
reached by that command. They pass when run individually.

## Why this is not new

Both documents were already over budget before the most recent work touched them —
measured on the commit prior to `feat-sync-client-snapshot-bootstrap`
(`git show 51bf7c14^:docs/sync.md | wc -w` → 13,158, i.e. 620 over; `docs/schema.md`
unchanged at 13,000). `tickets/.pre-existing-known.md` maps this failure to
`debt-doc-size-ratchet-red-at-head`, but that ticket has been completed, and so has an
earlier one (`docs-megadoc-ratchet-overage`) that trimmed the same documents. The entry
in the registry now points at finished work, so the failure is untracked again — which
is why this ticket exists.

This is the third round of the same cycle: a document is trimmed or split back under its
limit, then each feature that lands adds a section to it and it drifts back over. Two
passes of "shrink the prose" have not held.

## What to decide

The shrink-it-again route is known to work and known not to last. Worth considering
instead, and this is a judgement call for whoever picks it up:

- Split by audience or lifecycle rather than by size, so new feature sections have an
  obvious home that is not the main design document.
- Decide where a feature's design prose is *supposed* to live (design doc vs. package
  README vs. code comments), and say so in `docs/doc-conventions.md`, so the next
  feature's documentation does not default to the biggest file.
- If the recorded limits are simply wrong for documents of this scope, raise them
  deliberately (`--update-ratchet --force`, with the reason in the commit message)
  rather than leaving the gate red — a permanently-red gate teaches everyone to ignore
  it, which is worse than a limit that is too generous.

Whatever route is taken, finish with `yarn docs:check` green and the stale
`tickets/.pre-existing-known.md` entry updated or removed.
