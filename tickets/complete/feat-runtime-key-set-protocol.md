---
description: Storage backends can now be asked at planning time "could you seek this column if I hand you a short list of values once the query is running?", so a later change can feed them a list built by a subquery instead of one typed into the SQL.
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/index.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts, packages/quereus-store/test/runtime-key-set-plan.spec.ts, docs/module-authoring.md
difficulty: medium
---

# Runtime-valued `IN` sets: the plan-time protocol

Shipped. `yarn lint`, `yarn typecheck`, `yarn build`, `yarn docs:check` and the full
`yarn test` suite are green (see **Test status**).

This is the protocol half only. Nothing in the planner emits a `runtimeSet` yet, so every
line of it is dead until `implement/feat-key-set-semi-join` lands the engine side. That
ticket already carries the obligations this one cannot verify (see **Review findings**).

## What shipped

**`packages/quereus/src/vtab/best-access-plan.ts`** — the protocol.

- `RuntimeSetSpec` = `{ maxCount, estimatedCount? }`, reachable as
  `PredicateConstraint.runtimeSet`. Legal only on `op: 'IN'`, mutually exclusive with
  `value`. Its doc states the two-sided contract: a module that accepts one promises only
  that it can multi-seek that column on the named index; in exchange the engine promises
  the module receives, at `query()` time, an ordinary `plan=5` multi-seek `FilterInfo`
  with `1 ≤ K ≤ maxCount` seek keys — the same shape a literal `IN (…)` produces.
  Declining is always safe.
- `equalitySeekKeyCount(f): number | null` — seek keys a filter contributes when filling
  an equality role. `1` for `=`, `value.length` for a well-formed literal `IN`,
  `runtimeSet.maxCount` for a runtime set, `null` for every malformed or non-equality
  shape.
- `isMultiValueEquality(f): boolean` — whether the filter walks the index in seek-key
  order rather than column order. A well-formed runtime set is always multi-valued, even
  at `maxCount === 1`, because the delivered count is unknowable at plan time. This is the
  one place the two helpers deliberately disagree; both docs say so.
- `validateAccessPlanRequest(request)` — request-side checks, called from the top of
  `validateAccessPlan` so every module following the validate-your-plan convention gets
  them for free.
- All four plus the `RuntimeSetSpec` type re-exported from `src/index.ts`.

**`packages/quereus/src/vtab/memory/module.ts`** — implements runtime sets rather than
declining them. Four `IN` shape tests replaced by the shared helpers
(`collectEqualityBoundColumns`, `findEqualityMatches`, `buildMonotonicAdvertisement`, and
the two ordering-break checks). `findEqualityMatches` now also returns `isMultiSeek`,
derived from `isMultiValueEquality`, so `isSet` and the explanation agree with the rest of
the module.

**`packages/quereus-store/src/common/store-module.ts`** — the private
`equalitySeekCardinality` deleted in favour of the shared helper.
`tryIndexAccessPlan` tracks `isMultiSeek` separately from `inCount > 1`, so a
`maxCount: 1` runtime set still takes the `plan=5` arm and still trips the
semantic-ordering gate. The existing gates (1000-key cap, semantic-ordering decline,
`eqSafeToHandle`, partial-index exclusion) fire on a runtime set exactly as on a literal
list.

**`docs/module-authoring.md`** — new "Runtime-valued `IN` sets" subsection under § 2.

## Deliberate divergences between the two modules

- The **memory module does not decline** a runtime set on a semantic-ordering
  (`TIMESPAN`/`JSON`) column; the **store does**. The store's multi-seek windows are byte
  equality over encoded keys, which under-fetch a type whose equality is semantic; the
  memory module's index comparators are typed, so its multi-seek is correct. Pinned as a
  parity test on the memory side.
- The **memory module does not seek a composite index from a leading-column-only
  prefix** — pre-existing behaviour of `findEqualityMatches`, which demands equality on
  every index column. The store's prefix loop does claim a length-1 prefix, and that is
  where the composite case is covered.
- The **memory module has no seek-key cap** and no per-seek positioning cost term; it
  relies entirely on the engine's `maxCount` promise. Parked as a tripwire.

