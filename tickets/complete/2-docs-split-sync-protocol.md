---
description: The sync design document was too long and kept the standard documentation check failing; its protocol and API reference chapter moved into its own file, the check now passes, and the review pass repointed six references that the move had left aimed at the old location.
files:
  - docs/sync-protocol.md               # NEW — the moved chapter (3575 words)
  - docs/sync.md                        # hub; 10213 words, was 13645
  - docs/sync-schema.md                 # intro + one section marker repointed (review)
  - docs/.doc-budget.json               # `docs/sync.md` ratchet entry deleted
  - docs/.stability.json                # `docs/sync-protocol.md` classified Experimental
  - docs/todo.md                        # anchor repointed
  - docs/sync-coordinator.md            # prose marker + link repointed
  - README.md                           # docs index gained the satellite, and the hub (review)
  - packages/quereus-sync/README.md     # section marker repointed (review)
  - packages/quereus-sync/src/sync/protocol.ts  # section marker repointed (review)
  - tickets/.pre-existing-known.md      # `yarn docs:check` entry deleted
difficulty: medium
---

## What landed

`docs/sync.md` lines 641-1129 (`## Sync Protocol` through the line before `## Reactive Hooks`)
became `docs/sync-protocol.md`. The hub keeps the CRDT model — clocks, conflict resolution,
tombstones, transaction grouping, transactional integrity, storage layout — and the satellite
holds the reference material a transport or client author needs: wire data structures, the
`SyncManager` API surface, and the WebSocket message protocol.

Same hub-and-satellite shape the repo already uses for `docs/optimizer.md`, `docs/sql.md` and
`docs/view-updateability.md`: a `## Topic documents` table at the top of the hub, a one-line
`Moved to …` stub left under the original heading so old anchors still resolve, and an
`A satellite of …` line in the satellite's intro.

### The gate

`node scripts/check-docs.mjs` exits **0** — "Docs OK: links resolve, invariants well-formed,
sizes within ratchet, doc and package tiers declared." It was the only red step in `yarn check`.

`ratchet` in `docs/.doc-budget.json` now contains exactly one entry, `docs/lens.md`.

### Word counts (`wc -w`)

| file | before | after |
| --- | --- | --- |
| `docs/sync.md` | 13645 | **10213** (cap is 12000, no ratchet entry) |
| `docs/sync-protocol.md` | — | **3575** |

## Review findings

The implement-stage diff (`d4936e16`) was read before its handoff summary. Six references were
repointed and four claims corrected; nothing rose to a new ticket.

### Fixed in this pass (minor)

- **Three `§ Streaming Snapshot API` markers still named `docs/sync.md` after that content
  moved.** `docs/sync-schema.md:69`, `packages/quereus-sync/README.md:210`,
  `packages/quereus-sync/src/sync/protocol.ts:310` → all now name `docs/sync-protocol.md`.
  The handoff filed these as *pre-existing stale* on the reasoning that the name matches no
  heading — true, but the thing they point at is a banner comment inside a fenced TypeScript
  block that **travelled with the move**, so the split made them wrong. `yarn docs:check` cannot
  see prose `§` markers, so it stayed green throughout.
- **`docs/sync-schema.md:7`** claimed "the data path, storage layout, wire protocol and
  transports live in `sync.md`". The last two moved; the sentence now names both documents.
- **The `## Topic documents` table row for `sync-coordinator.md`** advertised "rooms,
  authentication, persistence, snapshot storage". The word *room* appears nowhere in
  `docs/sync-coordinator.md`; its actual chapters are the HTTP API, the WebSocket protocol, a
  hook-based service layer, configuration, logging, security and performance. Rewritten from the
  headings. The handoff flagged this blurb as unverified and asked for exactly this check.
- **The table row for `migration.md`** used an invented title ("Table Migration and Retirement")
  and described only that document's retirement chapter. Real title is "Schema Migration in a
  Synced Database"; row now names it and covers the frozen shared basis and the parallel-table
  pattern too.
- **Two references inside the satellite that silently became cross-page.** `sync-protocol.md:185`
  ("see the HLC section") and `:411` ("§ Transaction-Based Change Grouping → Read side") both
  read as same-page pointers but resolve on the hub. The handoff found these and deliberately
  left them verbatim so its byte-identity proof would hold; that proof has now served its
  purpose, so `:185` names `docs/sync.md § Hybrid Logical Clock (HLC)` (it sits in a doc-comment
  fence, so it cannot be a markdown link) and `:411` is a real link to
  `sync.md#read-side-one-changeset-per-transaction`.
