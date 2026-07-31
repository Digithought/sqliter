---
description: The documentation size check fails on the main branch — three documents have grown past the maximum length recorded for them — so the project's standard verification command stops at its first step for everyone, on every change. Split three oversized sections into their own documents to get back under the limits.
files:
  - docs/sync.md                     # split out `## Schema Synchronization` + `## Schema Seed…` (lines 1185-1378, 1545-1617)
  - docs/schema.md                   # split out `### View and materialized-view persistence` (lines 312-479)
  - docs/module-authoring.md         # split out `## Capability negotiation surface` (lines 432-583)
  - docs/sync-schema.md              # NEW — receives the sync.md sections
  - docs/view-persistence.md         # NEW — receives the schema.md section
  - docs/module-capabilities.md      # NEW — receives the module-authoring.md section
  - docs/.doc-budget.json            # the register of per-document maximums
  - docs/.stability.json             # every doc must be classified; each new doc needs an entry + banner
  - docs/doc-conventions.md          # what belongs in a doc; how to lower an entry
  - scripts/check-docs.mjs           # the check; `--update-ratchet` lowers entries
  - docs/architecture.md             # 2 inbound anchors into moved sections
  - docs/store.md                    # 1 inbound anchor
  - docs/memory-table.md             # 1 inbound anchor
  - docs/materialized-views.md       # 1 inbound anchor
  - packages/quereus-store/README.md # 1 inbound anchor
  - packages/quereus/src/vtab/capabilities.ts               # 2 prose `§` markers
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # 1 prose `§` marker
difficulty: medium
---

## What is wrong

`yarn docs:check` (`node scripts/check-docs.mjs`) is the **first** step of `yarn check`, so
while it fails nothing downstream — lint, build, typecheck, tests — ever runs. Reproduced at
HEAD `e6060ced` with a clean tree:

```
docs/module-authoring.md: 12441 words exceeds the 12000-word cap for an unratcheted doc (+441)
docs/schema.md:           13802 words exceeds its ratchet of 13459 (+343)
docs/sync.md:             14477 words exceeds its ratchet of 13797 (+680)
```

Nothing else in the check fails: links, anchors, invariant format, and stability banners all pass.

Every document has a recorded maximum in `docs/.doc-budget.json`. A document may shrink (and
the recorded maximum drops to match) but may never grow past what is recorded.
`docs/module-authoring.md` has no entry at all, so it is measured against the global
12,000-word cap and cannot be grandfathered in — it must actually get shorter.

## The one non-obvious constraint: the ratchet update is all-or-nothing

`updateRatchet()` in `scripts/check-docs.mjs:522` collects **every** over-budget document into
a `refusals` list and, if that list is non-empty, prints and `return 1`s **before writing
anything** (`scripts/check-docs.mjs:554-559`). So `--update-ratchet` cannot be run
incrementally: fixing only `docs/schema.md` and running it still writes nothing, because
`docs/sync.md` is still over.

**Consequence: all three documents must come under budget in the same change.** That is why
this is one ticket rather than three, and why the ratchet update is the last step, not a
per-document step.

## The plan: three splits along existing H2/H3 boundaries

Each split moves one self-contained section into a new `docs/*.md`, leaving a short pointer
stub behind. The precedent for the stub form already exists in the tree —
`docs/schema.md:305-310` (`### Store catalog persistence`) is a five-line stub pointing at
`store.md § Catalog persistence`, left by the earlier doc-split pass. Copy that shape.

All three sections are normative contract prose, not narrative history, so **deleting** the
recent additions is not the fix; relocating them is.

### 1. `docs/module-authoring.md` → `docs/module-capabilities.md`

Move `## Capability negotiation surface`, **lines 432–583** (2,650 words; ends at
`## Runtime Execution Modes`, line 584). Sub-headings that travel with it:

```
### Signaling styles
### Classification legend
### Surface inventory
### DDL transactionality tiers
### `alterTable` sub-arms — the fine-grained mandate layer
### Recommended capability-negotiation pattern
```

Result: `module-authoring.md` ≈ 9,830 words (under the 12,000 cap, ~2,170 spare);
`module-capabilities.md` ≈ 2,690. Tier **Stable**, matching its parent doc.

The section opens by describing itself as "the single inventory of every negotiation surface",
which is exactly a standalone-doc topic — it reads as a reference table sitting inside a
tutorial-shaped guide.

