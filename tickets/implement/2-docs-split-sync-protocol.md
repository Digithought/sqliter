---
description: The sync design document is over the project's documentation size limit, which keeps the standard verification command red; move its protocol and API reference chapter — about a quarter of the file — into its own document.
prereq: docs-split-schema-rename-detection
files:
  - docs/sync.md                        # source; `## Sync Protocol` is lines 641-1129
  - docs/sync-protocol.md               # NEW — the moved chapter
  - docs/.doc-budget.json               # drop the `docs/sync.md` entry (see "The ratchet entry")
  - docs/.stability.json                # classify the new document
  - docs/todo.md                        # line 448 — anchor link into the moved chapter
  - docs/sync-coordinator.md            # line 220 — prose marker into the moved chapter
  - docs/sync-schema.md, docs/migration.md   # existing sync satellites, for the topic-documents table
  - packages/quereus-sync/README.md     # documentation pointers
  - tickets/.pre-existing-known.md      # delete the entry once the gate is green
difficulty: medium
---

## Why

`yarn docs:check` is the first step of `yarn check`, so while it fails nothing after it runs.
After `docs-split-schema-rename-detection` lands, `docs/sync.md` is the last remaining failure:

```
docs/sync.md: 13645 words exceeds its ratchet of 12538 by 1107, past the 500-word grace band
```

Measured with `wc -w` on 2026-08-04:

| file | words |
| --- | --- |
| `docs/sync.md` | 13645 (`wc -w < docs/sync.md`) |
| `docs/sync.md` lines 641-1129 (`## Sync Protocol`) | 3534 (`sed -n '641,1129p' docs/sync.md \| wc -w`) |

`## Sync Protocol` is a natural seam by *audience*, not just by size: the rest of `sync.md`
explains the CRDT model — clocks, conflict resolution, tombstones, transaction grouping,
transactional integrity — while this chapter is reference material for someone writing a
transport or a client: the wire data structures, the `SyncManager` API surface, and the WebSocket
message protocol with its versioning, reconnection and debouncing rules. Its four `###`
subsections (`Data Structures`, `Sync API`, `Sync Flow (Master to Many-Masters)`,
`WebSocket Sync Protocol`) and eight `####` subsections are already a coherent chapter.

## What to do

Same hub-and-satellite pattern as the prereq ticket, and the same one the repo already uses for
`docs/optimizer.md`, `docs/materialized-views.md`, `docs/view-updateability.md` and `docs/sql.md`:
the big document stays as a **hub** with the conceptual material and a `## Topic documents` table;
sections large enough to read on their own become **satellites**.

`docs/sync.md` already has three satellites — `docs/sync-schema.md`, `docs/sync-coordinator.md`
and (for the retirement/migration story) `docs/migration.md` — and no table listing them. Add one.

### The move

`docs/sync.md` lines 641-1129 (`## Sync Protocol` up to but excluding `## Reactive Hooks`) become
`docs/sync-protocol.md`.

- **Verbatim.** Move the text unchanged apart from the mechanical edits below, and diff it against
  the source before handing off.
- **Promote heading depth by one.** `## Sync Protocol` becomes `# Sync Protocol`; each `### …`
  becomes `## …`; each `#### …` becomes `### …`. Depth does not change the anchor slug, so links
  into any of these headings keep resolving once retargeted at the new file.
- **No same-page links point into or out of the moved range.** Verified 2026-08-04:
  `grep -noE '\]\(#[^)]*\)' docs/sync.md` returns nothing targeting a heading in lines 641-1129,
  and the moved range contains no `](…)` links at all. Re-verify rather than assuming.
- **Stability banner.** The satellite takes its parent's tier, `Experimental`:
  `> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).` directly under the
  H1, em dash (U+2014). Add `"docs/sync-protocol.md": "Experimental"` to the `docs` map in
  `docs/.stability.json`.
- **The byte-order mark.** `docs/sync.md` opens with U+FEFF — `scripts/check-docs.mjs` documents
  this at its `readText` helper because it once made the file's H1 invisible to the checker. Leave
  it where it is on `sync.md` and **do not copy it into `sync-protocol.md`**. Line endings are
  CRLF per `.editorconfig`; write the new file the same way.

### The stub

Leave the original heading with a one-line body, matching `docs/view-updateability.md:147-153`:

```markdown
## Sync Protocol

Moved to [Sync Protocol](sync-protocol.md#sync-protocol).
```

Only the `## Sync Protocol` heading gets a stub. The `###` headings below it do **not** — the two
inbound references that name them are retargeted instead (next section), and a stub per heading is
five more places for a future link to land on the wrong copy.

### Inbound references to repoint

Found with
`grep -rnoE "(docs/)?sync\.md[^\n]{0,80}" --include=*.md --include=*.ts . | grep -v node_modules | grep -v /dist/`:

