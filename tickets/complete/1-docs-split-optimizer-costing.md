---
description: The main query-optimizer design document was 23 words from the size limit the docs checker enforces, so its cost-and-statistics sections were moved into a new document of their own.
files:
  - docs/optimizer-costing.md    # NEW — the moved sections (4,546 words)
  - docs/optimizer.md            # was 11,977 words, now 7,526
  - docs/optimizer-rules.md      # 2 inbound links repointed
  - docs/invariants.md           # OPT-016 / OPT-018 `doc:` lines repointed
  - docs/.stability.json         # new tier entry
  - docs/doc-conventions.md      # review: added the "sweep for relative cross-references" rule
  - packages/quereus/test/optimizer/statistics.spec.ts   # review: repointed a stale prose marker
difficulty: easy
---

## What landed

`docs/optimizer.md` lines 257–433 at `3327c350` (`### Cost Model Integration` + its two H4s,
and `### Statistics Abstraction`) moved verbatim into a new satellite
`docs/optimizer-costing.md`, H1 `# Optimizer Cost and Statistics`. Heading levels promoted by
one; anchor slugs unchanged because a slug comes from heading *text*, not level. No stub left
in the hub, no `docs/.doc-budget.json` entry needed.

Sizes, measured with the checker's own `content.split(/\s+/).filter(Boolean).length`:

| Doc | Before | After |
| --- | --- | --- |
| `docs/optimizer.md` | 11,977 | **7,526** (4,474 under the 12,000 cap) |
| `docs/optimizer-costing.md` | — | **4,546** |

Alongside the move: hub intro dropped "cost model" from what it claims to cover; a
`## Topic documents` row for the satellite; a `docs/.stability.json` `Internal` entry; and four
inbound links repointed (`optimizer-rules.md:55,56`, `invariants.md:182,197` for OPT-016 /
OPT-018), three of which also had their display text updated so the text names the document the
link actually reaches.

## Review findings

Read the implement diff (`3df5d994`) against `3327c350` before the handoff summary. The move
itself is sound: `diff` of `3327c350:docs/optimizer.md` lines 257–433 against
`optimizer-costing.md` lines 12–188 differs on exactly the four heading `#` counts (plus the
one repoint below) — no prose was altered, dropped, or reflowed. Duplicate-slug count did not
increase. The new intro paragraph is the only authored English in the change and its claimed
contents list matches what actually moved.

### Fixed in this pass (minor)

Three stale cross-references, all one root cause: a split relocates a section, and every
pointer at it that is *not* a markdown link goes unchecked. `scripts/check-docs.mjs` validates
link targets and anchors only.

- `docs/optimizer-costing.md:136` — "see Pass 3.7 above" dangled: Pass 3.7 stayed in the hub.
  Now a real link, `[Optimizer § Pass 3.7: Final Estimates](optimizer.md#pass-37-…)`, so the
  checker validates it from here on.
- `docs/optimizer.md:712` — a comment inside a code sample read `see "The number the
  selectivity multiplies" above`; that section left the file. Repointed to
  `docs/optimizer-costing.md`.
- `packages/quereus/test/optimizer/statistics.spec.ts:746` — `See docs/optimizer.md
  "Base-table row estimates"`, now `docs/optimizer-costing.md`. The implement sweep grepped
  for `§`-prefixed markers and this one carries no `§` at all, which is why it survived.

Also normalized line endings on the files the implement pass wrote with a script
(`optimizer.md`, `optimizer-costing.md`, `invariants.md` were LF in a CRLF tree). `git diff` is
byte-identical before and after — git normalizes in the index — so this only silences the
per-command "LF will be replaced by CRLF" warnings. The handoff flagged it rather than papering
over it, which was the right call.

### Filed as evidence on an existing ticket (major-class, already tracked)

`backlog/debt-check-docs-validate-section-markers` already owns this class and already carries
three data points from earlier splits. Appended a fourth, because this one is new information
rather than another instance: the missed marker had **no `§`**, just a quoted section name
following the file reference. Any extractor that ticket builds cannot key on `§`. Its target is
also a bold-lead prose paragraph rather than a heading — the ticket's third open design question
appearing a second time. No new ticket filed; per *Architecture first*, the Nth instance of a
tracked class is evidence.

### Recorded as a tripwire

The "see X *above*" breakage has no single code site and no mechanical check — a positional word
is unvalidatable without knowing intent. Parked as a rule in `docs/doc-conventions.md` § The size
ratchet ("When you split, sweep for relative cross-references"), naming the grep and the two
marker forms. That is where the two in-flight sibling splits
(`2-docs-split-sql-ddl-vtab-constraints`, `3-docs-split-isolation-design`) will meet it.

### Checked and found clean

- **All 20 `optimizer.md#anchor` references repo-wide** — every one targets a heading that
  stayed in the hub. No stale anchors.
- **`docs/architecture.md`** — links the hub and two surviving anchors; genuinely needs no edit.
- **Source comments referencing `docs/optimizer.md`** (`characteristics.ts`, `registry.ts` ×2,
  `optimizer.ts`) — all name hub sections. Only the spec-file marker above was stale.
- **`docs/.stability.json`** — valid JSON, entry in alphabetical position.
- **Satellite intro convention** — the banner is byte-identical to `optimizer-rules.md`'s, and
  the "what this covers / hub back-link" intro shape matches the four sibling satellites.

### Considered and left alone

- The `## Topic documents` row placed second rather than appended, and the hub intro sentence
  losing "cost model" without gaining an explicit pointer. Both are judgment calls the handoff
  raised; the table two lines below is the routing surface and the row is easy to find. Not
  worth churn.
- `docs/optimizer.md` § Best Practices still carries three generic "Cost Estimation" bullets
  with no link to the new satellite. Adding one would be defensible; the topic table already
  routes, and the bullets are advice rather than reference.

### Validation

- `node scripts/check-docs.mjs` → `Docs OK`. The three near-cap notices
  (`design-isolation-layer.md`, `lens.md` grace band, `sql-ddl.md`) are pre-existing and are the
  sibling tickets' subject matter.
- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + test-file `tsc`).
- `yarn test` → exit 0, full suite, 4m55s.
- `test/documentation.spec.ts` → 10 passing, including the relative-doc-link resolution test.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