### 2. `docs/sync.md` → `docs/sync-schema.md`

Move **two** sections, both about replicating schema rather than data:

- `## Schema Synchronization`, **lines 1185–1378** (1,454 words; ends at `## Configuration`,
  line 1379). Sub-headings: `### Design Principles`, `### Schema Metadata Storage`,
  `### Conflict Resolution: Most Destructive Wins`, `### DDL Application Order`,
  `### Schema Change Types`, `### Applying Remote Schema Changes`,
  `### Idempotent DDL application`, `### What replicates`.
- `## Schema Seed: App Provider as Sync Peer`, **lines 1545–1617** (551 words; runs to
  end of file). Sub-headings: `### Motivation`, `### Architecture`,
  `### The Well-Known App Provider Site ID`, `### Efficient Delta Sync`,
  `### User Schema Customizations`, `### What's Provided by Quereus`,
  `### What's App-Specific`.

Result: `sync.md` ≈ 12,510 (ratchet 13,797 → lowered to actual, ~1,290 under the old figure);
`sync-schema.md` ≈ 2,050. Tier **Experimental**, matching its parent doc.

Moving only the first section would also clear the budget (≈13,060 vs. a 13,797 ratchet), but
the two sections are one topic and the second is the tail of the file, so moving both is the
cleaner seam and buys real headroom.

### 3. `docs/schema.md` → `docs/view-persistence.md`

Move `### View and materialized-view persistence`, **lines 312–479** (1,732 words; ends at
`## Schema Path`, line 480). No sub-headings. Leave a stub in the same shape as its immediate
neighbour `### Store catalog persistence` at line 305.

Result: `schema.md` ≈ 12,110 (ratchet 13,459 → lowered); `view-persistence.md` ≈ 1,770.
Tier **Beta**, matching both `schema.md` and `store.md`.

This section is store-persistence detail — reserved-prefix catalog keys, the persist queue,
rehydrate phasing — living in the schema-management doc. It is the same content class the
earlier split pass already moved out of `schema.md` into `store.md`.

**Rejected: folding it into `docs/store.md` instead.** `store.md` measures 10,040 words
(`node -e` over whitespace tokens, same method as the checker); 10,040 + 1,732 = 11,772, which
leaves 228 words under the 12,000 cap. That is one paragraph of headroom on an actively-edited
doc — it would be red again within a couple of tickets. Cross-link the two instead: add a
pointer to `view-persistence.md` from `store.md § Catalog persistence (bundled index DDL)`
(line 351).

## Every reference that has to be repointed

Two classes, found by scanning `docs/`, `packages/*/src`, `packages/*/test` and the READMEs.
The checker catches the first class and is **blind to the second** — a stale `§` marker never
fails the build, so it has to be fixed by hand.

### Markdown anchors (checker-enforced — Check A fails on a dead one)

| From | Current target | Becomes |
| --- | --- | --- |
| `docs/architecture.md:111` | `module-authoring.md#ddl-transactionality-tiers` | `module-capabilities.md#ddl-transactionality-tiers` |
| `docs/store.md` | `module-authoring.md#ddl-transactionality-tiers` | `module-capabilities.md#…` |
| `docs/memory-table.md` | `module-authoring.md#ddl-transactionality-tiers` | `module-capabilities.md#…` |
| `docs/materialized-views.md` | `module-authoring.md#ddl-transactionality-tiers` | `module-capabilities.md#…` |
| `docs/module-authoring.md:891` | `#altertable-sub-arms--the-fine-grained-mandate-layer` | `module-capabilities.md#…` |
| `docs/module-authoring.md:908` | `#recommended-capability-negotiation-pattern` | `module-capabilities.md#…` |
| `docs/schema.md:110` | `#view-and-materialized-view-persistence` | `view-persistence.md` (or its H1 anchor) |
| `packages/quereus-store/README.md` | `docs/schema.md#view-and-materialized-view-persistence` | `docs/view-persistence.md#…` |

Links that travel **out** with a moved section and become cross-document:

| In the moved text | Current | Becomes |
| --- | --- | --- |
| `module-authoring.md:449` | `#3-concurrency-mode-parallel-runtime` | `module-authoring.md#3-concurrency-mode-parallel-runtime` |
| `module-authoring.md:550` | `#schema-changes-schemachangeinfo` | `module-authoring.md#schema-changes-schemachangeinfo` |
| `sync.md:1557` | `#transactional-integrity-during-sync` | `sync.md#transactional-integrity-during-sync` |

