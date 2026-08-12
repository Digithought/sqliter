---
description: The SQL reference page covering table creation is 250 words below the size limit the documentation checker enforces, so an ordinary edit turns the pre-release check red — move its virtual-table and constraint chapters into two sibling pages.
files:
  - docs/sql-ddl.md          # source; 11750 words, 250 from the 12000-word cap
  - docs/sql-vtab.md         # NEW — § 6 Virtual Tables
  - docs/sql-constraints.md  # NEW — § 7 Constraints and Indexes
  - docs/sql.md              # the family index: topic table + two "Moved to" stubs
  - docs/invariants.md, docs/functions.md, docs/runtime.md, docs/schema.md, docs/sql-alter.md   # inbound anchors
  - packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts        # prose § 6.3 markers
  - docs/.stability.json     # two new tier entries (Stable)
  - docs/doc-conventions.md  # the split recipe (read, do not edit)
difficulty: medium
---

`docs/sql-ddl.md` is 11,750 words against a hard 12,000-word cap with **no grace band**
(`node scripts/check-docs.mjs`, measured at `3327c350`). `yarn docs:check` is the first step of
`yarn check`, so the gate goes red on roughly one added paragraph.

`sql-ddl.md` is not a hub — it is one member of the `sql.md` family (`sql-select.md`,
`sql-dml.md`, `sql-ddl.md`, `sql-alter.md`, `sql-views.md`, `sql-functions.md`, `sql-txn.md`),
indexed by the `## Topic documents` table in `docs/sql.md`. The split therefore produces **new
siblings**, not satellites: two more rows in that table, following the same shape as
`docs/sql-alter.md`.

## What moves

Two whole top-level sections, both already self-contained chapters that `sql.md` itself once
owned (it still carries "Moved to …" stubs for them):

| Section | Lines at `3327c350` | Words | Destination |
| --- | --- | --- | --- |
| `## 6. Virtual Tables` (6.1 Creating, 6.2 Built-in modules, 6.3 Indexes on virtual tables) | 654–834 | 1,963 | `docs/sql-vtab.md` |
| `## 7. Constraints and Indexes` (7.1 PRIMARY KEY … 7.8 Dropping Indexes) | 835–1177 | 2,256 | `docs/sql-constraints.md` |

What stays in `sql-ddl.md`: declarative schema (§ 2.0), `CREATE TABLE` (§ 2.6), assertions
(§ 2.6.1), mutation context (§ 2.6.2), metadata tags (§ 2.6.3), and the `ALTER TABLE` pointer
(§ 2.7).

Expected sizes: `sql-ddl.md` ≈ **7,590** words (7,531 plus intro/index edits) — a ~4,400-word
margin. `sql-vtab.md` ≈ 2,050, `sql-constraints.md` ≈ 2,350. No ratchet entry for any of them;
`docs/.doc-budget.json` must be byte-identical afterwards.

Both sections are moved in one ticket because they share a single index (`sql.md`'s topic table),
a single `.stability.json` edit, and one overlapping set of inbound links — splitting them across
two tickets would mean editing the same eight files twice.

## Shape of the new documents

Copy `docs/sql-alter.md`'s opening exactly — H1, `Stability: Stable` banner, then one line
placing the document in the family:

```markdown
# SQL Virtual Tables

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 6. Virtual Tables
…
```

**Keep the section numbering and every heading verbatim.** `## 6. Virtual Tables` stays an H2
under the new H1, `### 6.3 Indexes on Virtual Tables` stays as it is, and likewise for § 7.1–7.8.
The numbers are load-bearing: a dozen inbound links and three source-comment markers name them,
and keeping the headings identical means only the *file* half of each link changes. Do not
renumber and do not reword.

**Move the prose verbatim** — no rewriting, no re-ordering. Prove it with a diff against the
baseline commit (see TODO).

Neither moved section carries a section-level stability banner (checked at `3327c350`), so each
new document has exactly one banner, its own. `sql-ddl.md` keeps its § 2.0 section banner.

Two same-document anchors live inside the § 7 block — `[§ 7.1](#71-primary-key-constraint)` and
`[§ 7.6](#76-foreign-key-constraint)` — and stay internal to `sql-constraints.md`, so they remain
valid without edits. The block also links `sql-alter.md`, which survives the move unchanged (same
directory).

## Inbound references to repoint

Twelve markdown/TypeScript references at `3327c350`. Change the file half, keep the anchor:

| Site | Anchor | New file |
| --- | --- | --- |
| `docs/functions.md` | `#63-indexes-on-virtual-tables` | `sql-vtab.md` |
| `docs/invariants.md` (×2, lines 1065 and 1132) | `#63-indexes-on-virtual-tables` | `sql-vtab.md` |
| `docs/schema.md` | `#63-indexes-on-virtual-tables` | `sql-vtab.md` |
| `docs/sql-alter.md` (×4: lines 51, 71, 131, 246) | `#63-indexes-on-virtual-tables` | `sql-vtab.md` |
| `docs/sql.md:67` | `#6-virtual-tables` | `sql-vtab.md` |
| `docs/sql-alter.md:132` | `#7-constraints-and-indexes` | `sql-constraints.md` |
| `docs/sql.md:72` | `#7-constraints-and-indexes` | `sql-constraints.md` |
| `docs/runtime.md` | `#76-foreign-key-constraint` | `sql-constraints.md` |

Regenerate the list rather than trusting these line numbers:

```bash
grep -rn --include=*.md --include=*.ts -E 'sql-ddl\.md#(6|7)' . \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=tickets
```

**Three prose markers the checker cannot see.** `bareDocRefs()` in `scripts/check-docs.mjs` stops
at `.md`, so a `§ 6.3` marker keeps passing after § 6.3 moves — the file half still resolves.
(That hole is the open ticket `backlog/debt-check-docs-validate-section-markers`; do not re-file
it.) These must be fixed by hand:

- `packages/quereus/src/schema/manager.ts:2500` — `(docs/sql-ddl.md §6.3)`
- `packages/quereus/src/schema/manager.ts:2605` — `(docs/sql-ddl.md §6.3)`
- `packages/quereus/src/schema/schema-differ.ts:329` — `documented in docs/sql-ddl.md § 6.3 and SCH-001`

Re-grep after the move (`grep -rn 'sql-ddl.md §' packages docs --include=*.ts --include=*.md`) to
catch any this list missed.

## `docs/sql.md` edits

`sql.md` is the family index and needs three changes:

- **Topic-documents table** — the `sql-ddl.md` row currently reads "Declarative schema,
  `CREATE TABLE`, assertions, mutation context, metadata tags, virtual tables, constraints and
  indexes". Drop the last two clauses and add two rows in the family's existing order (§ 6 before
  § 7, both after `sql-alter.md`'s row would put them out of numeric order — place them where the
  table reads naturally and keep one line per document).
