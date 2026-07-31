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
  - docs/architecture.md, docs/store.md, docs/memory-table.md, docs/materialized-views.md
  - README.md, packages/quereus/README.md, packages/quereus-store/README.md
  - packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/vtab/module.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - scripts/check-docs.mjs           # comment only
----

## What landed

`yarn docs:check` was red at HEAD `5381f7d0`: three documents exceeded their recorded maximum
word count, and because that check is the first step of `yarn check`, nothing after it ever
ran. Three self-contained sections were relocated into new documents, each leaving a short
pointer stub behind.

| Was | Now | Words before → after |
| --- | --- | --- |
| `docs/module-authoring.md § Capability negotiation surface` | `docs/module-capabilities.md` | 12441 → **9793** (cap 12000) |
| `docs/sync.md § Schema Synchronization` + `§ Schema Seed` | `docs/sync-schema.md` | 14477 → **12538** (ratchet was 13797) |
| `docs/schema.md § View and materialized-view persistence` | `docs/view-persistence.md` | 13802 → **12109** (ratchet was 13459) |

New documents: `module-capabilities.md` 2625, `sync-schema.md` 2028, `view-persistence.md`
1792 — all under the 12,000 cap, so no new ratchet entry was created. `docs/.doc-budget.json`
now records `schema.md` 12109 and `sync.md` 12538, both lowered.

Tiers match each parent document: `module-capabilities.md` **Stable**, `sync-schema.md`
**Experimental**, `view-persistence.md` **Beta** (its parent `schema.md` is Beta).

Two invariants were lifted out of the moved prose into `docs/invariants.md`, both with a real
`guard:`:

- **SCH-004** — a module never silently no-ops an `alterTable` arm; it must throw `UNSUPPORTED`.
- **SYNC-001** — all DDL in a sync batch applies before any DML. First entry in the `SYNC` area.

Three sections carry a `> **Invariant:** …` back-link with their restatement of the rule
removed, per `docs/doc-conventions.md`.

## Review findings

### Fixed in this pass

**Four stale prose section markers (`docs/foo.md § Section Name`).** The implement handoff
flagged that `bareDocRefs()` in `scripts/check-docs.mjs` stops at `.md`, so the `§` half of
these markers is never machine-checked, and reported that the surviving markers had been read
by hand. A full sweep — `grep -rniE "§ ?\"?(DDL transactionality|Capability negotiation
surface|Schema Synchronization|Schema Seed|DDL Application Order|View and materialized-view
persistence|Surface inventory|alterTable sub-arms|Recommended capability)"` over `docs/` and
`packages/*/src` — found four that were wrong:

| Site | Was | Now |
| --- | --- | --- |
| `docs/store.md:959` | `schema.md § View and materialized-view persistence` | `view-persistence.md` |
| `packages/quereus/src/vtab/module.ts:569` | `docs/schema.md § View and materialized-view persistence` | `docs/view-persistence.md` |
| `packages/quereus/src/vtab/capabilities.ts:28` | `docs/module-capabilities.md § "Capability negotiation surface"` | `§ "DDL transactionality tiers"` |
| `packages/quereus/src/vtab/capabilities.ts:44` | same | `§ "Surface inventory"` |

The first two are sections the split moved and did not repoint. The last two are worse: the
split *did* edit those lines, moving the file half to `module-capabilities.md` while leaving a
section name that exists only in `module-authoring.md`. `module-capabilities.md` has no
`Capability negotiation surface` heading — its H1 is `Module Capability Negotiation`.

**`SYNC-001`'s `code:` pointer named a symbol that is not defined where it points.**
`packages/quereus-sync/src/sync/store-adapter.ts` — `applyToStore` passed the checker only
because the string appears in that file's header comment (`checkInvariantPointer` is a
documented substring match). The function that actually implements the law — schema loop
before data loop — is `createStoreAdapter`. Repointed.

### Filed as a ticket

**`backlog/debt-check-docs-validate-section-markers`** — teach `scripts/check-docs.mjs` to
validate the `§ Section Name` half of a prose marker against the target document's headings.
The implement handoff parked this as a tripwire ("if a split ever ships a stale one…"). It is
not conditional: this split shipped four, two of them introduced by its own edits, which is
what promotes it from a tripwire to a defect with a known code site. The `NOTE:` above
`bareDocRefs` was rewritten to say what actually happened and to name the ticket rather than
claim hand-fixing has worked. The ticket also records the two open design questions (where a
marker ends when it runs into surrounding prose; how to handle numbered `§6.3` and
heading-fragment markers) — both have real instances in the tree today.