## Review findings

### What was checked

The implement diff (`8a3969a8`) was read in full before the handoff summary: both engine
source files, both module files, both new spec files, and the `docs/module-authoring.md`
rewrite. Beyond that: an equivalence audit of every converted call site against its
pre-change predicate; a sweep for other `op === 'IN'` shape tests across the engine,
plugins and sample modules; the isolation module's `getBestAccessPlan` (it delegates
verbatim, so it inherits the protocol with no change); every `docs/` file that mentions
`PredicateConstraint`, `handledFilters` or multi-seek; and `yarn lint`, `yarn typecheck`,
`yarn build`, `yarn docs:check`, `yarn test`.

### Fixed in this pass (minor)

- **The memory module contradicted itself at `maxCount === 1`.**
  `evaluateIndexAccess` derived `isMultiSeek` from `inCardinality > 1`, so a
  `maxCount: 1` runtime set was reported as a unique-row `seek` with `isSet: true` — while
  the same module's ordering and scan-constant checks (correctly) treated it as
  multi-valued, and the store module had just grown an explicit `isMultiSeek` flag for
  exactly this case. `findEqualityMatches` now returns `isMultiSeek` from
  `isMultiValueEquality`, mirroring the store. Literal `IN` and `=` behaviour is
  bit-identical; only runtime sets change. New test in each module's spec.
- **`estimatedCount` was validated for nothing.** `validateAccessPlanRequest` now requires
  it to be an integer in `0..maxCount` when present — an estimate above the ceiling
  describes a set the engine promised never to deliver, i.e. an engine bug rather than a
  pessimistic guess. Field doc and `docs/module-authoring.md` state the range. Two new
  tests.
- **Dead line in the store.** `if (inCount > 1) isMultiSeek = true;` could never change the
  flag — any factor above 1 is itself a multi-value equality, so the loop had already set
  it. Removed; the comment now says what the flag actually adds over the arithmetic.
- **A downstream ticket was left stating something this diff made false.**
  `implement/feat-key-set-semi-join` justified probing at `maxCount: 2` on the grounds that
  "at 1 the store returns a plain `eqSeek` plan on a different cost basis". After this
  ticket, both modules take the multi-seek arm at 1. Rationale corrected in place (the
  choice of 2 still stands, for a distinct second probe point).

### Major findings — none, deliberately

No new `fix/`, `plan/` or `backlog/` ticket was filed. The handoff's own "Known gaps" list
was worked through item by item and each resolves without one:

- *"The central promise — that `query()` receives a `FilterInfo` identical to a literal
  `IN`'s — is untested by construction."* True, and it is not testable from this diff: the
  promise is an obligation on the engine. It is already written into
  `implement/feat-key-set-semi-join`, which requires the emitted `FilterInfo` to be
  asserted field-for-field equivalent to the plan-time multi-seek form. Nothing to file.
- *"No end-to-end coverage; the un-updated-third-party-module case is an inline stub."*
  Same cause — no SQL can produce a `runtimeSet` yet. The first integration test arrives
  with the engine half.
- *"`estimatedCount` is unguarded"* — fixed above.
- *"Cost modelling is `maxCount`-driven"* and *"the memory module has no cap of its own"* —
  genuinely conditional, so tripwires rather than tickets (below).
- *"Isolation-layer interaction is inherited"* — a runtime-set multi-seek reaches the same
  runtime path as a literal one, so `backlog/bug-isolation-multiseek-merge-order` covers it
  unchanged. Nothing new to file.
- *"The primary-key arm still declines every `IN`"* — already
  `backlog/feat-store-pk-in-list-multiseek`; this protocol needs no change when it lands.

### Tripwires parked

- `packages/quereus/src/vtab/best-access-plan.ts`, `RuntimeSetSpec.estimatedCount` —
  neither module reads it; both price against `maxCount`, i.e. worst case. `NOTE:` says to
  blend it into the cost (never into the safety gates) if the engine starts probing with
  large ceilings for typically tiny sets.
