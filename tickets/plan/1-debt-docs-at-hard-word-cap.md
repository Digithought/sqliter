---
description: Three design documents have grown to within a few hundred words of the maximum length the documentation checker allows, and one of them has 23 words of room left — so the next person who adds a paragraph to any of them turns the whole pre-release gate red.
files:
  - docs/optimizer.md              # 11977 words — 23 from the cap
  - docs/design-isolation-layer.md # 11873 words — 127 from the cap
  - docs/sql-ddl.md                # 11750 words — 250 from the cap
  - scripts/check-docs.mjs         # the gate; `--update-ratchet --force` is the escape hatch
  - docs/doc-conventions.md        # the split recipe, the cap, and the ratchet
  - docs/invariants.md             # design-doc splits add an invariant area
difficulty: medium
---

*Filed as `debt-store-and-module-authoring-docs-at-word-cap`. Both documents in that name were
resolved by the pre-existing-failure triage on 2026-08-11 (`f6d72746`), which split them into
`docs/module-committed-reads.md` and `docs/store-catalog-persistence.md`. The ticket is renamed
and rescoped to the three documents still in the squeeze.*

## What is happening

`yarn docs:check` enforces a 12,000-word cap on any document that has not had a larger size
recorded for it in `docs/.doc-budget.json`. **The cap has no grace band** — a document one word
over fails, and `docs:check` is the first step of `yarn check`, so the whole pre-release gate goes
red with it.

Three documents sit inside that boundary today (`node scripts/check-docs.mjs`, at `2414807c`):

```
docs/design-isolation-layer.md: 11873 words, 127 from the 12000-word cap
docs/optimizer.md:              11977 words,  23 from the 12000-word cap
docs/sql-ddl.md:                11750 words, 250 from the 12000-word cap
```

Twenty-three words is roughly one sentence. `docs/optimizer.md` is the document every new
optimizer rule is supposed to be recorded in, so the document most likely to need a paragraph is
the one with the least room for it.

## Why it is worth doing now

The gate is green at this moment, which is exactly the calm in which to do this. The failure mode
is not the red build itself — it is that it lands on whoever is mid-way through unrelated work,
who then has to choose between dropping the content they came to write, cutting unrelated prose to
make room, or overriding the gate. That happened twice already: once during the store prefix-seek
review (a needed paragraph in `docs/store.md` was rewritten three times to fit), and once as an
outright red build at `main` that had to be triaged before any ticket could proceed.

## Split, not ratchet

The original filing left split-versus-ratchet open as a maintainer's choice. It has since been
answered by what actually shipped: three documents in this position (`module-authoring.md`,
`store.md`, `types.md`) were **split**, not ratcheted, by two separate triage passes
(`f6d72746`, `88e6e18b`). Follow that precedent. Raising a ratchet buys headroom by raising the
ceiling rather than lowering the content, and the last remaining ratchet entry in the repo
(`docs/lens.md`) is itself an open decision nobody wants a second instance of.

## Expected outcome

- Every document in `docs/` is under the 12,000-word cap with enough headroom that an ordinary
  edit does not run into the gate. Aim for a comfortable margin, not one word under.
- `docs/.doc-budget.json` gains no new entries.
- `yarn docs:check` passes, and so does `yarn check`.

## What the split has to get right

The recipe is written down in `docs/doc-conventions.md` and has now shipped five times, so this is
execution rather than invention. The parts that have gone wrong before:

- **Prose section markers.** Source comments and other docs point at sections by name
  (`docs/optimizer.md § …`). `debt-doc-size-ratchet-red-at-head` left four stale markers behind.
  `scripts/check-docs.mjs` names them all — run it and read the output rather than grepping by hand.
- **Inbound links.** The `store.md` split re-pointed links across eight documents. Expect a
  similar spread here, especially for `optimizer.md`, which `docs/architecture.md` routes readers to.
- **Design docs get invariants.** All three are design documents, so each split adds or extends an
  invariant area in `docs/invariants.md`. Confirm the area's heading is accepted by the
  `INVARIANT_HEADING` regex in the checker before assuming it is — one past split had to add its
  area to that regex, another did not.
- **Measure before choosing seams.** Cut at existing headings along the outline the document
  already has; word-count the candidate halves before committing to file boundaries.

## Scope note

`docs/lens.md` is **not** part of this ticket. It is the one grandfathered entry left in
`docs/.doc-budget.json`, at 19226 words against a 18755 ratchet with 29 words of grace band left,
and whether to split it is an open question for a human — `debt-docs-split-lens-when-stable` in
`blocked/`. Splitting the three documents above does not touch it and does not answer it.
