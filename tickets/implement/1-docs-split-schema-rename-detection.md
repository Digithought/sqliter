---
description: One section of the schema design document has grown to roughly 5,000 words — over a third of the file — and is pushing it past the project's documentation size limit; move that section into its own document and leave a pointer behind.
files:
  - docs/schema.md                      # source; `### Rename Detection` is lines 482-576
  - docs/schema-rename-detection.md     # NEW — the moved section
  - docs/.doc-budget.json               # drop the `docs/schema.md` entry (see "The ratchet entry" below)
  - docs/.stability.json                # classify the new document
  - docs/doc-conventions.md             # the rules this follows (read; do not edit — ticket 3 edits it)
  - docs/view-updateability.md          # the worked example of a hub + satellite split
  - docs/optimizer.md                   # the `## Topic documents` table to copy the shape of
  - packages/quereus/src/schema/reserved-tags.ts       # line 14 — prose marker to repoint
  - packages/quereus/src/emit/ast-stringify.ts         # line 1172 — prose marker to repoint
  - packages/quereus/README.md          # line 173 — documentation index entry
  - tickets/.pre-existing-known.md      # amend the entry (see below)
difficulty: medium
---

## Why

`yarn docs:check` — the first step of `yarn check`, so nothing after it runs — fails at HEAD:

```
docs/schema.md: 13157 words exceeds its ratchet of 12109 by 1048, past the 500-word grace band
docs/sync.md:  13645 words exceeds its ratchet of 12538 by 1107, past the 500-word grace band
```

This ticket fixes the `schema.md` half. `docs/sync.md` is the next ticket
(`docs-split-sync-protocol`), and the gate stays red until that one lands — that is expected,
not a defect in this ticket's work.

Measured with `wc -w` on 2026-08-04:

| file | words |
| --- | --- |
| `docs/schema.md` | 13157 (`wc -w < docs/schema.md`) |
| `docs/schema.md` lines 482-576 (`### Rename Detection`) | 4944 (`sed -n '482,576p' docs/schema.md \| wc -w`) |

`### Rename Detection` is 38% of the document and is the largest single section in it by a
factor of three. Its six `####` subsections already read as a self-contained topic: how the
declarative differ decides that an object was *renamed* rather than dropped-and-recreated, and
the body-change detection that overrides a rename.

## What to do

Follow the hub-and-satellite pattern the repo already uses for `docs/optimizer.md`,
`docs/materialized-views.md`, `docs/view-updateability.md` and `docs/sql.md`: the large document
is a **hub** that keeps the overview and the cross-cutting material, and the sections that grew
big enough to read on their own become **satellites** — separate documents, linked from a
`## Topic documents` table near the top of the hub, each carrying a one-line "A satellite of
[Hub](hub.md)." in its intro.

`docs/schema.md` already has one satellite (`docs/view-persistence.md`, split out by an earlier
pass) but no `## Topic documents` table, so that satellite is currently reachable only from
`packages/quereus/README.md`. Add the table and list both.

### The move

`docs/schema.md` lines 482-576 (`### Rename Detection` up to but excluding
`### Module Batch Hooks`) become `docs/schema-rename-detection.md`.

- **Verbatim.** Move the text unchanged apart from the mechanical edits listed here. A prior
  review of the previous split diffed every moved block against its source and expected an exact
  match; do the same to yourself before handing off.
- **Promote heading depth by one.** `### Rename Detection` becomes the new document's `# Rename
  Detection` H1; each `#### …` becomes `## …`. Heading depth does not affect the anchor slug, so
  every anchor in the moved text keeps working. Keep the H1 text exactly `Rename Detection` — the
  moved text contains a self-link `](#rename-detection)` (schema.md:549) that depends on it.
- **Second self-link.** `](#view--materialized-view-definition-change-detection-droprecreate)`
  (schema.md:561) targets a heading inside the moved range, so it stays a same-page link. Nothing
  to do beyond not breaking it.
- **Outbound links in the moved text** point at `sql-ddl.md`, `sql-alter.md` and `store.md` — all
  siblings in `docs/`, so the relative paths stay correct.
- **Stability banner.** The satellite takes its parent's tier, `Beta`:
  `> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).` directly under the H1. The
  dash is an em dash (U+2014); `scripts/check-docs.mjs` rejects a banner one character off.
  Add `"docs/schema-rename-detection.md": "Beta"` to the `docs` map in `docs/.stability.json`.
- **Line endings and BOM.** The working tree is CRLF (`.editorconfig` is the source of truth) and
  `docs/schema.md` has no byte-order mark. Write the new file the same way — do not introduce a
  BOM, and do not convert `docs/schema.md` to LF as a side effect of the edit.

### The stub

Leave the original heading in `docs/schema.md` with a one-line body, the same form
`docs/view-updateability.md:147-153` uses:

```markdown
### Rename Detection

Moved to [Rename Detection](schema-rename-detection.md#rename-detection).
```

The stub keeps `schema.md#rename-detection` resolving for any link written in future. Note the
caveat `docs/view-updateability.md:11-15` records in an HTML comment: `yarn docs:check` cannot
tell a link left on a stub from one that should have been retargeted, so retarget by hand.

### Inbound references to repoint

Two prose section markers point into the moved range. Neither is machine-checked — the checker's
`bareDocRefs()` stops at `.md` and never validates the `§ Section` half (`scripts/check-docs.mjs`
line ~276; closing that hole is `backlog/debt-check-docs-validate-section-markers`, out of scope
here). Both were found with
`grep -rnoE "(docs/)?schema\.md[^\n]{0,80}" --include=*.md --include=*.ts . | grep -v node_modules | grep -v /dist/`:

