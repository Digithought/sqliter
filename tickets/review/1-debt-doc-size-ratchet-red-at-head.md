description: The documentation size check was failing on the main branch, which stopped the project's standard verification command before it ran anything else. Three overlong sections were moved into their own documents, and every link and comment pointing at them was updated.
files:
  - docs/module-capabilities.md      # NEW — from docs/module-authoring.md
  - docs/sync-schema.md              # NEW — from docs/sync.md
  - docs/view-persistence.md         # NEW — from docs/schema.md
  - docs/module-authoring.md         # stub left behind; 2 outbound links repointed
  - docs/sync.md                     # stub left behind; 1 prose marker repointed
  - docs/schema.md                   # stub left behind; 1 outbound link repointed
  - docs/.doc-budget.json            # schema.md + sync.md ratchets lowered
  - docs/.stability.json             # 3 new tier entries
  - docs/invariants.md               # NEW entries SCH-004, SYNC-001
  - docs/architecture.md             # anchor repointed
  - docs/store.md                    # anchor repointed + cross-link added
  - docs/memory-table.md             # anchor repointed
  - docs/materialized-views.md       # anchor repointed
  - README.md                        # doc index: 3 new entries
  - packages/quereus/README.md       # doc index: 2 lines extended
  - packages/quereus-store/README.md # link repointed
  - packages/quereus/src/vtab/capabilities.ts           # 2 prose `§` markers repointed
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # 1 prose `§` marker repointed
  - scripts/check-docs.mjs           # comment only (tripwire NOTE)
difficulty: medium
----

## What landed

`yarn docs:check` was red at HEAD `5381f7d0`: three documents exceeded their recorded
maximum word count, and because that check is the first step of `yarn check`, nothing after
it ever ran. Three self-contained sections were relocated into new documents, each leaving a
short pointer stub behind. No prose was deleted to make room — the moved text is verbatim
apart from the link edits listed below.

| Was | Now | Words before → after |
| --- | --- | --- |
| `docs/module-authoring.md § Capability negotiation surface` | `docs/module-capabilities.md` | 12441 → **9793** (cap 12000) |
| `docs/sync.md § Schema Synchronization` + `§ Schema Seed` | `docs/sync-schema.md` | 14477 → **12538** (ratchet was 13797) |
| `docs/schema.md § View and materialized-view persistence` | `docs/view-persistence.md` | 13802 → **12109** (ratchet was 13459) |

New documents: `module-capabilities.md` 2625, `sync-schema.md` 2028, `view-persistence.md`
1792 — all under the 12,000 cap, so **no new ratchet entry was created** (the ticket's own
tell that nothing came in oversize). `docs/.doc-budget.json` now records `schema.md` 12109 and
`sync.md` 12538, both **lowered**. `docs/lens.md` was not touched.

Tiers, matching each parent document: `module-capabilities.md` **Stable**,
`sync-schema.md` **Experimental**, `view-persistence.md` **Beta**. Each carries the exact
banner form and an entry in `docs/.stability.json`.

Two invariants were lifted out of the moved prose into `docs/invariants.md`, both with a real
`guard:` (neither needed the `guard: none — <reason>` escape):

- **SCH-004** — a module never silently no-ops an `alterTable` arm; it must throw
  `UNSUPPORTED`. Guard: `packages/quereus/test/alter-table-conformance.spec.ts`
  → `ALTER conformance matrix — module without alterTable (sited UNSUPPORTED)`.
- **SYNC-001** — all DDL in a sync batch applies before any DML. Guard:
  `packages/quereus-sync/test/sync/apply-order-independence.spec.ts`
  → `creates the table and lands its rows`. This is the first entry in the `SYNC` area.

Three sections now carry a `> **Invariant:** …` back-link and had their restatement of the
rule removed (per `docs/doc-conventions.md`): `module-capabilities.md § alterTable sub-arms`
and its rule 4, `module-authoring.md § No silent divergence`, and
`sync-schema.md § DDL Application Order`.

## How to verify

