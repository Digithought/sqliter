description: The 28,000-word view-updateability design document was split into a short overview plus five focused satellite documents; this records the completed split and its adversarial review.
prereq:
files:
  - docs/view-updateability.md (overview, 6,266 words — was ~28,000)
  - docs/vu-operators.md, docs/vu-setops.md, docs/vu-inverses.md, docs/vu-mutation-context.md, docs/vu-roundtrip.md (new satellites)
  - docs/.doc-budget.json (view-updateability.md ratchet entry removed)
  - docs/.stability.json (five new docs classified Beta)
  - docs/architecture.md, docs/lens.md, docs/migration.md, docs/mv-schema-change.md, docs/optimizer-fd.md, docs/sql.md (inbound links repointed)
  - tickets/implement/2.1-docs-vu-repoint-src.md (scope broadened during review — see findings)
----

## What landed

`docs/view-updateability.md` shrank from ~28,000 words to **6,266** (under the 12,000-word cap),
so its `docs/.doc-budget.json` ratchet entry was **removed**, not lowered. The moved subjects
live in **five** new satellites, each under cap:

| File | Words | Holds |
| --- | --- | --- |
| `docs/view-updateability.md` (overview) | 6,266 | Intro, Topic-documents table, Overview, Philosophy, Update Site Model, Mutation Propagation, Multi-Base-Table Mutations, Cycles/Self-Joins, Constraints, `returning`, Diagnostics, Information Schema Surface, Implementation Map, Background, Departures, Current limitations, and a one-line stub at each of the 7 moved top-level sections |
| `docs/vu-operators.md` | 10,403 | Per-Operator Semantics (projection, selection, joins, set-op operator rules, CTE / inline-subquery DML targets, window, aggregation) |
| `docs/vu-setops.md` | 5,664 | Set-operation membership columns and membership writes |
| `docs/vu-inverses.md` | 3,161 | Scalar invertibility, authored inverses, view defaults, tags |
| `docs/vu-mutation-context.md` | 1,801 | Mutation context + subsections |
| `docs/vu-roundtrip.md` | 1,213 | Round-trip laws, derived backward walk, predicate-honest complement |

Content moved **verbatim**; headings were depth-shifted only. Five satellites (not the ticket's
four) because `## Per-Operator Semantics` measured ~16,000 words — over cap for a single file —
so the two Set-operation membership sections were carved into `vu-setops.md`. This is the
ticket-sanctioned resolution ("move a section out rather than force `--update-ratchet --force`");
no ratchet entry was added or forced anywhere.

## Review findings

Adversarial pass over the implement diff (`967c3f17`), read before the handoff summary.

**Checked — content fidelity (verified, clean).** Diffed the heading set of the pre-split doc
against the union of all six files: **all 51 original headings survive**, and the union adds
**exactly 3** (`Topic documents`, and the two satellite titles `Set-Operation Membership` /
`Scalar Invertibility and Authored Inverses`). No section was dropped or silently merged. The 7
moved top-level sections each appear twice (real content + overview stub), by design.

**Checked — sizes (verified, clean).** Independently recounted whitespace tokens per file: 6,266
/ 10,403 / 5,664 / 3,161 / 1,801 / 1,213 — every file under the 12,000 cap, matching the handoff.
The `view-updateability.md` ratchet entry is correctly gone from `.doc-budget.json`.

**Checked — links, anchors, stubs, tiers (verified, clean).** Read `scripts/check-docs.mjs` to
confirm Check A validates every markdown `#anchor` and every bare `docs/*.md#anchor` in the
source tree against real headings; the full run reports **only** the three pre-existing ratchet
overages (below) and nothing VU-related, so every VU link/anchor resolves — including the seven
overview stubs (each is a heading + a one-line `Moved to [satellite#anchor]` pointer at the real
satellite content, none self-referential). The five remaining `view-updateability.md#…` inbound
links (all in `lens.md`) target sections that stayed in the overview (`the-update-site-model`,
`interaction-with-constraints`, `diagnostics`, `current-limitations`, `background`) — correct, no
repoint needed. All five satellites carry the `> **Stability: Beta**` banner, a breadcrumb back
to the overview, and a Beta entry in `.stability.json`.

