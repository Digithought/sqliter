---
description: A long section of the schema design document was moved into its own file so the document fits back under the project's documentation size limit; this reviews that move.
files:
  - docs/schema.md                                     # source; now 8291 words, `### Rename Detection` is a 1-line stub at 489-492
  - docs/schema-rename-detection.md                    # NEW — the moved section, 4983 words
  - docs/.doc-budget.json                              # `docs/schema.md` ratchet entry deleted
  - docs/.stability.json                               # new doc classified Beta
  - packages/quereus/src/schema/reserved-tags.ts       # two prose markers repointed (lines 14 and ~198)
  - packages/quereus/src/emit/ast-stringify.ts         # one prose marker repointed (~line 1172)
  - packages/quereus/README.md                         # documentation index entry (line 173)
  - tickets/.pre-existing-known.md                     # entry amended to name only docs/sync.md
difficulty: easy
---

## What landed

`docs/schema.md` was 13157 words against a 12000-word cap and a 12109-word ratchet — `yarn
docs:check` failed, and since `docs:check` is the first step of `yarn check`, nothing after it
ran. `### Rename Detection` (old lines 482-576, 4944 words — 38% of the file) moved into a new
satellite document, following the hub-and-satellite pattern `docs/optimizer.md` and
`docs/view-updateability.md` already use.

Result: `docs/schema.md` is **8291 words**, `docs/schema-rename-detection.md` is **4983**. Both
are under the 12000-word cap with no ratchet entry.

Concretely:

- `docs/schema-rename-detection.md` created. H1 `# Rename Detection`, `Beta` stability banner, a
  two-sentence intro closing with "A satellite of [Schema Management](schema.md)."; every `####`
  in the moved text promoted to `##`.
- `docs/schema.md` lines 482-576 replaced with a one-line stub under the original heading, so
  `schema.md#rename-detection` still resolves.
- A `## Topic documents` table added to `docs/schema.md` below the intro paragraph, listing the
  new satellite and the pre-existing `docs/view-persistence.md` (which until now was reachable
  only from `packages/quereus/README.md`).
- `"docs/schema.md"` **deleted** from `ratchet` in `docs/.doc-budget.json` — not lowered.
  Grandfathering only means something for a doc above the cap; an entry at ~8300 would pin the
  doc 3700 words below the real limit and turn the gate red on the next honest addition.
- `"docs/schema-rename-detection.md": "Beta"` added to `docs` in `docs/.stability.json`.
- Three prose section markers repointed (see below); `packages/quereus/README.md:173` now lists
  the satellite alongside `view-persistence.md`.
- `tickets/.pre-existing-known.md` amended to name only `docs/sync.md` /
  `docs-split-sync-protocol`. The entry stays — the gate is still red.

No runtime code changed. The TypeScript diff is comments only.

## How to verify

**The move is verbatim.** This is the one thing a reviewer cannot see by reading. Reconstruct the
moved text from the satellite (drop the banner + blank + intro + blank, i.e. indices 2-5; map
each `## x` back to `#### x`; map the H1 back to `### Rename Detection`; re-append the trailing
blank) and diff against `git show HEAD:docs/schema.md | sed -n '482,576p'`. I ran exactly this
and it reported no differences. Note: `node` on Windows resolves `/tmp/...` to `C:\tmp`, not Git
Bash's `/tmp` — write scratch files to a repo-relative path or the diff silently has nothing to
compare.

**The docs gate.** `node scripts/check-docs.mjs` — the only **failure** is `docs/sync.md`'s size,
which `docs-split-sync-protocol` owns. `docs/lens.md` also reports as 376 words over its ratchet,
but that is a *warning* inside the 500-word grace band, present at HEAD before this change, and
not a failure. Anything else failing means this change broke something.

**Duplicate heading slugs.** `scripts/check-docs.mjs` suffixes duplicate slugs `-1`/`-2` in
document order, so removing a section can silently retarget a link. Re-run the check: slugify
every heading in both files with the checker's own `slugify`/`headingText` (lines 188-200) and
look for repeats. Measured after the move: `docs/schema.md` 49 headings, 0 duplicates;
`docs/schema-rename-detection.md` 7 headings, 0 duplicates.

