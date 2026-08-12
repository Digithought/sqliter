---
description: The main query-optimizer design document sits 23 words below the size limit the documentation checker enforces, so the next paragraph anyone adds turns the whole pre-release check red — move its two cost-and-statistics sections into a document of their own.
files:
  - docs/optimizer.md            # source; 11977 words, 23 from the 12000-word cap
  - docs/optimizer-costing.md    # NEW — the moved sections
  - docs/optimizer-rules.md      # 2 inbound links to the moved sections
  - docs/invariants.md           # OPT-016 and OPT-018 `doc:` lines point into the moved block
  - docs/.stability.json         # new doc needs a tier entry (Internal)
  - docs/doc-conventions.md      # the split recipe (read, do not edit)
  - scripts/check-docs.mjs       # the gate (read, do not edit)
difficulty: medium
---

`docs/optimizer.md` is 11,977 words against a hard 12,000-word cap that has **no grace band**
(`node scripts/check-docs.mjs`, measured at `3327c350`). `yarn docs:check` is the first step of
`yarn check`, so one added sentence turns the whole pre-release gate red — and `optimizer.md` is
the document every new optimizer rule is supposed to be recorded in.

`optimizer.md` is already a **hub**: it carries a `## Topic documents` table (lines 12–28) listing
twelve satellites. This ticket adds a thirteenth. The recipe is `docs/doc-conventions.md`
§ "Where new prose goes" and has shipped five times; this is execution, not invention.

## What moves

One **contiguous** block, lines 257–433 at `3327c350` — two adjacent H3 sections that together
are 4,470 words:

| Heading | Lines | Words |
| --- | --- | --- |
| `### Cost Model Integration` (incl. `#### Conjunct cost tiers`, `#### Self-cost-only convention`) | 257–348 | 740 |
| `### Statistics Abstraction` | 349–433 | 3,730 |

They move together rather than separately because they are one topic and because the existing
inbound links already conflate them — `docs/optimizer-rules.md:55` reads
`See [Cost Model Integration](optimizer.md#cost-model-integration), "Filter row estimates"`, and
"Filter row estimates" is a bold lead-in inside *Statistics Abstraction*, not inside Cost Model
Integration. Landing both in one satellite makes that reference correct instead of merely
repointed.

**Destination:** `docs/optimizer-costing.md`, H1 `# Optimizer Cost and Statistics`.

Expected sizes after the move: `optimizer.md` ≈ **7,560** words (7,507 + one table row + the
one-line intro edit) — a ~4,400-word margin, comfortably clear of the near-cap notice.
`optimizer-costing.md` ≈ **4,550** words. Neither needs a ratchet entry, and
`docs/.doc-budget.json` must gain none.

## Shape of the new document

Per `docs/doc-conventions.md` § "Where new prose goes", a satellite opens with an H1, a stability
banner, and an intro whose last sentence is `A satellite of [Quereus Query Optimizer](optimizer.md).`

```markdown
# Optimizer Cost and Statistics

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

<one short paragraph: this document covers how a plan node's cost is computed and how row
counts and selectivities are estimated — the two things every cost-based rule stands on.>
A satellite of [Quereus Query Optimizer](optimizer.md).

## Cost Model Integration
…
```

**Promote heading levels by one** — `### Cost Model Integration` → `## Cost Model Integration`,
`#### Self-cost-only convention` → `### Self-cost-only convention`. A heading's anchor slug comes
from its *text*, not its level, so `#cost-model-integration`, `#conjunct-cost-tiers`,
`#self-cost-only-convention` and `#statistics-abstraction` all survive unchanged. Only the *file*
half of every inbound link needs editing. Do not reword any heading.

**Move the prose verbatim.** No rewriting, no re-ordering, no "while I'm here" edits. The only
permitted differences are the heading-level promotion above and the new H1 + banner + intro. Prove
it with a diff against `3327c350` (see TODO).

The two `> **Invariant:**` back-links inside the moved block point at `invariants.md#...` and stay
valid — the satellite sits in the same directory.

## Inbound references to repoint

Change the file half, keep the anchor:

| Site | Was | Now |
| --- | --- | --- |
| `docs/optimizer-rules.md:55` | `optimizer.md#cost-model-integration` | `optimizer-costing.md#statistics-abstraction` — see note below |
| `docs/optimizer-rules.md:56` | `optimizer.md#cost-model-integration` | `optimizer-costing.md#cost-model-integration` |
| `docs/invariants.md:182` (OPT-016) | `optimizer.md#self-cost-only-convention` | `optimizer-costing.md#self-cost-only-convention` |
| `docs/invariants.md:197` (OPT-018) | `optimizer.md#self-cost-only-convention` | `optimizer-costing.md#self-cost-only-convention` |

Line 55 is the already-wrong one: its trailing `"Filter row estimates"` names a passage in
*Statistics Abstraction*. Point it at `optimizer-costing.md#statistics-abstraction` and keep the
`"Filter row estimates"` marker, so link and marker finally agree.

