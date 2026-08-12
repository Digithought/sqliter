---
description: The transaction-isolation design note was 127 words from the size limit the documentation checker enforces; its longest chapter now lives in its own note and its list of unbuilt optimizations moved out of the docs folder into a backlog ticket.
files:
  - docs/design-isolation-layer.md                        # 11,873 → 7,040 words; gained a `## Topic documents` table in review
  - docs/design-isolation-challenges.md                   # NEW satellite, 3,503 words, no stability banner (both docs untiered)
  - docs/.stability.json                                  # new doc added to `untiered`
  - docs/todo.md                                          # line 21 repointed at the backlog ticket
  - packages/quereus-isolation/src/isolation-module.ts    # line 460 prose marker repointed
  - scripts/check-docs.mjs                                # NOTE added in review — satellite/hub convention is unenforced
  - tickets/backlog/feat-isolation-overlay-fast-paths.md  # NEW, carries the removed optimization chapter verbatim
  - tickets/backlog/debt-isolation-challenges-doc-proposal-voice.md  # NEW, filed by the review
---

# What landed

Baseline `355ca1ab`. `docs/design-isolation-layer.md` went from **11,873 words** — 127 short of
the hard 12,000-word cap, which has no grace band — to **7,040**. Three chapters came out:

| Was | Words | Now |
| --- | --- | --- |
| `## Challenges and Mitigations` (six numbered sub-sections) | 3,430 | `docs/design-isolation-challenges.md` |
| `## Optimization Strategies` (overhead analysis, Optimizations 1–7, summary, order) | 1,140 | `tickets/backlog/feat-isolation-overlay-fast-paths.md`, verbatim |
| `## TODO` (Phase 1–6 checklist, mostly `✅`) | 355 | deleted; its three unchecked items are in that backlog ticket |

The new satellite opens with an H1 and an intro closing
`A satellite of [Isolation Layer Design](design-isolation-layer.md).`, carries the moved block
with every heading promoted one level (heading *text* untouched, so all thirteen anchors survive),
and is classified `untiered` in `docs/.stability.json` alongside its hub. Neither doc has a
stability banner, because the checker fails an untiered doc that carries one.

The backlog ticket that received the optimization chapter also carries a reconciliation table
marking each of the seven proposals shipped / partly / not shipped, read against
`packages/quereus-isolation/src`.

# Review findings

## Verified — no finding

- **The chapter move is byte-exact.** Reproduced the implementer's diff recipe against `355ca1ab`:
  exactly four hunks, all of them relative cross-references (`see § Commit`, `documented above`,
  two `Invariant: every staged overlay …`) converted to real links because they stopped resolving
  once the block left the file. `docs/doc-conventions.md` § The size ratchet mandates that sweep,
  so the deviation from "verbatim" is correct.
- **Nothing else was silently dropped from the hub.** Reconstructed the expected survivor text
  (`sed -n '1,822p;967,1070p;1418,$p'` over the baseline) and diffed it against the committed hub:
  three hunks, all intended — the `ALTER / DROP overlay poison` link, the new pointer paragraph,
  and the collapse of two adjacent `---` rules left by the TODO/Optimization removal into one.
  The rule-per-H2 cadence holds and `## References` still closes the document.
- **The optimization chapter in the backlog ticket is byte-identical** to baseline lines
  1123–1417 (`diff` clean, 295 lines each). Its three carried-over checklist items match the
  three unchecked boxes in the removed `## TODO`.
- **The reconciliation table's code claims hold.** Spot-checked every cite rather than trusting
  them: `ensureOverlay()` on the write path (`isolated-table.ts:1159`), the read fast path
  (`isolated-table.ts:417-422`), `clearOverlay` releasing the whole staging table
  (`isolated-table.ts:1942`), the hoisted existence probes and per-entry `update()` loop
  (`flush.ts:60-104`), `makePkPointLookupFilter` (`filter-info.ts:21`), no `IsolationHints`
  anywhere. Item 4's distinction — the store's shared coordinator buys atomicity, not fewer write
  calls, so "batch commit" is genuinely not shipped — is drawn fairly; `isolation-module.ts:442-453`
  says exactly that.