**Self-links inside the moved text.** Two links in the moved range targeted headings that also
moved, so they stay same-page links in the satellite:
`](#rename-detection)` (was schema.md:549) and
`](#view--materialized-view-definition-change-detection-droprecreate)` (was schema.md:561).
Both resolve against the satellite's own headings.

**Line endings and BOM.** All touched files are LF with no BOM; verified byte-wise after every
edit including the Edit-tool ones.

**Build.** `yarn build`, `yarn typecheck`, `yarn lint` — all pass. `yarn test` was **not run**:
the diff is prose, code comments, and two JSON keys, with no runtime behavior change of any kind.

## Deviations from the ticket, and why

- **The ticket said the working tree is CRLF. It is not.** There is no `.gitattributes`, and
  `.editorconfig` sets no `end_of_line` key. Every file in `docs/` is LF on disk (checked
  `optimizer.md`, `view-updateability.md`, `vu-operators.md`, `sync.md`). I wrote the satellite
  as LF to match its siblings and left `docs/schema.md` LF. If the reviewer believes CRLF is
  intended, that is a repo-wide question, not this ticket's.

- **A third prose marker existed that the ticket's grep missed.**
  `packages/quereus/src/schema/reserved-tags.ts` had the reference `docs/schema.md § Rename
  Detection` **wrapped across two comment lines** (`...See docs/schema.md` / `// § Rename
  Detection. A future ticket...`), around line 198. The ticket's grep used an 80-character
  window on a single line, which truncated before the `§`. I found it by searching for the `§`
  separately and repointed it to `docs/schema-rename-detection.md`. The two markers the ticket
  did name (`reserved-tags.ts:14`, `ast-stringify.ts:1172`) were repointed as specified.
  **Worth a reviewer's second sweep** — if one wrapped marker hid from the ticket's grep, another
  might have hidden from mine. Suggested sweep: `grep -rn "§" --include=*.ts --include=*.md`
  filtered to hits naming a heading that left `docs/schema.md`.

- **The README index entry says "Deep dives:" (plural)** now that `docs/schema.md` has two, rather
  than adding a second "Deep dive:" clause.

## Known gaps and things I deliberately left

- **`§ Section` markers are not machine-checked.** `scripts/check-docs.mjs`'s `bareDocRefs()`
  (~line 276) validates the `.md` path and stops; it never checks the `§ Section` half. So every
  repointed marker above is correct only because I read it, not because a tool agrees. Closing
  that hole is `backlog/debt-check-docs-validate-section-markers`.

- **Pre-existing stale markers I saw and left alone.** These name headings that do **not** exist
  in `docs/schema.md` today, were already stale before this change, and are not in the moved
  range. They belong to `backlog/debt-check-docs-validate-section-markers`:
  - `packages/quereus/src/planner/mutation/body-context.ts:12` — § "Stored bodies resolve against
    their home schema"
  - `packages/quereus/src/schema/table.ts:346`, `packages/quereus/test/logic.spec.ts:60`,
    `docs/module-capabilities.md:143` — §"Per-column PK key collation"
  - `docs/todo.md:191` — names `docs/sql.md` §"Rename detection" (a different document; out of
    scope either way)

- **The stub-vs-retarget blind spot.** As `docs/view-updateability.md:11-15` records in an HTML
  comment, `yarn docs:check` cannot distinguish a link deliberately left pointing at a stub from
  one that should have been retargeted and was not. I retargeted by hand; a reviewer wanting
  certainty has to re-read, not re-run.

- **`docs/lens.md` has 124 words of ratchet headroom left** (18310 against a 17934 ratchet, inside
  the 500-word grace band). Not caused by this change and not a failure today, but it is the next
  document that will turn the gate red. Noting it so the reviewer does not rediscover it as new
  breakage.

- **`yarn docs:check` is still red** on `docs/sync.md`. Expected — `docs-split-sync-protocol` owns
  that half. `tickets/.pre-existing-known.md` records it.
