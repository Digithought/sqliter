---
description: The transaction-isolation design note was 127 words from the size limit the documentation checker enforces; its longest chapter now lives in its own note, and its list of unbuilt optimizations moved out of the docs folder into a backlog ticket. Review the split.
files:
  - docs/design-isolation-layer.md                        # 11,873 → 6,995 words
  - docs/design-isolation-challenges.md                   # NEW satellite, 3,506 words, no banner
  - docs/.stability.json                                  # new doc added to `untiered`
  - docs/todo.md                                          # line 20 repointed at the backlog ticket
  - packages/quereus-isolation/src/isolation-module.ts    # line 460 prose marker repointed
  - tickets/backlog/feat-isolation-overlay-fast-paths.md  # NEW, carries the removed chapter verbatim
difficulty: medium
---

# What landed

Baseline `355ca1ab`, working tree clean at start.

`docs/design-isolation-layer.md` went from **11,873 words** (127 from the hard 12,000-word cap,
which has no grace band) to **6,995 words**. Three things came out:

| Was | Words | Now |
| --- | --- | --- |
| `## Challenges and Mitigations` (six numbered sub-sections) | 3,430 | `docs/design-isolation-challenges.md` |
| `## Optimization Strategies` (overhead analysis, Optimizations 1–7, summary table, order) | 1,140 | `tickets/backlog/feat-isolation-overlay-fast-paths.md`, verbatim |
| `## TODO` (Phase 1–6 checklist, mostly `✅`) | 355 | deleted; its three unchecked items are in the same backlog ticket |

`docs/.doc-budget.json` is byte-identical (`git diff` empty) — no ratchet entry for either doc.
`node scripts/check-docs.mjs` ends `Docs OK` with **no** line for either isolation doc; the only
notice printed is `docs/lens.md`'s pre-existing grace-band line, unchanged from the baseline run.

## The new note

`docs/design-isolation-challenges.md` — H1, **no stability banner** (both docs are `untiered`,
and the checker fails an untiered doc that carries one), a four-line intro closing
`A satellite of [Isolation Layer Design](design-isolation-layer.md).`, then the moved block with
every heading promoted one level (`### 1. Merge Iteration Complexity` → `## 1. …`,
`##### Poison lifecycle` → `#### Poison lifecycle`). Heading *text* is untouched, so all thirteen
slugs survive. The `## Challenges and Mitigations` heading itself is gone; nothing linked it.

Added to the `untiered` array in `docs/.stability.json` (re-read immediately before editing —
the sibling splits had already landed their entries).

Where the chapter was, `design-isolation-layer.md` now carries a four-line prose pointer between
the two `---` rules that already bracketed the section (lines 823–829). No stub heading. The
document has no `## Topic documents` table, so this pointer is the only navigation to the note.

## Verification to redo

**The move is verbatim except for four deliberate edits.** Reproduce:

```bash
git show 355ca1ab:docs/design-isolation-layer.md | sed -n '826,966p' \
  | sed -E 's/^(#+)#( )/\1\2/' > /tmp/expected.md
sed -n '11,$p' docs/design-isolation-challenges.md > /tmp/actual.md
diff /tmp/expected.md /tmp/actual.md
```

Expect exactly four hunks, all of them relative cross-references that stopped resolving once the
block left the file. `docs/doc-conventions.md` § The size ratchet mandates this sweep ("turn any
reference that now crosses the file boundary into a real link"), which is why they deviate from
the ticket's "move the prose verbatim":

- `(see § Commit)` → `(see [§ Commit](design-isolation-layer.md#commit))`
- `behavior documented above` → `behavior documented in [§ Isolation Level Provided](design-isolation-layer.md#isolation-level-provided)`
- two occurrences of `*Invariant: every staged overlay resolves to an underlying table at commit*` → links to that section in the hub

The reverse direction had one too: `design-isolation-layer.md:163` said
`See *ALTER / DROP overlay poison* below` and now links into the satellite
(`#alter--drop-overlay-poison` — the dropped `/` leaves a double hyphen, matching the checker's
slugifier). Full sweep of the surviving hub for `above|below|earlier|later in this document`
found no other reference pointing into removed text; `line 362`'s "the two-phase flush below"
points at Phase 1/Phase 2 in the same section and is fine.

**Duplicate anchor check** — run over both docs, no duplicate base slug in either:

```bash
for f in docs/design-isolation-layer.md docs/design-isolation-challenges.md; do
  grep -E '^#{1,6} ' "$f" | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' \
    | sed -E 's/[^a-z0-9 _-]//g; s/ /-/g' | sort | uniq -d
done
```

**Inbound references** — regenerated with the ticket's grep. Repointed: `docs/todo.md:20` (now
`See \`tickets/backlog/feat-isolation-overlay-fast-paths.md\``) and
`packages/quereus-isolation/src/isolation-module.ts:460` (`docs/design-isolation-challenges.md
§ "Commit Failure Recovery"`). Confirmed still valid, not assumed: `docs/store.md:630`
(`#isolation-level-provided`, section stays), `docs/memory-table.md:655` (§ Key Ordering, stays),
`docs/stability.md:95` (whole file), `packages/quereus/src/vtab/table.ts:75` (§ "Table identity",
stays), `packages/quereus-isolation/src/isolated-table.ts:612` (whole file),
`packages/quereus-isolation/README.md:207` (absolute GitHub URL to the hub).