```bash
node scripts/check-docs.mjs        # Docs OK: links resolve, invariants well-formed, sizes within ratchet, doc and package tiers declared.
yarn lint                          # clean (56s)
yarn test                          # all suites passing (6m 4s)
```

Measure a document the way the checker does — whitespace tokens over the whole file, fenced
code included, byte-order mark stripped (`docs/sync.md` has one):

```bash
node -e "const fs=require('fs');const w=p=>fs.readFileSync(p,'utf8').replace(/^﻿/,'').split(/\s+/).filter(Boolean).length;for(const f of process.argv.slice(1))console.log(w(f)+'  '+f)" docs/sync.md docs/schema.md docs/module-authoring.md
```

Confirm nothing stale is left pointing at a moved section (the `§` half of these is **not**
machine-checked — see below):

```bash
grep -rn "module-authoring.md#ddl-transactionality-tiers|schema.md#view-and-materialized-view-persistence|module-authoring.md . \"Capability|sync.md . DDL Application Order" -E docs packages README.md | grep -v /dist/
```

Expected: no hits outside this ticket's own text.

### Use cases worth reading by eye

The checker verifies that links resolve; it cannot verify that the split reads well. Worth a
human pass:

- **A module author following the guide.** Read `docs/module-authoring.md` top to bottom.
  The stub at `§ Capability negotiation surface` should hand off cleanly, and the two
  cross-document links out of the moved text (`§ Concurrency Mode` and `§ Schema Changes`,
  now `module-authoring.md#…` from inside `module-capabilities.md`) should land where a
  reader expects.
- **A reader arriving at `docs/module-capabilities.md` cold.** Its intro absorbed the old
  H2's opening paragraph; check it stands alone without the guide's preceding context.
- **Someone chasing view persistence from the store side.** `packages/quereus-store/README.md`
  → `docs/view-persistence.md#view-and-materialized-view-persistence` (the new H1's anchor),
  and `docs/store.md § Catalog persistence (bundled index DDL)` now opens by saying it covers
  tables only and points at the new document.
- **The two lifted invariants.** Read SCH-004 and SYNC-001 against the code they name, and
  check the three back-linked sections still make sense with the rule removed — that is the
  edit most likely to have left an awkward seam.

## Known gaps and things the reviewer should push on

- **Prose `§` markers in source comments are not machine-checked.** `bareDocRefs()` in the
  checker stops at `.md`, so `docs/sync.md § DDL Application Order` would still pass with the
  section gone. Three markers were repointed by hand
  (`vtab/capabilities.ts:28,44`, `sync/sync-manager-impl.ts:706`); the rest were read and left
  alone because their targets did not move. If a fourth was missed, nothing will report it.
  Parked as a `NOTE:` at the exact site — `scripts/check-docs.mjs`, above `bareDocRefs`.
- **Trimmed prose is the weakest part of this change.** Removing a restated rule in favour of
  a back-link is a judgement call, and `sync-schema.md § DDL Application Order` in particular
  lost its topic sentence and had the following paragraph reworded to open the section
  instead. Re-read that one.
- **Duplicate-anchor suffixes were checked by hand, not by tool.** The checker assigns
  `-1`/`-2` in document order, so moving one of a pair of same-named headings silently
  retargets links to the other. Every heading in each moved block was compared against its
  source and destination document; no base slug repeated in either direction. This was a
  manual read, so it is worth a second look if a link behaves oddly.
- **`yarn check` was not run end to end.** Its `docs:check`, `lint` and `test` steps were each
  run directly and are green; the `build` and `typecheck` steps were not, on the grounds that
  the only `.ts` edits are inside comments. That reasoning is stated, not verified.
- **`yarn test:store` was not run** (slower LevelDB path). Nothing in this change touches
  runtime behavior, so it was skipped deliberately.
- No test was added. This change is documentation and comments only; there is no behavior to
  cover, and the two new invariants point at guards that already existed.

## Out of scope, deliberately

- `docs/lens.md` remains over its recorded size — a human-owned exemption tracked by
  `blocked/debt-docs-split-lens-when-stable`.
- The invariant register was not audited beyond the two entries the split surfaced.