**Found — MINOR, handled: test-file comment drift outside the repoint ticket's scope.** Beyond
the ~60 `docs/view-updateability.md § …` comments in `src/` that `2.1-docs-vu-repoint-src` targets,
**four `.spec.ts` comments** carry the same section refs, three of them pointing at now-moved
sections (`cte-dml-plan-shape.spec.ts` § Common Table Expressions → `vu-operators.md`;
`property.spec.ts` § Round-Trip Laws → `vu-roundtrip.md`; `reserved-tags.spec.ts` § View with
defaults → `vu-inverses.md`; `view-info.spec.ts` § Information Schema Surface is overview-resident
and correct). `2.1`'s worklist grep was `packages/*/src`, which excludes `test/`, so it would have
silently missed these. Rather than split comment-repointing across two tickets, I **broadened
`2.1`'s scope** (its `files:`, enumeration grep, and TODO now include `packages/*/test`, naming the
three drifted files) so all comment drift stays in its dedicated ticket. These are prose `§`
markers, not anchored links, and the overview file still exists, so nothing broke the build — pure
reader-navigation hygiene, correctly owned by `2.1`.

**Noticed — pre-existing, out of scope: dangling `§ Set Operations` prose refs.** `vu-setops.md`
says "see § Set Operations above" twice, but no section by that exact name exists in the file. This
predates the split — the same prose lived in the megadoc, where `Set Operations` was likewise never
a heading (confirmed against `967c3f17^`). A verbatim-move artifact, not a regression; the meaning
(the multi-source-leg-compose material above) is recoverable. Content-accuracy cleanup belongs with
the normative audit in `2.2-docs-invariants-vu`, not this move ticket.

**Deferred (handoff-honest, appropriately routed).** The satellite prose is **unaudited against the
implementation** — this was a move, not a rewrite; the normative-invariant extraction and code
cross-check is `2.2-docs-invariants-vu`'s job. Two content decisions were left as-is deliberately:
the `## Background` bibliography stayed in the overview (it is citations, not changelog), and
`## Current limitations` was kept whole rather than migrated to `docs/todo.md` (the bullets are
already concise pointers with little separable design prose). Both are mechanical follow-ups if a
reviewer of `2.2` disagrees; neither blocks this split.

**No major findings, no new bug/debt tickets, no tripwires filed.** The one tripwire the
implementer parked — a green `docs:check` cannot prove a link was deliberately-vs-accidentally left
on a stub — is recorded as a `NOTE:` HTML comment above the overview's `## Topic documents` table,
where the next link-adder meets it. Left in place; it is accurate and correctly sited.

## Validation

- **`node scripts/check-docs.mjs`** — passes for every VU file (links, anchors, sizes, five Beta
  tiers). Exits non-zero **only** on three pre-existing size-ratchet overages, unrelated to this
  diff (see below).
- **`yarn lint`** — green (23s; `packages/quereus` eslint + test-file `tsc` emit nothing on
  success, every other package is a `No lint configured` no-op).
- **`yarn test`** — green: **6,934 passing** in `@quereus/quereus`, all other workspaces passing,
  **0 failing** (the `boom` / `socket write failed` log lines are deliberate negative-path tests).
  `yarn test:full` not run — the diff is Markdown + two doc-tooling JSON files, no source, so the
  store-backed suite can observe nothing different.

## Pre-existing failure (tracked elsewhere — not re-reported)

`node scripts/check-docs.mjs` also fails on three size-ratchet overages — `docs/runtime.md`,
`docs/schema.md`, `docs/sync.md` — none touched by this ticket. The runner's triage pass already
consumed the implement stage's `.pre-existing-error.md`, listed all three in
`tickets/.pre-existing-known.md`, and filed `tickets/fix/docs-megadoc-ratchet-overage` (in-flight).
Per the pre-existing-failure rule, this ticket is **aware of and defers to that slug** and does not
re-report. No doc was force-ratcheted to hide growth.