- **`## 6. Virtual Tables` stub (line 67)** and **`## 7. Constraints and Indexes` stub (line 72)**
  — repoint from `sql-ddl.md#…` to the new files.
- Leave the `<!-- NOTE: … -->` block above the table alone; it describes the stub convention and
  is still true.

## Invariants

Do not mint a new invariant. Three existing entries already carry `doc:` links into the moved
sections (`docs/invariants.md` lines 1065 and 1132 into § 6.3, plus SCH-001 named by the
`schema-differ.ts` comment); repointing them is the whole obligation. Editing `INVARIANT_HEADING`
in `scripts/check-docs.mjs` is out of scope.

## Edge cases & interactions

- **Duplicate anchor slugs.** Splitting one document into three redistributes headings; two
  headings with identical text in one file get `-1`/`-2` suffixes and silently shift an anchor.
  Slugify every heading in all three documents and assert no duplicate base slug is *introduced*.
  Numbered headings (`### 7.1 …`) make collisions unlikely but § 6.2's per-module subheadings are
  generic enough to be worth the check.
- **Anchors must survive the move.** The whole repoint plan assumes `#63-indexes-on-virtual-tables`
  slugifies identically in the new file. It does — slugs derive from heading text — but a single
  reworded heading breaks a dozen links at once. Verify by running the checker, which fails on a
  dead anchor.
- **Section numbering now spans documents.** After this change § 6 and § 7 live outside
  `sql-ddl.md` while § 2.x stays. That is already true of the family (§ 2.7 lives in
  `sql-alter.md`, § 8/§ 9 in `sql-txn.md`), so keep the numbers and let `sql.md` be the map.
- **Classification is mandatory.** Add `"docs/sql-vtab.md": "Stable"` and
  `"docs/sql-constraints.md": "Stable"` to the `docs` map in `docs/.stability.json`, in its
  existing sort order. This file is shared with the sibling tickets
  (`1-docs-split-optimizer-costing`, `3-docs-split-isolation-design`) — re-read immediately before
  writing.
- **Banner form is pinned.** One wrong character reports as *malformed*, not *missing*. Copy from
  `sql-alter.md`.
- **README links.** `packages/quereus/README.md` and the root `README.md` index the docs folder;
  the checker validates their bare `docs/*.md` refs, and `documentation.spec.ts` independently
  validates README relative links. Check whether either names `sql-ddl.md` for content that moved.
- **No stub inside `sql-ddl.md`.** Every inbound link is repointed and `sql.md` already holds the
  stubs for these two sections; a second layer of stubs would make a live link indistinguishable
  from a stale one. Delete the sections outright.
- **No new ratchet entry.** `docs/.doc-budget.json` stays byte-identical; its only entry remains
  `docs/lens.md`.
- **Exit 0 is not success.** `node scripts/check-docs.mjs` prints near-cap notices and still exits
  0. Read the printed lines.

## TODO

- Record the baseline: `node scripts/check-docs.mjs` and `git rev-parse HEAD`.
- Create `docs/sql-vtab.md` (H1 `# SQL Virtual Tables`) and `docs/sql-constraints.md`
  (H1 `# SQL Constraints and Indexes`), each with the Stable banner and the
  `Part of the [Quereus SQL Reference](sql.md) …` line, carrying their section verbatim.
- Delete lines 654–1177 from `docs/sql-ddl.md` (no stub) and adjust its intro if it enumerates the
  removed chapters.
- Add both entries to `docs/.stability.json` — re-read the file first.
- Update `docs/sql.md`: the `sql-ddl.md` topic-table row, two new rows, and the two "Moved to"
  stubs at lines 67 and 72.
- Repoint the twelve inbound anchors (regenerate the list with the grep above).
- Repoint the three `§ 6.3` prose markers in `manager.ts` and `schema-differ.ts`, then re-grep.
- Verify verbatim: `git show <baseline>:docs/sql-ddl.md`, extract lines 654–834 and 835–1177, and
  `diff` each against the corresponding new document's body.
- Check duplicate anchor slugs across all three documents.
- Run `node scripts/check-docs.mjs` — no near-cap or over-cap line for `sql-ddl.md`, no new line
  for either new document, ends `Docs OK`. `docs/lens.md`'s grace-band notice is pre-existing.
- Confirm `git diff docs/.doc-budget.json` is empty.
- Run `yarn lint` (two `.ts` files changed, comment-only) and
  `yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts`.
- `yarn test` is **not** required — documentation plus two comment edits, no runtime behaviour
  touched. State that explicitly in the review handoff.