Links inside moved text that stay valid because the new docs sit in `docs/` too (verify, do not
edit): `module-authoring.md:472,568` → `schema.md`; `:533` → `architecture.md`; `:484` →
`../packages/quereus-isolation/README.md`; `schema.md:460` → `mv-backing-host.md#cross-module-atomicity`.

### Prose `§` markers in source comments (NOT checker-enforced — fix by hand)

`bareDocRefs()` in the checker stops at `.md`, so a trailing `§ Section` is never validated.
These point at moved sections:

- `packages/quereus/src/vtab/capabilities.ts:28` and `:44` —
  `docs/module-authoring.md § "Capability negotiation surface"` → `docs/module-capabilities.md § …`
- `packages/quereus-sync/src/sync/sync-manager-impl.ts:706` —
  `docs/sync.md § DDL Application Order` → `docs/sync-schema.md § DDL Application Order`

Markers that stay correct (checked — their targets do not move): `§ alterPrimaryKey`
(`runtime/emit/alter-table.ts:1692`, `quereus-isolation/src/isolation-module.ts:1359`),
`§ "Schema Changes"` (`vtab/module.ts:402`, both `alter-table-conformance.spec.ts`),
`§ "Identifier casing…"`, `§ Rename Detection`, `§ Seed Data`, `§ Mutation Statements`,
`§ View / materialized-view definition`, and every `docs/sync.md §` marker other than
`§ DDL Application Order`. Files under `dist/` carry stale copies; they regenerate.

## Classifying the three new docs

`docs:check` Check D fails a `docs/*.md` that is not classified, so each new doc needs **both**
an entry in `docs/.stability.json` under `docs` and a banner directly under its `# ` heading:

```markdown
> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).
```