`tickets/backlog/debt-check-docs-script-too-large` also touches `scripts/check-docs.mjs`, but
is explicitly a move-and-split with no behavior change and states adding a check is out of
scope, so this is a separate ticket rather than an arm on it. The relationship is written into
both directions of the new ticket's body.

### Checked, no finding

- **The moved text is verbatim.** Diffed each moved block against its source at `5381f7d0`
  (`git show 5381f7d0:docs/schema.md`, `sed` the line range, `diff` against the new document).
  `view-persistence.md` differs from its source only in the H1 + stability banner + new intro
  paragraph. `module-capabilities.md` and `sync-schema.md` differ additionally only in the
  documented link repoints and the two invariant back-links.
- **Duplicate anchor suffixes.** The handoff called this out as hand-checked. Verified with a
  script that slugifies every heading in the six affected documents and counts collisions: the
  only two duplicate base slugs (`overview` in `module-authoring.md`, `architecture` in
  `store.md`) both pre-date this change and neither is inside a moved block, so no `-1`/`-2`
  suffix shifted.
- **No stale anchor-style links.** Grepped every pre-move anchor form
  (`schema.md#view-and-materialized-view-persistence`,
  `module-authoring.md#ddl-transactionality-tiers`, `#altertable-sub-arms`, `sync.md#schema-seed`,
  and five others) across `.md`, `.ts` and `.json`. Zero hits. `check-docs.mjs` would have
  caught these anyway; the manual sweep confirms it.
- **Both new invariants' guards genuinely exercise their law.** Read
  `alter-table-conformance.spec.ts:577` and `apply-order-independence.spec.ts:219` against the
  code they name. SCH-004's guard sweeps every no-fallback `alterTable` arm against a stub
  module and asserts a sited `UNSUPPORTED`, plus asserts the two documented exemptions are
  honored rather than refused. SYNC-001's guard reverses a batch carrying one table's
  `create_table` and its rows and asserts the rows land.
- **Tiers and ratchets.** Each new document's tier matches its parent, the banner form is the
  one `check-docs.mjs` self-tests, all three came in under the 12,000-word cap so no ratchet
  entry was minted, and the two lowered entries match the measured counts exactly.
- **`yarn check` end to end.** The handoff skipped `build` and `typecheck` on the reasoning
  that only comments changed. Both were run here and are green (`yarn build` 51s, `yarn typecheck`
  31s), closing that gap rather than accepting the reasoning.

### Noticed, deliberately not filed

- **`docs/view-persistence.md` is 1792 words under a single H1 with no subheadings.** Its
  source was a flat `### View and materialized-view persistence` with the same structure, and
  the five bold lead-ins (`**Incremental writes (the listener).**`, `**Rehydrate phasing.**`, …)
  already mark the boundaries. Promoting them to headings would mean rewriting the sentences
  they open, which is prose editing the split deliberately avoided. Left as-is; the document is
  linked from the store README and from `schema.md` by its H1 anchor only, so no navigation is
  broken.
- **SYNC-001's guard is a pin, not a discriminating regression test, for half the invariant.**
  The test's own comment says so: "A PIN, not a repro: it passes with either sort removed." It
  does catch inverting the DDL-before-DML relation (rows would land on a table that does not
  exist yet), which is the invariant's headline. It does not catch removing the HLC sort — but
  the sibling test `replays create_table then drop_table in HLC order, not arrival order` does,
  and `check-docs.mjs` permits exactly one `guard:` line per invariant, so the headline law was
  the right one to name.
- **`docs/sync.md` (12538) and `docs/schema.md` (12109) are still above the 12,000-word cap,**
  held by ratchet entries rather than being genuinely under budget. This was the ticket's goal —
  unred the gate — and both are now free to shrink but not grow. `docs/.doc-budget.json` records
  the exact numbers, so the next editor of either file meets the constraint at the point it
  bites. Not a defect and not worth a ticket at 109 and 538 words over.
- **`docs/lens.md` (17934) remains over its recorded size** — a human-owned exemption already
  tracked by `blocked/debt-docs-split-lens-when-stable`.

## Verification

```
node scripts/check-docs.mjs   Docs OK
yarn build                    green (51s)
yarn typecheck                green (31s)
yarn lint                     green (43s)
yarn test                     green (4m 45s) — 8277 + 355 + 113 + 63 + 17 + 28 + 1248 + 643
                              + 52 + 31 + 34 + 134 + 22 passing, 0 failing
```

`yarn test:store` was not run. This change is documentation, comments, and one JSON pointer;
no runtime behavior is touched, so the LevelDB path has nothing new to exercise.

No test was added, for the same reason — there is no behavior to cover, and the two new
invariants point at guards that already existed.