**Orphaned rules** — the `---` cadence separates every H2 in this document. After the removals:
the pointer sits between the two rules that already bracketed the challenges chapter, and the
TODO + Optimization Strategies removal collapses to a single `---` between `## Testing Strategy`
and `## References`. `## References` survives and still closes the document.

## The backlog ticket

`tickets/backlog/feat-isolation-overlay-fast-paths.md` carries the `## Optimization Strategies`
chapter verbatim (295 lines, extracted with `git show 355ca1ab:… | sed -n '1123,1417p'`), the
three open phase-checklist items, and — the part worth checking — a **reconciliation table**
marking each of the seven proposals shipped / partly / not shipped, read against
`packages/quereus-isolation/src` at `355ca1ab`:

| # | Verdict | Evidence to re-check |
| --- | --- | --- |
| 1 Direct passthrough | not shipped | no passthrough mode; `IsolatedTable.update` always calls `ensureOverlay()` (`isolated-table.ts:1160`) |
| 2 Deferred overlay | **partly** | lazy-on-first-write is shipped (the Phase 4 item); the proposed *buffer-until-read* deferral is not — no pending-write buffer exists |
| 3 PK point lookup | **shipped** | `rowExistsInUnderlying` (`flush.ts:111`) → `makePkPointLookupFilter` (`filter-info.ts:21`); probes also hoisted ahead of the first write (`flush.ts:69-73`) |
| 4 Batch commit | not shipped | flush issues one `update()` per entry (`flush.ts:75-104`). The store's atomic-batch commit (`isolation-module.ts:445-455`) is a *different* mechanism — atomicity, not fewer calls. Worth a second opinion on whether that distinction is drawn fairly. |
| 5 Read-only fast path | **shipped** | `isolated-table.ts:417-422`, since extended to `readCommitted`; the proposed "skip connection registration" enhancement is not shipped |
| 6 Upsert semantics | not shipped | flush still probes then picks insert vs update (`flush.ts:84-102`) |
| 7 Planner hints | not shipped | no `IsolationHints` or equivalent |

Plus `O(1) clearOverlay()`, shipped: `isolated-table.ts:1939-1942` releases the whole staging
table rather than deleting rows.

Site-claim grep run before filing. Six open tickets touch `isolated-table.ts` /
`isolation-module.ts`; none is an overlay-fast-path theme ticket (the closest,
`debt-iso-store-unique-seek-rowcount`, is about *test coverage* for an already-shipped seek), so
this was filed fresh rather than appended.

## Judgement calls a reviewer should second-guess

- **§ 4 (Performance Overhead) was left alone.** The ticket allowed folding a shipped mechanism
  into it as present-tense prose. Optimization 3's mechanism is already documented at length in
  the hub's `### Commit` ("Phase-1 invariant — the flush must not read an underlying table once
  it has begun writing that table"), and § 4's existing bullets already describe the shipped
  read fast paths accurately. Adding it again would duplicate. If the reviewer disagrees, § 4 is
  where it goes.
- **`packages/quereus-isolation/README.md:207` was not touched.** It links the hub by absolute
  GitHub URL; the hub now points at the satellite. Naming the satellite there too was flagged
  optional in the ticket and skipped.
- **The four link conversions.** They are the one place this deviates from "verbatim". A reviewer
  who reads the ticket's verify step literally ("only heading `#` counts may differ") will see
  four extra hunks — the reasoning is above, and `docs/doc-conventions.md` is the authority.
- **The pointer paragraph is a bare paragraph between two horizontal rules.** That preserves the
  document's rule-per-H2 cadence without minting a stub heading, per the ticket. It does read as
  a one-line section with no heading; an alternative is attaching it to the end of `### Trade-offs`
  above, which puts navigation under a heading about something else. Either is defensible.

## What was NOT run, and why

- **`yarn test` was not run.** The diff is documentation plus one comment line in
  `isolation-module.ts` (`docs/design-isolation-layer.md` → `docs/design-isolation-challenges.md`
  inside a JSDoc block). No runtime behaviour is touched.
- **`yarn build` was not run** for the same reason.

## What was run

```
node scripts/check-docs.mjs                   → "Docs OK"; only docs/lens.md's pre-existing notice
git diff --stat docs/.doc-budget.json         → empty
yarn lint                                     → clean, 38s
yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts
                                              → 10 passing (includes "all relative doc links resolve")
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