- `packages/quereus/src/vtab/memory/module.ts`, `evaluateIndexAccess` — `NOTE:` that this
  module has neither the store's seek-key cap nor its per-seek positioning term, so a large
  multi-seek over a small memory table prices optimistically.
- Two more were parked by the implement stage and were reviewed and left as they are: the
  store module never validating its request (`store-module.ts`, `getBestAccessPlan`), and
  `rule-select-access-path`'s `eqBySeekCol` having no runtime-set arm
  (`best-access-plan.ts`, `equalitySeekKeyCount` doc).

### Checked and deliberately left alone

- **The store module still does not validate its request.** Called out as deviation 2 by
  the implementer. Validating would mean touching all four engine-side
  `getBestAccessPlan` call sites in `planner/rules/`, which is wider than this ticket. The
  degradation is safe — `equalitySeekKeyCount` returns `null` for every malformed shape, so
  a bad request is never claimed and survives as a residual — and both the code `NOTE:` and
  a store test pin that behaviour.
- **`docs/optimizer.md` was not updated and is not stale.** Its `handledFilters` and
  seek-encoding sections describe what the *planner* extracts and consumes. The planner
  emits no `runtimeSet`, so nothing there is yet untrue; the module-facing contract is the
  one that changed, and that lives in `docs/module-authoring.md`.
- **The doc cuts (deviation 6) were re-read and stand.** `docs/module-authoring.md` had 75
  words of headroom under the 12,000-word cap, and the ~590 words removed were duplication:
  a § 2 example that restated Common Patterns → *Indexed Table*, a *Simple In-Memory Table*
  example that was a strict subset of *Indexed Table*, and four Best Practices bullet lists
  restating § 2. The *Indexed Table* example also had a real bug — it claimed **every** `=`
  on column 0, contradicting the positional-claim rule stated two sections earlier — and
  the fix to claim only the first is correct. Grandfathering the doc past the cap with
  `--update-ratchet --force` would have been the worse trade.
- **The four remaining deviations** (memory module not declining on semantic-ordering
  columns; `equalitySeekKeyCount` rejecting a malformed `runtimeSet` while
  `isMultiValueEquality` accepts a `maxCount: 1` one; no composite-prefix seek in the
  memory module; the `validateAccessPlan` tests living in the new spec file rather than
  `best-access-plan.spec.ts`) were each verified against the code and are right as
  implemented. They are recorded under **Deliberate divergences** above.
- **The pre-existing failures the handoff recorded are gone.** Commit `9a1f879b`
  ("tess: triage pre-existing test failure") resolved both materialized-view specs and the
  `docs/runtime.md` budget overage before this review ran; `tickets/.pre-existing-error.md`
  is correctly absent. No failure in this review's runs is unaccounted for.

## Test status

| Run | Result |
| --- | --- |
| `yarn lint` | green (all workspaces) |
| `yarn typecheck` | green |
| `yarn build` | green |
| `yarn docs:check` | green |
| `yarn test` (all workspaces) | green — `packages/quereus` 7580 passing / 13 pending / **0 failing**; `quereus-store` 1129; every other package green |

Coverage of the protocol itself: `packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts`
(the two helpers across all four `IN` shapes and every malformed one; `validateAccessPlan`'s
request-side rejections and accepts, including the `estimatedCount` range; a stub module
predating `runtimeSet` declining without throwing; and the memory module's plan for a
runtime set on an indexed column, an unindexed column, at `maxCount` 1 / 1000 / 1001, with
and without `estimatedCount`, under `requiredOrdering`, on a `TIMESPAN` column, on a
composite index, marked unusable, and competing with a literal `IN` on the same column) and
`packages/quereus-store/test/runtime-key-set-plan.spec.ts` (the same shape for the store,
plus the cap boundary in both directions, the composite leading-prefix claim, the
runtime × literal cross-product under and over the cap, the semantic-ordering decline at
`maxCount` 4 and 1, the `K = BINARY` over `NOCASE` collation decline, the partial-index
exclusion, the multi-seek arm at `maxCount: 1`, and the primary-key arm's refusal).