| Site | Currently says | Should say |
| --- | --- | --- |
| `docs/todo.md:448` | `[\`sync.md\`](sync.md#data-structures)` | `[\`sync-protocol.md\`](sync-protocol.md#data-structures)` |
| `docs/sync-coordinator.md:220` | `` `sync.md` § Protocol version `` | `` `sync-protocol.md` § Protocol version `` |

Every other reference to `docs/sync.md` in the tree names a section that stays behind
(`Transaction-Based Change Grouping`, `Transactional Integrity During Sync`, `Row identity vs.
address`, `Metadata format version`, `Reactive Hooks`, `Store-and-forward relay`,
`Revival / drain`) — leave those alone. Re-run the grep after the move to confirm.

**Do not edit anything under `packages/*/dist/`.**

Check `packages/quereus-sync/README.md` for pointers that should now name the satellite, and add
the satellite to any documentation index that lists the sync docs.

### The ratchet entry

After the move `docs/sync.md` measures roughly 10,200 words, under the 12,000-word cap. **Delete
the `"docs/sync.md"` key from the `ratchet` object in `docs/.doc-budget.json`** rather than
lowering it — same reasoning as the prereq ticket: a ratchet entry grandfathers a document that is
*above* the cap, and pinning a 10,200-word document at 10,700 sets up the next red gate for no
readability reason. `--update-ratchet` will not do this for you today; edit the JSON by hand.

After both splits, `ratchet` should contain exactly one entry: `docs/lens.md`, which is genuinely
above the cap and whose split is a human decision tracked in
`tickets/blocked/debt-docs-split-lens-when-stable`.

### The known-failures registry

With this ticket the gate is green, so **delete** the `yarn docs:check` entry from
`tickets/.pre-existing-known.md`. Leave the file's heading and preamble in place.

## Edge cases & interactions

- **Duplicate heading slugs.** Checked 2026-08-04: `docs/sync.md` has **zero** duplicate base
  slugs, so removing the chapter cannot shift a `-1`/`-2` suffix. Re-check after the move on both
  files rather than trusting this line.
- **The BOM.** The easiest way to corrupt this split is a tool that reads `sync.md`, writes both
  halves, and lands the U+FEFF on the wrong file (or on both). Check the first bytes of both files
  after the move: `head -c 3 docs/sync.md | xxd` should show `efbbbf`, and the same command on
  `docs/sync-protocol.md` should not.
- **The moved text must be byte-identical.** Diff `git show HEAD:docs/sync.md | sed -n '641,1129p'`
  against the new file with the heading promotion undone.
- **Already-stale markers, not yours.** `docs/sync.md § Streaming Snapshot API`
  (`packages/quereus-sync/src/sync/protocol.ts:310`, `packages/quereus-sync/README.md:210`) and
  `docs/sync.md § Who drives the sweep` (`docs/migration.md:114`,
  `packages/quereus-sync/src/sync/maintenance.ts:7`, `packages/sync-coordinator/README.md:80`) name
  headings that do not exist in `docs/sync.md` today, and neither is in the moved range. They are
  pre-existing and belong to `backlog/debt-check-docs-validate-section-markers`. Leave them; note
  in the handoff that you saw them.
- **`Streaming Snapshot Example` stays.** It sits under `## Usage Example` (sync.md:1393), outside
  the moved range, despite reading like protocol material. Do not opportunistically move it — this
  ticket's diff should be one contiguous cut.
- **The gate must be green when you finish.** `node scripts/check-docs.mjs` exits 0. If it does
  not, do not hand off.

## TODO

- Create `docs/sync-protocol.md` from `docs/sync.md` lines 641-1129: H1 `# Sync Protocol`,
  `Experimental` banner, a two-sentence intro closing with "A satellite of [Sync
  Module](sync.md)."; promote `###`→`##` and `####`→`###`. No BOM.
- Replace lines 641-1129 of `docs/sync.md` with the one-line stub.
- Add a `## Topic documents` table to `docs/sync.md` below the intro, listing `sync-protocol.md`,
  `sync-schema.md`, `sync-coordinator.md` and `migration.md`. Copy the shape from
  `docs/optimizer.md:11-24`.
- Add `"docs/sync-protocol.md": "Experimental"` to `docs` in `docs/.stability.json`.
- Delete the `"docs/sync.md"` key from `ratchet` in `docs/.doc-budget.json`.
- Repoint `docs/todo.md:448` and `docs/sync-coordinator.md:220`; check
  `packages/quereus-sync/README.md` for index entries.
- Delete the `yarn docs:check` entry from `tickets/.pre-existing-known.md`.
- Verify: `node scripts/check-docs.mjs` exits 0 ("Docs OK"). Diff the moved text. Re-run the
  duplicate-slug check and the two greps above. Check the BOM on both files.
- Verify the tree: `yarn build`, `yarn typecheck`, `yarn lint`. Skip `yarn test` with the reason
  stated (this diff is prose plus two JSON keys; no `.ts` changes at all if
  `packages/quereus-sync/README.md` needs no edit).
