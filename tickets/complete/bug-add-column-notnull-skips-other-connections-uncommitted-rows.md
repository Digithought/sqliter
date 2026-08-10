---
description: When several connections shared a table, adding a column that forbids blanks only checked the rows the connection running the change could see, so another connection's in-progress rows could end up blank in that column and be saved that way; now that other connection fails instead of silently saving a blank.
files:
  - packages/quereus-isolation/src/alter-migration.ts                 # computeAddColumnValue — the fix
  - packages/quereus-isolation/test/isolation-layer.spec.ts           # white-box poison + no-false-poison tests
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # SQL-driven cross-connection tests
  - docs/design-isolation-layer.md                                    # "ALTER: migrate, or poison" wording
---

# Outcome

Shipped. `computeAddColumnValue` in `packages/quereus-isolation/src/alter-migration.ts` now
rejects on its folded-literal-default branch when the newly added column is mandatory and there
is no usable DEFAULT, not only on the per-row-evaluator branch. That one function backs both the
pre-mutation dry run (`validateOverlayMigration`) and the real forward migration
(`migrateOverlayForward` → `buildOverlayAddColumnChange`'s evaluator wrapper), so the existing
routing picks the rejection up unchanged:

- **Issuing connection** — rejection fires before `underlying.alterTable`, so the ALTER aborts
  with nothing mutated. Belt-and-braces: the engine's own pre-mutation probe already covered this.
- **Foreign connection** — rejection fires in the per-foreign-overlay validate pass
  (`isolation-module.ts` ~line 1466) and is converted to **poison**, so that connection's next
  read, write, or commit throws `CONSTRAINT` instead of persisting a NULL in a mandatory column.

Only reachable while the committed table is empty; any committed row makes the underlying module
refuse the ALTER before the isolation layer is reached.

# Review findings

## Verified correct (nothing to change)

- **The reject condition matches the engine's own gate exactly.** The engine
  (`packages/quereus/src/runtime/emit/alter-table.ts` ~line 489) skips its `validateNotNullBackfill`
  probe precisely when a per-row backfill exists, and it sets `SchemaChangeInfo.backfillEvaluator`
  precisely when that same backfill exists (line 527/573). So the isolation layer's
  no-evaluator/folded-default branch is exactly the set the engine never guards for a foreign
  connection — no gap below it, no double-rejection above it.
- **`foldedDefault === null` covering both "no DEFAULT" and "DEFAULT folds to NULL" is right**, and
  matches the engine's own `defaultIsNullish` test. The implement handoff flagged this for a second
  look; confirmed correct.
- **A non-null literal DEFAULT still migrates a foreign overlay forward, unpoisoned.** Re-read the
  pre-existing `ADD COLUMN forwards a foreign overlay IN PLACE` test: its column really is
  `NOT NULL DEFAULT 0`, so it is a genuine negative case for the new branch, and it still passes
  untouched. The handoff's decision not to duplicate it was correct.
- **No symmetric hole in the neighbouring ALTER paths.** The handoff deferred this; re-derived it
  here rather than leaving it open. `alter column … set not null` and `alter column … set data type`
  each iterate `stagedLiveRows` unconditionally inside `validateOverlayMigration`, and tier 3 runs
  that function once per foreign overlay — so neither path has an equivalent branch that skips
  foreign rows. Nothing to file.
- **Docs.** `docs/design-isolation-layer.md` tiers 2 and 3 were updated correctly.
  `packages/quereus-isolation/README.md:144` already describes the poison rule broadly enough
  ("its staged row can't satisfy the new … column") to remain accurate — checked, no edit needed.
  No other doc under `docs/` describes this path.

## Fixed in this pass (minor)

- **Missing regression guard: the new rejection had no test proving it stays *below* the deletion-marker
  short-circuit.** Its condition is row-independent, so hoisting it to the top of
  `computeAddColumnValue` reads as a harmless simplification — and would poison every connection
  holding nothing but staged DELETEs. That is a reachable shape (connection B stages a delete of a
  committed row; connection A commits a delete of the same row, emptying the committed table; A's
  mandatory ADD COLUMN then gets past the underlying's non-empty-table refusal). Added
  `does NOT poison a foreign overlay holding only a deletion marker …` to
  `isolation-layer.spec.ts`. Verified it has teeth by temporarily hoisting the check — the test
  fails — then reverting.
- **Duplicated prose.** The "the engine's probe only sees the issuing connection" explanation was
  restated in three places (`computeAddColumnValue`'s docblock, `validateOverlayMigration`'s
  docblock, and the design doc). Trimmed the `validateOverlayMigration` copy to point at
  `computeAddColumnValue`, which owns the rule.

## Tripwires (recorded, not ticketed)

- The addColumn arm of `validateOverlayMigration` full-scans every staged row even when nothing can
  fail and even when the rejection would fire on the first live row. Harmless at current overlay
  sizes. Parked as a `NOTE:` comment at that loop in `alter-migration.ts`.

## Filed as a new ticket

- `backlog/debt-gitignore-tmp-scratch-dir` — the implement commit swept in
  `.tmp/quereus-4.5-vs-4.4-perf.md`, an unrelated hand-written performance note. All three files
  under `.tmp/` are tracked and `.tmp/` is absent from `.gitignore`, so scratch material keeps
  landing in unrelated commits. Not fixed inline: untracking those files removes human-authored
  notes from the repository, which is the owner's call, so the ticket asks for that decision.

## Checked, nothing found

- **Resource cleanup / error handling** — the change adds one throw on a path already wrapped by
  the tier-2 atomic-abort and tier-3 poison routing; it opens nothing that needs closing.
- **Type safety** — no `any`, no new types, no signature change.
- **Source hygiene** — no function grew; the diff is one four-line guard.
- **Handoff accuracy** — one small prose slip: the handoff says the foreign-connection throw fires
  in `applyInPlaceOverlayChange`. It actually fires in the tier-3 `validateOverlayMigration` call
  that precedes it (`isolation-module.ts:1466`), which sets the poison at line 1469. Behaviour is
  identical; noted so a future reader tracing the path looks in the right place.

# Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` (full workspace) — green.
- `@quereus/isolation` package suite — 348 passing, 0 failing.
- No pre-existing failures encountered; `tickets/.pre-existing-known.md` is empty and nothing was
  written to `tickets/.pre-existing-error.md`.