The banner form is exact — em dash (U+2014), the literal `stability.md#tiers` target, trailing
full stop. Tiers: `module-capabilities.md` **Stable**, `sync-schema.md` **Experimental**,
`view-persistence.md` **Beta** (each matching its parent doc's current entry). There is no
`--update-stability` flag; the entries are hand-edited.

## Lifting invariants (do this, but keep it small)

`docs/doc-conventions.md` says a design-doc split is the moment to lift normative statements
into `docs/invariants.md` rather than restating them. Two clear candidates sit in the moved
text; both are stated today only as prose:

- **No silent divergence on `alterTable`** — `module-authoring.md:580`: a module that cannot
  honor an invoked arm must throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message
  and never silently no-op. Area `SCH`; the highest existing id is `SCH-003`
  (`docs/invariants.md:1043`), so this is `SCH-004`.
- **DDL before DML in a sync batch** — `sync.md § Design Principles` item 4 / `§ DDL
  Application Order`. Area `SYNC` is in the checker's accepted area list
  (`scripts/check-docs.mjs:347`) but has **no entries yet**, so this would be `SYNC-001`.

Each entry needs at least one `code:` line and exactly one `guard:` line naming a real file
and a symbol that appears in it, and must state itself in ≤120 words. Copy the shape of an
existing block. Where a lifted invariant lands, the moved section carries a one-line
back-link using the **full** heading slug (the em dash slugifies to a double hyphen) and stops
restating it. `docs/invariants.md` is 8,827 words against the 12,000 cap, so a couple of
entries is affordable — do not let this arm grow into a register-wide audit.

If the `guard:` line for either candidate cannot be filled with a real test, write
`guard: none — <reason>` (legal and explicit) rather than inventing one, or skip that entry and
say so in the handoff.

## Constraints

- **Never raise a ratchet.** `--update-ratchet` only lowers. `--force` raises and needs a
  commit-message justification; it is not the plan here and should not be reached for.
- **Do not touch `docs/lens.md`.** Its oversize is a deliberate human-owned exemption — see
  `blocked/debt-docs-split-lens-when-stable`.
- **Words come out of a split, not out of load-bearing detail.** All three moved sections are
  normative contract; move them intact rather than trimming them to fit.
- Nothing here is an engine change: no determinism edition bump, no byte-format vector, no
  golden fixture, no migration. Doc + comment edits only.

## Verifying

```bash
node scripts/check-docs.mjs                    # must be clean before the ratchet update
node scripts/check-docs.mjs --update-ratchet   # lowers schema.md and sync.md to actual
node scripts/check-docs.mjs                    # green
```

Measure a doc the way the checker does (whitespace tokens over the whole file, fenced code
included):

```bash
node -e "const fs=require('fs');const w=p=>fs.readFileSync(p,'utf8').replace(/^﻿/,'').split(/\s+/).filter(Boolean).length;for(const f of process.argv.slice(1))console.log(w(f)+'  '+f)" docs/sync.md docs/schema.md docs/module-authoring.md
```

Note `docs/sync.md` opens with a byte-order mark; strip it when measuring by hand, as the
checker does (`readText`, `scripts/check-docs.mjs:67`).

Then run `yarn lint` (it type-checks the two touched `.ts` comment sites' packages) and
`yarn test` to confirm the comment edits broke nothing. `yarn check` should now get past its
first step.

## TODO

Phase 1 — split `docs/module-authoring.md`

- Create `docs/module-capabilities.md` with an H1, a `> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).` banner, and a one-paragraph intro naming what it covers and linking back to `module-authoring.md`.
- Move lines 432–583 of `docs/module-authoring.md` into it verbatim, promoting `## Capability negotiation surface` into the intro rather than keeping a duplicate H2 under the H1.
- Leave a pointer stub in `module-authoring.md` where the section was, in the shape of `docs/schema.md:305-310`.
- Rewrite the two links that leave the moved text (`:449`, `:550`) to `module-authoring.md#…`.
- Rewrite the two links from the rest of `module-authoring.md` into the moved text (`:891`, `:908`) to `module-capabilities.md#…`.
- Repoint `module-authoring.md#ddl-transactionality-tiers` in `docs/architecture.md`, `docs/store.md`, `docs/memory-table.md`, `docs/materialized-views.md`.
- Repoint the two `§ "Capability negotiation surface"` markers in `packages/quereus/src/vtab/capabilities.ts` (lines 28, 44).
- Add `"docs/module-capabilities.md": "Stable"` to `docs/.stability.json`.

Phase 2 — split `docs/sync.md`

- Create `docs/sync-schema.md` with an H1, an `Experimental` banner, and an intro linking back to `sync.md`.
- Move lines 1185–1378 and 1545–1617 into it, keeping both as H2 sections under the new H1.
- Leave a pointer stub in `sync.md` where `## Schema Synchronization` was; the tail section needs no stub beyond a mention in the stub or in `## Current limitations`.
- Rewrite `sync.md:1557`'s same-page link to `sync.md#transactional-integrity-during-sync`.
- Repoint the `§ DDL Application Order` marker in `packages/quereus-sync/src/sync/sync-manager-impl.ts:706`.
- Add `"docs/sync-schema.md": "Experimental"` to `docs/.stability.json`.
- Update `tickets/backlog/bug-sync-materialized-views-replicate-as-plain-tables.md`, whose `files:` header points at `docs/sync.md (§ What replicates)` — that section is moving.

Phase 3 — split `docs/schema.md`

- Create `docs/view-persistence.md` with an H1, a `Beta` banner, and an intro.
- Move lines 312–479 into it, keeping its internal structure.
- Leave a stub in `schema.md` mirroring the neighbouring `### Store catalog persistence` stub.
- Rewrite `schema.md:110`'s same-page link to point at the new doc.
- Repoint `docs/schema.md#view-and-materialized-view-persistence` in `packages/quereus-store/README.md`.
- Add a cross-link from `docs/store.md § Catalog persistence (bundled index DDL)` (line 351) to the new doc.
- Add `"docs/view-persistence.md": "Beta"` to `docs/.stability.json`.

Phase 4 — invariants (small)

- Lift `SCH-004` (no silent `alterTable` divergence) and, if a `guard:` can be named, `SYNC-001` (DDL before DML) into `docs/invariants.md`; add full-slug back-links from the moved sections and drop the restatement. Skip an entry rather than inventing a guard.

Phase 5 — close it out

- Add each new doc to the documentation index in `packages/quereus/README.md` (line ~181) and, where it fits, the top-level `README.md` list.
- `node scripts/check-docs.mjs` clean, then `node scripts/check-docs.mjs --update-ratchet`, then clean again.
- `yarn lint` and `yarn test` (stream with `tee`, per AGENTS.md).
- Confirm `docs/.doc-budget.json` shows `schema.md` and `sync.md` **lowered** and no entry added for any new doc — a new entry would mean something came in over 12,000.
