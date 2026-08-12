---
description: The transaction-isolation design note is 127 words below the size limit the documentation checker enforces, so the next edit turns the pre-release check red — move its longest chapter into its own note, and move its list of unbuilt optimizations out of the docs folder into the ticket queue where unbuilt work belongs.
files:
  - docs/design-isolation-layer.md          # source; 11873 words, 127 from the 12000-word cap
  - docs/design-isolation-challenges.md     # NEW — the "Challenges and Mitigations" chapter
  - docs/todo.md                            # line 21 points at the section being removed
  - docs/.stability.json                    # new doc goes in `untiered`, NOT in `docs`
  - packages/quereus-isolation/src/isolation-module.ts   # prose marker § "Commit Failure Recovery"
  - tickets/backlog/feat-isolation-overlay-fast-paths.md # NEW — receives the proposals removed from the doc
  - docs/doc-conventions.md                 # the split recipe (read, do not edit)
difficulty: medium
---

`docs/design-isolation-layer.md` is 11,873 words against a hard 12,000-word cap with **no grace
band** (`node scripts/check-docs.mjs`, measured at `3327c350`). `yarn docs:check` is the first
step of `yarn check`, so the gate goes red on roughly one added paragraph — and this document is
edited often (six tickets in `tickets/complete/` touched it).

Unlike the two sibling tickets, this one is not purely a split. Two of the document's sections are
**unimplemented proposals and a phase checklist**, which `docs/doc-conventions.md` says do not
belong in `docs/` at all: *"A doc describing an unimplemented capability is indistinguishable, to a
reader, from a doc that has drifted. Move the passage to `docs/todo.md` or a backlog ticket."*
Promoting them into a satellite would preserve exactly the problem the convention exists to
prevent. They move to the ticket queue instead.

## What moves, and where

| Section | Lines at `3327c350` | Words | Destination |
| --- | --- | --- | --- |
| `## Challenges and Mitigations` (six numbered sub-sections: merge iteration, cursor invalidation, commit failure recovery, performance overhead, large transaction storage, schema operations) | 824–969 | 3,430 | `docs/design-isolation-challenges.md` (new note) |
| `## Optimization Strategies` (overhead analysis, Optimizations 1–7, summary table, recommended order) | 1123–1420 | 1,140 | `tickets/backlog/feat-isolation-overlay-fast-paths.md`, verbatim |
| `## TODO` (Phase 1–6 checklist, mostly `✅`) | 1071–1122 | 355 | deleted; its three unchecked boxes go into the same backlog ticket |

Expected size afterwards: `design-isolation-layer.md` ≈ **7,000** words — a ~5,000-word margin.
`design-isolation-challenges.md` ≈ 3,500. No ratchet entry for either;
`docs/.doc-budget.json` must be byte-identical afterwards.

## The new note

`design-isolation-layer.md` is **untiered** — it is listed in `docs/.stability.json`'s `untiered`
array, and the checker **fails** an untiered document that carries a stability banner. So the new
note carries **no banner**:

```markdown
# Isolation Layer — Challenges and Mitigations

<one short paragraph naming what the note covers: the six known hard problems in the
overlay-merge design and how each is handled.>
A satellite of [Isolation Layer Design](design-isolation-layer.md).
```

Promote heading levels by one inside the moved block: `### 1. Merge Iteration Complexity` →
`## 1. Merge Iteration Complexity`, and so on. Slugs derive from heading text, not level, so
`#1-merge-iteration-complexity` and its five siblings survive unchanged. Do not reword a heading.
The `## Challenges and Mitigations` heading itself becomes the H1's subject and disappears —
nothing links `#challenges-and-mitigations` (grepped at `3327c350`).

**Move the prose verbatim.** The two links inside the block (`module-authoring.md`, `store.md`)
are directory-relative and survive.