- **`README.md` docs index listed the satellite but not the hub.** Added `docs/sync.md`; the
  handoff raised this and left the call to review.

### Verified, no action

- **The move is byte-identical.** Re-ran the handoff's reconstruction against `d4936e16~1`:
  `IDENTICAL: 489 lines`. Only edits inside the range are the fence-aware heading promotion and
  dropping the old `## Sync Protocol` line.
- **Encoding.** `docs/sync.md` keeps its byte-order mark (`efbbbf`); `docs/sync-protocol.md` has
  none. Both files are 100% CRLF, zero bare LF, after the review edits too. Matches
  `.editorconfig`.
- **Anchors.** Gate exit 0 after every edit; its link pass validates each `#anchor` against the
  target file's headings. No duplicate heading slugs on either file, so no `-1` suffix shifted.
- **The `§ Who drives the sweep` markers** (`docs/migration.md:114`,
  `packages/quereus-sync/src/sync/maintenance.ts:7`, `packages/sync-coordinator/README.md:80`,
  `packages/sync-coordinator/src/service/maintenance.ts:5`) are **correct** and were left alone.
  The handoff listed them as "stale, naming headings that do not exist" — they name a bold prose
  paragraph at `docs/sync.md:197`, which stayed on the hub.
- **`docs/stability.md:100`** does not list `sync-protocol.md` under the Sync row. It does not
  list `sync-schema.md` either, and that document's own rule says "a deep dive inherits its hub's
  tier". Consistent; adding only the new satellite would make it less so.
- **`docs/doc-conventions.md:177`** uses `docs/sync.md` in a sample of the ratchet warning
  message, and that document no longer has a ratchet entry. The sample's numbers were never live
  figures, so it still reads as illustrative. Left as-is rather than churn a neighbouring doc.
- **`docs/sync.md § Streaming Snapshot Example`** stayed on the hub under `## Usage Example`
  despite reading like protocol material — a deliberate call in the plan to keep one contiguous
  cut. Agreed on review: it is an end-to-end usage walkthrough, not reference material.
- **Satellite reads standalone.** Swept every positional and `§` reference in it. After the two
  fixes above, the remaining two (`:191` "…partial data below" → `:283`; `:448` "the three codes
  above") resolve within the satellite.

### Tests and lint

`yarn lint` exit 0 (26s). `yarn test` all green — 8693 + 376 + 113 + 63 + 17 + 28 + 1362 + 725 +
85 + 31 + 34 + 134 + 22 passing across the workspaces, zero failing, 3m40s. The only source
change in the whole ticket is one doc-comment line in `protocol.ts`. Nothing added to
`tickets/.pre-existing-error.md`.

### New tickets: none

Both structural gaps this review surfaced are already claimed on the board, so an arm was
appended rather than a ticket filed:

- **Prose `§` markers are not validated** — the root cause of the three repointed markers above.
  Already `tickets/backlog/debt-check-docs-validate-section-markers`. Appended a third data-point
  section to it: this split's markers name a banner **inside a fenced code block**, while the
  correct sibling markers name a **bold paragraph**, so a heading-only matcher would misreport
  both directions. That sharpens an open design question already in the ticket and adds one.
- **The hub-and-satellite convention is nowhere written down** — no `docs/doc-conventions.md`
  section describes the `## Topic documents` table, the `Moved to …` stub, or the rule that a
  link to real content must name the satellite and not the stub. Already the explicit subject of
  `tickets/implement/3-docs-doc-growth-convention-and-near-cap-warning`, which lists
  `docs/doc-conventions.md` in its `files:` and names this ticket as a prereq. Nothing added —
  duplicating `docs/view-updateability.md`'s stub-hazard comment into each hub would be the wrong
  fix for a convention that wants one home.

### Tripwires: none recorded

Every conditional concern that came up already has a home. The one loose end —
**`docs/lens.md` at 18310 words against a 17934 ratchet, 124 words of headroom inside the
500-word grace band** — is neither speculative nor mine: the gate prints it on every run and goes
red the first time someone adds more than 124 words. Its split is a human decision already parked
in `tickets/blocked/debt-docs-split-lens-when-stable`.