- **Inbound references.** All resolve. `node scripts/check-docs.mjs` validates both link targets
  and `#anchor` fragments, so the four new cross-document links and the hub→satellite poison link
  are machine-checked, not asserted.
- **`docs/todo.md` pointing at a ticket path** is an established pattern here, not a new hazard —
  `docs/memory-table.md`, `docs/optimizer.md`, `docs/sync.md`, and `docs/types-ordering.md` all do it.
- **Skipping `yarn test` / `yarn build`** was the right call and is confirmed: the only
  non-documentation change in the diff is one word inside a JSDoc comment.

## Minor — fixed in this pass

- **The hub had no `## Topic documents` table.** `docs/doc-conventions.md:171-175` requires a hub
  with satellites to carry one directly below its intro, and the sibling splits
  (`docs-split-optimizer-costing`, `docs-split-sql-ddl-vtab-constraints`) both did. The implementer
  noticed the table was absent and left it absent, relying on an in-body pointer paragraph instead.
  Added the table; trimmed the pointer paragraph to a one-line link so the six problems are
  enumerated in one place rather than two. Swept the whole `docs/` tree for other satellites
  missing from their hub's table — this was the only one.

## Major — filed

- **`docs/design-isolation-challenges.md` § 1, 2, 4, 5 are written as intentions, not as shipped
  behaviour.** Two of the doc's six sections (§ 3 Commit Failure Recovery, § 6 Schema Operations)
  have been rewritten over time into present-tense descriptions naming real functions; the other
  four are still the original `**Challenge:** / **Mitigation:**` sketch, and a reader cannot tell
  which bullets happened. Concretely: § 1 proposes property-based testing with `fast-check`, which
  is not a dependency; § 2 contains an instruction to a future author ("Document behavior based on
  overlay module's capabilities"); § 4 mixes two shipped fast paths with one unverified read-path
  claim. This is the exact failure `docs/doc-conventions.md` warns about, and it is the same rule
  the split invoked when it moved `## Optimization Strategies` out of `docs/` — applied to one
  chapter and not its neighbour. Nothing was made worse by the move; the prose is as old as it was
  before, which is why this is a ticket rather than an inline fix: rewriting four sections means
  re-deriving four behaviours from source. Filed as
  `tickets/backlog/debt-isolation-challenges-doc-proposal-voice.md`. Confined to this one file —
  no other doc in the tree uses that framing — so it is a point ticket, not a class.

## Tripwire — parked, not filed

- **Nothing enforces the satellite / `## Topic documents` convention.** `node scripts/check-docs.mjs`
  stayed green through a split that shipped an unlisted satellite. Every other satellite in the
  tree complies today, so one miss did not justify a check. Parked as a `NOTE:` at the top of
  `scripts/check-docs.mjs`, next to the list of checks, with the rule to add if a second split
  misses it.

## Considered and declined

- **`packages/quereus-isolation/README.md:207`** links the hub by absolute GitHub URL and was not
  updated to name the satellite. Correct: the hub's new `## Topic documents` table is the first
  thing a reader arriving from that link now sees.
- **Hub § 4 Performance Overhead was not expanded** with the shipped point-lookup mechanism. The
  implementer's reasoning holds — the hub's `### Commit` already documents the Phase-1 probe
  invariant at length, and duplicating it would create two places to drift. (The § 4 that needs
  work is the *satellite's*, covered by the ticket above.)
- **The header-fence style of the new backlog ticket** (leading `---`) differs from some siblings.
  Surveyed `tickets/backlog` and `tickets/plan`: 50 files use it, 53 do not. Not a convention.

# Validation

```
node scripts/check-docs.mjs   → "Docs OK"; only docs/lens.md's pre-existing grace-band notice
yarn lint                     → clean, 46s
yarn workspace @quereus/quereus run test:single packages/quereus/test/documentation.spec.ts
                              → 10 passing (includes "all relative doc links resolve")
```

`git diff --stat docs/.doc-budget.json` empty — neither doc has a ratchet entry, and neither needs
one. `yarn test` / `yarn build` deliberately not run; no runtime code changed. No pre-existing
failures surfaced.