Leave behind, in `design-isolation-layer.md` where the section was, a one-line pointer to the new
note — this document has no `## Topic documents` table, so the pointer is the only navigation a
reader gets. Add it as running prose, not as a stub heading.

## The backlog ticket

Create `tickets/backlog/feat-isolation-overlay-fast-paths.md`. It carries the removed
`## Optimization Strategies` text **verbatim** in its body (that is where the content is preserved
— nothing is lost), plus the three unchecked items from the `## TODO` phase list:

- Full integration testing (autocommit mode, savepoint coordination with the underlying store)
- Switch Quoomb Web's Store and Sync modes to use the isolated path
- Performance benchmarking vs. non-isolated access

**Reconcile before filing — the section is partly stale.** The Phase 6 checklist marks two of the
proposals as already shipped: `buildPKPointLookupFilter()` covers "Optimization 3: Existence Check
via Point Lookup", and `O(1) clearOverlay()` is done. Read
`packages/quereus-isolation/src/isolated-table.ts` and `isolation-module.ts` and mark each of the
seven optimizations shipped / not shipped in the ticket body rather than copying a stale wish
list. A ticket that asks for work already done is worse than no ticket.

Header fields for the new backlog ticket (see `tess/agent-rules/tickets.md` for the template):

- `description:` one plain sentence — the isolation layer copies every write into a temporary
  overlay table and rescans it at commit, which is wasted work for the common single-statement
  write; these are the proposed fast paths that skip it. No symbol names, no file paths.
- `files:` `packages/quereus-isolation/src/isolated-table.ts`,
  `packages/quereus-isolation/src/isolation-module.ts`, `docs/design-isolation-challenges.md`
- `tradeoffs:` one honest sentence on why a maintainer might defer — these are speculative
  optimizations with no measurement behind their claimed benefit, and the isolation layer is Beta
  with correctness work still landing, so added fast paths multiply the shapes each correctness
  fix must cover.

No `severity:` / `likelihood:` — this is a `feat-`, not a bug.

## Inbound references to repoint

- `docs/todo.md:19–21` — the heading `## Stand-alone isolation layer optimizations` followed by
  `See `docs/design-isolation-layer.md``. That section is exactly what this ticket removes from
  the doc. Repoint the line at the new backlog ticket slug (`backlog/feat-isolation-overlay-fast-paths`),
  keeping it a single line.
- `packages/quereus-isolation/src/isolation-module.ts:460–461` — a prose marker reading
  `docs/design-isolation-layer.md § "Commit Failure Recovery"`. That section moves, and the
  checker **cannot** see the `§` half (`bareDocRefs()` stops at `.md`; the hole is the open ticket
  `backlog/debt-check-docs-validate-section-markers` — do not re-file it). Repoint to
  `docs/design-isolation-challenges.md § "Commit Failure Recovery"`.

Not affected, but confirm rather than assume:

- `docs/store.md:630` → `design-isolation-layer.md#isolation-level-provided` — that section stays.
- `docs/stability.md:95` and `docs/todo.md`'s other mention → whole-file links, still valid.
- `packages/quereus-isolation/README.md:207` → an absolute GitHub URL to the design document,
  still valid. Consider whether it should also name the new note; optional.
- `packages/quereus/src/vtab/table.ts:75` → `§ "Table identity"`, and
  `packages/quereus-isolation/src/isolated-table.ts:612` → whole-file. Neither section moves.

Regenerate the list rather than trusting these:

```bash
grep -rn --include=*.md --include=*.ts 'design-isolation-layer' . \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=tickets
```

## Invariants

Do **not** mint one. `INVARIANT_HEADING` in `scripts/check-docs.mjs` admits only the areas `OPT`,
`MV`, `VU`, `RT`, `SCH`, `SYNC`, `LENS` — there is no isolation area, and adding one means editing
the checker, which is out of scope for a documentation split. No existing invariant's `doc:` line
points into this document (grepped at `3327c350`), so there is nothing to repoint either.

