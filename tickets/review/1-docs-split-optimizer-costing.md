---
description: The main query-optimizer design document was 23 words from the size limit the docs checker enforces, so its cost-and-statistics sections were moved into a new document of their own.
files:
  - docs/optimizer-costing.md    # NEW — the moved sections (4,543 words)
  - docs/optimizer.md            # was 11,977 words, now 7,525
  - docs/optimizer-rules.md      # 2 inbound links repointed
  - docs/invariants.md           # OPT-016 / OPT-018 `doc:` lines repointed
  - docs/.stability.json         # new tier entry
difficulty: easy
---

## What landed

`docs/optimizer.md` lines 257–433 at `3327c350` (`### Cost Model Integration` + its two H4s,
and `### Statistics Abstraction`) moved verbatim into a new satellite
`docs/optimizer-costing.md`, H1 `# Optimizer Cost and Statistics`. Heading levels promoted by
one; anchor slugs unchanged because a slug comes from heading *text*, not level.

Baseline for the verbatim check: `3327c350` (HEAD at ticket start was `965d4d1f`, whose only
change was the ticket file itself — `git diff --stat 3327c350 965d4d1f -- docs/` is empty).

Sizes measured with the checker's own `content.split(/\s+/).filter(Boolean).length`:

| Doc | Before | After |
| --- | --- | --- |
| `docs/optimizer.md` | 11,977 | **7,525** (4,475 under the 12,000 cap) |
| `docs/optimizer-costing.md` | — | **4,543** |

No stub left in the hub. No entry added to `docs/.doc-budget.json` (`git diff` on it is empty).

### Edits beyond the move

- `docs/optimizer.md` hub intro: dropped "cost model" from the list of what the hub covers.
- `docs/optimizer.md` `## Topic documents`: new row for the satellite, placed second (after
  Optimizer Rules), matching the table's existing one-line style.
- `docs/.stability.json`: `"docs/optimizer-costing.md": "Internal"` inserted between
  `optimizer-conventions.md` and `optimizer-fd.md`, preserving alphabetical order.
- Four inbound links repointed (file half changed, anchor kept):
  - `docs/optimizer-rules.md:55` → `optimizer-costing.md#statistics-abstraction`
  - `docs/optimizer-rules.md:56` → `optimizer-costing.md#cost-model-integration`
  - `docs/invariants.md:182` (OPT-016) → `optimizer-costing.md#self-cost-only-convention`
  - `docs/invariants.md:197` (OPT-018) → `optimizer-costing.md#self-cost-only-convention`

### Link-text changes the ticket did not spell out (review these)

The ticket said "change the file half, keep the anchor". Three links also had their **display
text** changed, because leaving it would have left the text naming a document the link no
longer points at:

- `optimizer-rules.md:55` was `See [Cost Model Integration](optimizer.md#cost-model-integration),
  "Filter row estimates"` — the pre-existing wrong one the ticket flagged, since "Filter row
  estimates" lives in *Statistics Abstraction*. Now
  `See [Optimizer Cost and Statistics § Statistics Abstraction](optimizer-costing.md#statistics-abstraction),
  "Filter row estimates"`. Text, target, and marker now all agree.
- `invariants.md:182` and `:197` were `[Optimizer § Self-cost-only convention]`, now
  `[Optimizer Cost and Statistics § Self-cost-only convention]`. This matches how every other
  `doc:` line in `invariants.md` names its satellite (`[Retrieve § …]`,
  `[Functional Dependencies § …]`, `[Optimizer Visited Tracking § …]`).

`optimizer-rules.md:56`'s text (`[Cost Model Integration]`) already matched its heading, so only
the file half changed there.

## Validation run

- **Verbatim move proved by diff.** `git show 3327c350:docs/optimizer.md | sed -n '257,433p'`
  vs `sed -n '12,188p' docs/optimizer-costing.md` differs on exactly 4 lines — the four heading
  `#` counts — plus the block's trailing blank line, which becomes the new file's terminating
  newline. No prose difference.
