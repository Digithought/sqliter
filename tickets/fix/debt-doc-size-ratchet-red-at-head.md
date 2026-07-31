----
description: The documentation size check fails on the main branch — three documents are longer than the maximum length recorded for them — so the project's standard verification command stops at its first step for everyone, on every change.
files:
  - docs/sync.md (14,477 words; recorded maximum 13,797 — 680 over)
  - docs/schema.md (13,802 words; recorded maximum 13,459 — 343 over)
  - docs/module-authoring.md (12,441 words against the 12,000 cap for a document with no recorded maximum — 441 over)
  - docs/.doc-budget.json (the register of per-document maximums)
  - docs/.stability.json (every doc must be classified; a new split-out doc needs an entry plus a banner)
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

Three documents are currently over:

```
docs/module-authoring.md: 12441 words exceeds the 12000-word cap for an unratcheted doc (+441)
docs/schema.md:           13802 words exceeds its ratchet of 13459 (+343)
docs/sync.md:             14477 words exceeds its ratchet of 13797 (+680)
```

Measured by running `node scripts/check-docs.mjs` (`yarn docs:check`) from the repository
root at HEAD `27549443` with a clean working tree. The link/anchor and invariant halves of
the check pass; these three word-count overruns are the only failures.

`docs/module-authoring.md` is a different case from the other two: it has **no** entry in
`docs/.doc-budget.json`, so it is measured against the global 12,000-word cap for a document
that was never grandfathered in. It crossed that line after this ticket was first written,
which means it was never grandfathered and cannot be — the only way out is to make it
shorter or to split it. Neither overrun belongs to any one change: all three grew a few
hundred words at a time across many unrelated bug tickets, because those passes run
`yarn test` / `yarn lint` rather than the full `yarn check`, so nothing told them the
budget was already red. Agents working in `docs/sync.md` have been paying a hidden tax to
stay word-neutral (offsetting each sentence they add by compressing an unrelated one
nearby), which is a poor way to decide what prose survives.

## How each document drifted

Per-commit word counts (`git log --format=%h -- <doc>` then
`git show <hash>:<doc> | wc -w`):

- `docs/schema.md` was cut to exactly its ratchet of 13,459 by the earlier doc-split pass
  (commit `586da8c9`, which relocated ~250 lines of store detail into `docs/store.md` and
  ~195 into a new `docs/sql-alter.md`). It has since grown back to 13,802, almost entirely
  inside `### View and materialized-view persistence` (now 1,944 words) — store-persistence
  detail landing in `schema.md` again, the same content class that pass moved out.
- `docs/sync.md` climbed 13,797 → 14,477 across the `bug-sync-*` and
  `bug-update-event-key-disagrees-across-producers` series, spread thinly over
  `### Transaction-Based Change Grouping` (2,045 words) and `### Unknown-Table Disposition`
  (1,954).
- `docs/module-authoring.md` crossed 12,000 during `debt-store-analyze-row-count` and
  `bug-update-event-key-disagrees-across-producers`, which added normative module
  obligations (row-count claims, `onRegister`, event key/relocation rules).

The added prose is normative module/engine contract, not narrative history — so the fix is
not "delete the recent additions."

## Section sizes, for choosing seams

Measured by summing whitespace tokens between headings:

| Doc | Largest sections (words) |
| --- | --- |
| `docs/sync.md` | `## Core Concepts` 6,830 · `## Sync Protocol` 2,663 · `## Schema Synchronization` 1,454 · `## Schema Seed: App Provider as Sync Peer` 551 |
| `docs/schema.md` | `## Declarative Schema` 6,061 (of which `### Rename Detection` 4,383) · `## SchemaManager API` 5,570 (of which `### View and materialized-view persistence` 1,944) |
| `docs/module-authoring.md` | `## Module Capability APIs` 2,689 · `## Capability negotiation surface` 2,650 · `` ## Schema Changes (`SchemaChangeInfo`) `` 2,244 · `## Transaction Support` 1,702 |

## What "done" looks like

All three documents back under their limits — the ratcheted two with their recorded maximums
lowered to match (`node scripts/check-docs.mjs --update-ratchet`), `docs/module-authoring.md`
under the 12,000-word cap — and `yarn docs:check` green.

The words have to come out of genuine redundancy or a split, not out of load-bearing detail.
`docs/sync.md` in particular has places where one fact is stated in the prose, again in an
embedded code comment, and again in a summary list — those restatements are the target, not
the explanations. Where the content is all load-bearing (which a first pass over
`### Transaction-Based Change Grouping` suggests it is), split along a section boundary
instead. Raising a recorded maximum is explicitly not an option the convention allows,
except via `--update-ratchet --force` with the justification in the commit message, which
should be treated as a last resort here and not as the plan.

## Design constraints

- **Never raise a ratchet silently.** `--update-ratchet` only ever lowers; `--force` raises
  and requires a commit-message line saying why. Do not reach for `--force` to close this
  ticket without stating the justification.
- **Do not touch `docs/lens.md`.** Its oversize is a deliberate, human-owned exemption —
  see `blocked/debt-docs-split-lens-when-stable`. Splitting it is not part of this ticket.
- **A split-out doc must be classified before the build goes green.** Add it to
  `docs/.stability.json` — either under `docs` with a tier plus a matching
  `> **Stability: <Tier>** — see [Stability Tiers](stability.md#tiers).` banner directly
  under the H1, or under `untiered` with no banner. There is no `--update-stability`.
- **Repoint every inbound anchor.** `scripts/check-docs.mjs` fails on a dead anchor, and it
  checks `docs/*.md` links *and* the `docs/<file>.md § …` markers in `packages/*/src`
  comments. Moving a heading means finding its references first.
- **Don't relocate the overrun into another doc's headroom without checking.**
  `docs/store.md` is 10,042 words and `docs/usage.md` 9,795 against the 12,000 cap — both
  have room, but neither has 2,000 words of it.
- **Invariants belong in the register.** Per `docs/doc-conventions.md`, a design doc split
  is the moment to lift normative statements into `docs/invariants.md` with a back-link
  (full heading slug, em dash slugifies to a double hyphen) rather than restating them.
  `SYNC` and `SCH` areas already exist; follow the existing entry shape, one `guard:` line
  each.

No cross-cutting engine obligation is triggered: this is documentation only — no
determinism edition bump, no byte-format vector, no golden fixture, no migration.

## Why this is in `fix/` and not `backlog/`

It was filed to `backlog/` earlier and stayed there while the overruns grew (sync.md +450 →
+680, module-authoring +226 → +441). It is a reproducible failure of a check that gates
every other check in `yarn check`, so it belongs in the top-priority stage.