## Edge cases & interactions

- **Untiered means no banner.** The checker fails an untiered document that carries a banner, and
  fails any `docs/*.md` that appears in neither list. Add `"docs/design-isolation-challenges.md"`
  to the **`untiered` array**, not to the `docs` map. This file is shared with the sibling tickets
  (`1-docs-split-optimizer-costing`, `2-docs-split-sql-ddl-vtab-constraints`) — re-read it
  immediately before writing.
- **Deleting 1,495 words of design prose is deliberate, not collateral.** `## Optimization
  Strategies` and `## TODO` come out of the document because `docs/doc-conventions.md` says
  unimplemented work and phase history do not live in `docs/`. Nothing is lost — the proposals
  land verbatim in the backlog ticket. If the reconciliation above shows a proposal is already
  shipped and its mechanism is worth documenting, fold **that** mechanism into
  `design-isolation-challenges.md` § 4 (Performance Overhead) as present-tense description of what
  the code does, not as a proposal.
- **Duplicate anchor slugs.** Slugify every heading in both documents afterwards and assert no
  duplicate base slug is introduced. The moved block's headings are numbered (`1.`–`6.`), so
  collisions are unlikely — check anyway, since a `-1` suffix shifts an anchor silently.
- **The `---` horizontal rules.** Both removed sections are bracketed by `---` separators. Remove
  the orphaned ones; a stray rule where a section used to be reads as a formatting bug.
- **`## References` is the document's last section** and follows the removed `## Optimization
  Strategies`. Make sure it survives and still reads as the closing section.
- **No new ratchet entry.** `docs/.doc-budget.json` stays byte-identical; its only entry remains
  `docs/lens.md`.
- **Exit 0 is not success.** `node scripts/check-docs.mjs` prints near-cap notices and still exits
  0. Read the printed lines.

## TODO

- Record the baseline: `node scripts/check-docs.mjs` and `git rev-parse HEAD`.
- Create `docs/design-isolation-challenges.md` — H1, **no banner**, one-paragraph intro ending
  `A satellite of [Isolation Layer Design](design-isolation-layer.md).`, the moved block with
  heading levels promoted by one.
- Read `packages/quereus-isolation/src/isolated-table.ts` and `isolation-module.ts` and determine
  which of Optimizations 1–7 have already shipped.
- Create `tickets/backlog/feat-isolation-overlay-fast-paths.md` carrying the `## Optimization
  Strategies` text verbatim, the three open Phase 5/6 items, the shipped/not-shipped
  reconciliation, and the header fields listed above.
- Delete lines 824–969, 1071–1122 and 1123–1420 from `docs/design-isolation-layer.md`; add the
  one-line pointer to the new note where the challenges chapter was; clean up orphaned `---`
  rules.
- Add `"docs/design-isolation-challenges.md"` to the `untiered` array in `docs/.stability.json` —
  re-read the file first.
- Repoint `docs/todo.md:19–21` at the new backlog ticket slug.
- Repoint the `§ "Commit Failure Recovery"` marker in `isolation-module.ts:461`, then re-grep for
  `design-isolation-layer.md §` across `docs/` and `packages/*/src`.
- Verify the challenges move is verbatim: extract lines 824–969 from
  `git show <baseline>:docs/design-isolation-layer.md` and `diff` against the new note's body;
  only heading `#` counts may differ.
- Check duplicate anchor slugs in both documents.
- Run `node scripts/check-docs.mjs` — no near-cap or over-cap line for
  `design-isolation-layer.md`, no new line for the new note, ends `Docs OK`. `docs/lens.md`'s
  grace-band notice is pre-existing and stays.
- Confirm `git diff docs/.doc-budget.json` is empty.
- Run `yarn lint` (one `.ts` comment edit) and
  `yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts`.
- `yarn test` is **not** required — documentation plus one comment edit, no runtime behaviour
  touched. State that explicitly in the review handoff.