- **`node scripts/check-docs.mjs`** → `Docs OK: links resolve, invariants well-formed, sizes
  within ratchet, doc and package tiers declared.` Neither `optimizer.md` nor
  `optimizer-costing.md` appears in the near-cap notices. The three remaining notices
  (`design-isolation-layer.md`, `lens.md` grace band, `sql-ddl.md`) are pre-existing and
  unchanged from the baseline run — the two isolation/sql-ddl ones are the sibling tickets'
  subject matter.
- **Stale-anchor grep** for `optimizer.md#(cost-model-integration|statistics-abstraction|self-cost-only-convention|conjunct-cost-tiers)`
  across `docs` and `packages` (`--include=*.md --include=*.ts`) → no hits.
- **Prose section-marker grep** (`§ ?"?(Cost Model Integration|Statistics Abstraction|Self-cost-only
  convention|Conjunct cost tiers)`) → only the three sites listed above, all already repointed.
  This matters because `check-docs.mjs` validates the `.md` half of a bare doc ref but not the
  `§ Section` half (open ticket `backlog/debt-check-docs-validate-section-markers`).
- **Duplicate anchor slugs**: slugified every heading (skipping fenced code) in
  `optimizer-costing.md`, in the current `optimizer.md`, and in `3327c350:docs/optimizer.md`.
  Zero duplicates in all three — the count did not increase.
- **Banner is byte-exact**: `sed -n '3p' docs/optimizer-costing.md` string-equals
  `sed -n '3p' docs/optimizer-rules.md`. It was copied, not typed.
- **`docs/architecture.md` confirmed needing no edit** — it links `optimizer.md` (lines 18, 187)
  and two anchors that stayed in the hub (`#attribute-provenance` line 113,
  `#audit-discipline-sideeffectmode` line 202). None point into the moved block.
- **`yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts`**
  → 10 passing, including "should have all relative doc links resolve to existing files".

## Not run, and why

`yarn test`, `yarn build`, `yarn lint`, `yarn typecheck` were **not** run. This change touches
five files, all under `docs/`, none of them a `.ts` file; there is no runtime behaviour to
exercise and nothing for the compiler to see. `git status --porcelain` is exactly
`docs/.stability.json`, `docs/invariants.md`, `docs/optimizer-rules.md`, `docs/optimizer.md`
(modified) and `docs/optimizer-costing.md` (new). The documentation spec above is the one test
a doc split can actually break, and it was run.

## Known gaps / things a reviewer should poke at

- **The new document's intro paragraph is newly written prose**, not moved text — the only
  authored English in the change. Worth a read for accuracy: it claims the document covers the
  self-cost-only convention, conjunct cost tiers, `StatsProvider`, filter and base-table row
  estimates, boolean decomposition, and the multi-relation attribution walk. That list is
  meant to describe what actually moved.
- **The hub intro edit is a judgment call.** The sentence now reads "the shared machinery every
  rule stands on (physical properties, attribute identity, visited tracking)". "cost model" was
  removed; nothing was added pointing at the new satellite from that sentence, on the theory
  that the `## Topic documents` table two lines below is the routing surface. A reviewer may
  prefer an explicit pointer in the prose.
- **The `## Topic documents` row was placed second**, not appended. The table is not
  alphabetical and has no stated order; second felt right (cost/stats is foundational, and the
  rules catalog above it links into it). Reordering is cheap if a reviewer disagrees.
- **Line endings.** The three files rewritten by script (`optimizer.md`, `invariants.md`,
  `optimizer-costing.md`) are LF in the working tree while `core.autocrlf=true` normally checks
  out CRLF. `git diff` is unaffected (git normalizes to LF in the index — the diffs are 8
  insertions / 183 deletions, no whole-file churn) and `.editorconfig` sets no `end_of_line`,
  so this is cosmetic, but `git` prints "LF will be replaced by CRLF" warnings until the files
  are re-checked-out. Flagging rather than papering over.
- **No new invariant was minted**, per the ticket. The moved prose keeps its two
  `> **Invariant:**` back-links to OPT-016/OPT-018, which resolve fine from the same directory.
  `INVARIANT_HEADING` in `scripts/check-docs.mjs` was not touched.
- **The two sibling splits touch `docs/.stability.json` too**
  (`2-docs-split-sql-ddl-vtab-constraints`, `3-docs-split-isolation-design`). This ticket's
  entry is a single added line at a stable sort position, so a textual merge should be clean,
  but it is the one shared file.