| Site | Currently says | Should say |
| --- | --- | --- |
| `packages/quereus/src/schema/reserved-tags.ts:14` | `docs/schema.md § Rename Detection` | `docs/schema-rename-detection.md` |
| `packages/quereus/src/emit/ast-stringify.ts:1172` | `docs/schema.md § View / materialized-view definition-change detection` | `docs/schema-rename-detection.md § View / materialized-view definition-change detection` |

Re-run that grep after the move and confirm no other marker names a heading that left.

**Do not edit anything under `packages/*/dist/`** — it is build output and carries stale copies
of the same comments.

Add the satellite to the documentation index in `packages/quereus/README.md:173`, alongside the
existing `view-persistence.md` pointer.

### The ratchet entry

After the move `docs/schema.md` measures roughly 8,300 words — comfortably under the 12,000-word
cap in `docs/.doc-budget.json`. **Delete the `"docs/schema.md"` key from the `ratchet` object**
rather than lowering it.

Reason, in the file's own words: "Ratchet entries record a doc's size at the time it was
grandfathered in." Grandfathering only means something for a document *above* the cap. Leaving an
entry at ~8,300 would pin the document 3,700 words below the project's actual readability limit
for no readability reason, and the next honest 600-word addition would turn the gate red again —
which is precisely the cycle this ticket exists to break. With no entry, `docs/schema.md` is
governed by the plain 12,000-word cap like every other document.

`node scripts/check-docs.mjs --update-ratchet` will *not* do this for you today (it only lowers).
Edit the JSON by hand. A follow-up ticket (`docs-doc-growth-convention-and-near-cap-warning`)
teaches the tool to drop sub-cap entries and writes the rule into `docs/doc-conventions.md`.

### The known-failures registry

`tickets/.pre-existing-known.md` currently maps the docs-check failure to this ticket's parent
and names both documents. Amend the entry so it names only `docs/sync.md` and points at
`docs-split-sync-protocol`. Do not delete the entry — the gate is still red until that ticket
lands.

## Edge cases & interactions

- **Duplicate heading slugs.** `scripts/check-docs.mjs` assigns `-1`/`-2` suffixes in document
  order, so removing a section can silently retarget a link. Checked on 2026-08-04:
  `docs/schema.md` has **zero** duplicate base slugs today, so no suffix can shift. Re-check after
  the move (slugify every heading in both files and look for duplicates) rather than trusting this
  line.
- **The moved text must be byte-identical.** Diff it: `git show HEAD:docs/schema.md | sed -n '482,576p'`
  against the body of the new file with the heading-depth promotion undone. A one-word paraphrase
  during a "move" is the failure mode a reviewer cannot see.
- **The stub is one line, not a summary.** A stub that re-explains the section is a second copy to
  keep true — the thing `docs/doc-conventions.md` exists to prevent.
- **The satellite must come in under 12,000 words with no ratchet entry.** At ~5,000 it does; if
  the intro paragraph you add is long enough to matter, you have written too much intro.
- **`yarn docs:check` is still red after this ticket** on `docs/sync.md`. Confirm the *only*
  remaining failure is that one, and say so in the handoff. A second failure means this change
  broke something.
- **Anchors that never existed.** `docs/schema.md § "Stored bodies resolve against their home
  schema"` (`packages/quereus/src/planner/mutation/body-context.ts:12`) and
  `§"Per-column PK key collation"` (`packages/quereus/src/schema/table.ts:346`,
  `packages/quereus/test/logic.spec.ts:60`, `docs/module-capabilities.md:143`) name headings that
  do **not** exist in `docs/schema.md` today. They are pre-existing stale markers, not caused by
  this split and not in the moved range. Leave them; they belong to
  `backlog/debt-check-docs-validate-section-markers`. Mention in the handoff that you saw them so
  the reviewer does not re-discover them as new breakage.

## TODO

- Create `docs/schema-rename-detection.md` from `docs/schema.md` lines 482-576: H1 `# Rename
  Detection`, `Beta` stability banner, a two-sentence intro closing with "A satellite of
  [Schema Management](schema.md)."; promote every `####` to `##`.
- Replace lines 482-576 of `docs/schema.md` with the one-line stub.
- Add a `## Topic documents` table to `docs/schema.md` just below the intro paragraph, listing
  `schema-rename-detection.md` and the existing `view-persistence.md`. Copy the table shape from
  `docs/optimizer.md:11-24`.
- Add `"docs/schema-rename-detection.md": "Beta"` to `docs` in `docs/.stability.json`.
- Delete the `"docs/schema.md"` key from `ratchet` in `docs/.doc-budget.json`.
- Repoint the two prose markers in `reserved-tags.ts` and `ast-stringify.ts`; add the satellite to
  the index line in `packages/quereus/README.md:173`.
- Amend the `tickets/.pre-existing-known.md` entry to name only `docs/sync.md` and
  `docs-split-sync-protocol`.
- Verify: `node scripts/check-docs.mjs` — the only failure left is `docs/sync.md`'s size.
  Confirm the moved text is verbatim by diff. Re-run the duplicate-slug check on both files.
- Verify the comment-only TypeScript edits: `yarn build`, `yarn typecheck`, `yarn lint`. Skip
  `yarn test` and state the reason (no runtime behavior changes; the diff is prose, comments and
  two JSON keys) rather than skipping silently.
