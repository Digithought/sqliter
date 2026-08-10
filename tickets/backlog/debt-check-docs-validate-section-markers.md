description: Comments and docs often point at a documentation section by name rather than by link, and nothing checks those pointers, so they silently go stale whenever a section is renamed or moved to another document.
files:
  - scripts/check-docs.mjs        # `bareDocRefs()` — the extractor that stops at `.md`
  - docs/doc-conventions.md       # where the marker form would be documented
  - packages/quereus/src/vtab/capabilities.ts   # example markers
  - packages/quereus/src/vtab/module.ts         # example markers
  - docs/store.md                               # example markers
difficulty: medium
tradeoffs: Stale prose section markers are a documentation-only cost, and validating them means inventing a marker syntax that every existing comment then has to conform to.
----

## Background

Two ways exist in this repo to point at a section of a document:

1. A markdown link with an anchor — `[Catalog persistence](store.md#catalog-persistence-bundled-index-ddl)`.
2. A **prose section marker** — `See docs/store.md § Catalog persistence`. This form is used in
   TypeScript comments (where a markdown link would be noise) and in some prose.

`scripts/check-docs.mjs` validates form 1 completely: the file must exist and the anchor must
name a real heading. It validates only *half* of form 2. Its `bareDocRefs()` extractor
deliberately stops at `.md`, so the file half is checked and the `§ Section Name` half is
ignored entirely. A marker naming a section that no longer exists — renamed, or moved into a
different document — passes the gate silently.

## Why this is worth doing

This is not speculative; it has already happened. The documentation split done under
`debt-doc-size-ratchet-red-at-head` moved three sections into new documents and left four
stale markers behind, which the review pass found by hand:

| Site | Marker | Problem |
| --- | --- | --- |
| `docs/store.md:959` | `schema.md § View and materialized-view persistence` | section had moved to `view-persistence.md` |
| `packages/quereus/src/vtab/module.ts:569` | `docs/schema.md § View and materialized-view persistence` | same |
| `packages/quereus/src/vtab/capabilities.ts:28` | `docs/module-capabilities.md § "Capability negotiation surface"` | **the split's own edit** — repointed the file half to a document that has no section by that name |
| `capabilities.ts:44` | same | same |

The last two are the telling ones: the split *repointed* those markers and still got them
wrong, because moving the file half is checked and moving the section half is not. Every
future rename or split has the same hole. The manual mitigation ("grep `§` and read each one")
was tried on this split and leaked four times out of a few dozen markers.

### Second data point — the `docs-split-schema-rename-detection` split

The same hole showed up again on the next split. That split moved `### Rename Detection` out of
`docs/schema.md` into `docs/schema-rename-detection.md`. Its own grep for markers missed one
because the marker was **wrapped across two comment lines**
(`packages/quereus/src/schema/reserved-tags.ts`, around line 198: `...See docs/schema.md` on one
line, `§ Rename Detection.` on the next) — so a single-line window never saw the `§`. Whatever
extractor this ticket adds has to join wrapped comment lines before matching.

The review pass for that split also found three markers naming a section that has **never** been
in `docs/schema.md` — the content lives in `docs/store.md` (the bold `**Per-column PK key
collation.**` paragraph, around `store.md:489`). They are stale independently of any split, and
are the concrete corpus this check would have caught:

| Site | Marker | Should name |
| --- | --- | --- |
| `docs/module-capabilities.md:143` | `` [`docs/schema.md` § Per-column PK key collation](schema.md) `` | `store.md` |
| `packages/quereus/src/schema/table.ts:346` | `` `docs/schema.md` §"Per-column PK key collation" `` | `store.md` |
| `packages/quereus/test/logic.spec.ts:60` | `docs/schema.md §"Per-column PK key collation"` | `store.md` |

(`docs/memory-table.md:557` carries the same marker and already names `store.md` correctly —
useful as the positive case.) Note the target is **bold prose, not a heading**, so a
heading-only matcher would report these as unresolvable rather than as pointing at the wrong
document; deciding whether bold-lead paragraphs count as markable sections is a third open
design question alongside the two below.

### Third data point — the `docs-split-sync-protocol` split

Again on the next split, and this time the marker names a section that is **not a heading at
all**. That split moved the sync wire protocol out of `docs/sync.md` into
`docs/sync-protocol.md`. `§ Streaming Snapshot API` names a banner comment *inside* a fenced
TypeScript block, which travelled with the move; three markers kept naming `docs/sync.md` and
`node scripts/check-docs.mjs` stayed green:

| Site | Marker | Should name |
| --- | --- | --- |
| `docs/sync-schema.md:69` | `` [sync.md](sync.md) § Streaming Snapshot API `` | `sync-protocol.md` |
| `packages/quereus-sync/README.md:210` | `docs/sync.md § Streaming Snapshot API` | `sync-protocol.md` |
| `packages/quereus-sync/src/sync/protocol.ts:310` | `docs/sync.md § Streaming Snapshot API` | `sync-protocol.md` |

(The review pass repointed all three; they are recorded here as corpus, not as outstanding
work.) The implementing agent had swept for markers and classified these as *pre-existing and
stale* precisely because the name matches no heading — which is the failure mode this check has
to handle: an unresolvable marker is not automatically a stale one, and the sibling
`§ Who drives the sweep` markers in the same sweep resolve to a **bold prose paragraph**
(`docs/sync.md:197`) and are correct. So a heading-only matcher would misreport both directions
here — sharpening the third open design question above, and adding a fourth: whether a named
banner inside a fenced code block is markable at all, or whether the marker should be rewritten
to name the enclosing heading (`§ Sync API`) instead.

## Expected behavior

`node scripts/check-docs.mjs` fails, with the usual `path:line: message` shape, when a prose
section marker names a section that does not exist in the document it names. A marker that
resolves — by heading text, case- and punctuation-insensitively enough to survive the backtick
and quote variations already in the tree (`§ "Capability negotiation surface"`,
`§ Catalog persistence`, `§ 6.3`, `§"Per-column PK key collation"`) — passes.

Two things the design has to decide, and neither is settled yet:

- **Where a marker ends.** `See docs/sync.md § Transaction-Based Change Grouping, the` — the
  marker's section name runs into the surrounding prose with no closing delimiter. A rule is
  needed (longest-heading-prefix match against the target document's headings is one option;
  requiring quotes or backticks around the name going forward is another).
- **Numbered and partial markers.** `sql-ddl.md §6.3` names a section by number, and
  `docs/module-authoring.md § Per-arm mandate` names a heading by a fragment of its text. Both
  forms exist in the tree today and both are useful; the check either has to accept them or the
  markers have to be normalized first.

Run `grep -rn "§" docs packages/*/src --include=*.md --include=*.ts` for the full corpus the
check has to survive — roughly 40 markers, several of which do not currently resolve to an
exact heading.

## Relationship to other work

`debt-check-docs-script-too-large` proposes splitting `scripts/check-docs.mjs` into a
directory, one module per check, and is explicitly a move with no behavior change. This ticket
adds a check. Either can land first; if the split lands first, this becomes a new module in
`scripts/check-docs/` rather than another section of the single file.