The checker validates every markdown link and anchor in `docs/` and every bare `docs/*.md` ref in
source files, so a missed link *of that shape* fails the build. It does **not** validate the
`§ Section Name` half of a prose marker — `bareDocRefs()` stops at `.md` (that hole is the open
ticket `backlog/debt-check-docs-validate-section-markers`). A grep at `3327c350` found **no**
`§ Cost Model Integration` / `§ Statistics Abstraction` prose marker anywhere in `docs/` or
`packages/*/src`, but re-run it after the move rather than trusting this line.

## Invariants

Do **not** mint a new invariant for this ticket. `docs/invariants.md` entries require exactly one
`guard:` naming a real test, and the moved prose already carries back-links to the two invariants
that cover it (OPT-016, OPT-018). Lift a new one only if the moved text states a normative rule
that an *existing* test already pins; otherwise repoint the two `doc:` lines and stop. Editing
`INVARIANT_HEADING` in `scripts/check-docs.mjs` is out of scope.

## Edge cases & interactions

- **Duplicate anchor slugs.** Two headings with the same text in one document get `-1`/`-2`
  suffixes, silently shifting anchors. Before finishing, slugify every heading in both
  `optimizer.md` and `optimizer-costing.md` and assert no base slug appears twice — `optimizer.md`
  has a known pre-existing duplicate elsewhere, so check that the count of duplicates does not
  *increase*, not merely that it is zero.
- **The `## Topic documents` table.** `optimizer.md` lines 12–28 list twelve satellites. Add a row
  for the new document; a satellite missing from its hub's table is invisible. Keep the table's
  existing one-line-per-document style.
- **The hub intro.** `optimizer.md`'s opening paragraph enumerates what the hub covers and names
  "cost model" explicitly. Adjust that one sentence so the hub no longer claims content it no
  longer holds.
- **Classification is mandatory.** A `docs/*.md` absent from `docs/.stability.json` fails the
  build. Add `"docs/optimizer-costing.md": "Internal"` to the `docs` map (matching `optimizer.md`'s
  tier), in the file's existing sort order. This file is also touched by the two sibling tickets
  (`2-docs-split-sql-ddl-vtab-constraints`, `3-docs-split-isolation-design`) — re-read it
  immediately before writing.
- **Banner form is pinned.** The checker self-tests the exact banner string; one wrong character
  (a hyphen for the em dash, a missing full stop) reports as *malformed*, not as *missing*. Copy a
  banner from an existing `optimizer-*.md` rather than typing one.
- **No stub left behind.** Every inbound link is being repointed, and a stub creates the
  ambiguity `docs/sql.md`'s own NOTE complains about (a live link on a stub is indistinguishable
  from one that should have been retargeted). Delete the moved headings from `optimizer.md`
  outright; the checker's dead-anchor failure is the net for anything missed.
- **No new ratchet entry.** `docs/.doc-budget.json` must be byte-identical afterwards — its only
  entry stays `docs/lens.md`. If the new document somehow lands over 12,000 words the answer is a
  different seam, not a ratchet entry.
- **`docs/architecture.md` routes readers to `optimizer.md`.** It links the hub, not the moved
  sections, so it needs no edit — confirm rather than assume.
- **A near-cap notice is not a failure.** `node scripts/check-docs.mjs` exits 0 while printing
  notices. Read the printed lines; do not treat exit 0 as success on its own.

## TODO

- Record the baseline: `node scripts/check-docs.mjs` and `git rev-parse HEAD`, so the verbatim
  diff below has a fixed reference commit.
- Create `docs/optimizer-costing.md` with the H1, `Stability: Internal` banner, one-paragraph
  intro ending `A satellite of [Quereus Query Optimizer](optimizer.md).`, and the moved block with
  heading levels promoted by one.
- Delete lines 257–433 from `docs/optimizer.md` (no stub).
- Add a `## Topic documents` row for the new document; adjust the hub intro sentence that claims
  the cost model.
- Add `"docs/optimizer-costing.md": "Internal"` to `docs/.stability.json` — re-read the file first.
- Repoint the four inbound references in the table above.
- Verify the move is verbatim: extract lines 257–433 from `git show <baseline>:docs/optimizer.md`
  and `diff` against the new document's body; the only differences may be heading `#` counts.
- Re-grep for prose section markers: `grep -rniE '§ ?"?(Cost Model Integration|Statistics
  Abstraction|Self-cost-only convention|Conjunct cost tiers)' docs packages --include=*.md
  --include=*.ts` and repoint any hit.
- Check duplicate anchor slugs in both documents (count must not increase).
- Run `node scripts/check-docs.mjs` — must print no near-cap or over-cap line for `optimizer.md`
  and no new line for `optimizer-costing.md`, and end `Docs OK`. `docs/lens.md`'s grace-band
  notice is pre-existing and stays.
- Confirm `git diff docs/.doc-budget.json` is empty.
- Run `yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts`
  — it validates README relative links, which a doc split can break.
- `yarn test` is **not** required: this change is documentation only, touches no `.ts` file, and
  has no runtime behaviour to exercise. Say so explicitly in the review handoff rather than
  leaving the omission unexplained.
