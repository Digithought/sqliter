----
description: Storage backends can now be asked at planning time "could you seek this column if I hand you a short list of values once the query is running?", so a later change can feed them a list built by a subquery instead of one typed into the SQL.
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/index.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts (new), packages/quereus-store/test/runtime-key-set-plan.spec.ts (new), docs/module-authoring.md
difficulty: medium
----

Implemented as specified. `yarn lint`, `yarn typecheck`, `yarn build` green;
`yarn docs:check` green for the doc this ticket touched. Test results and the two
pre-existing failures are under **Test status** below.

This is the protocol half only — **no runtime code and no `FilterInfo` changed**, and
nothing in the planner emits a `runtimeSet` yet. Every line added here is dead until
`feat-key-set-semi-join` lands the engine side. That shapes what can and cannot be
tested; see **Known gaps**.

## What changed

### `packages/quereus/src/vtab/best-access-plan.ts`

- **`RuntimeSetSpec`** — `{ maxCount, estimatedCount? }`, plus
  `PredicateConstraint.runtimeSet`. Set only on `op: 'IN'`; mutually exclusive with
  `value`. The interface doc states the whole two-sided contract (what accepting
  promises, what the engine promises back, that declining is always safe).
- **`equalitySeekKeyCount(f): number | null`** — the seek-key count a filter contributes
  when filling an equality role: `1` for `=`, `value.length` for a well-formed literal
  `IN`, `runtimeSet.maxCount` for a runtime set, `null` when it fills no equality role.
- **`isMultiValueEquality(f): boolean`** — whether the filter walks the index out of
  column order.
- **`validateAccessPlanRequest(request)`** — the three request-side checks
  (`runtimeSet` only on `IN`; not alongside `value`; `maxCount` a positive integer).
  Called from the top of `validateAccessPlan`, so every module following the
  validate-your-plan convention gets it with no second call site.
- All four are re-exported from `src/index.ts` (plus the `RuntimeSetSpec` type) so
  `@quereus/store` and third-party modules can import them.

### `packages/quereus/src/vtab/memory/module.ts`

Four `IN` call sites converted to the shared helpers; the module **implements** runtime
sets rather than declining:

- `collectEqualityBoundColumns` — a runtime set is never a scan constant.
- `findEqualityMatches` — one `equalitySeekKeyCount` test now covers all four `IN`
  shapes; `inCardinality` multiplies in `maxCount` for a runtime set.
- `buildMonotonicAdvertisement` — a runtime set suppresses `monotonicOn` /
  `supportsAsofRight`.
- `adjustPlanForOrdering`'s `usesMultiInOnOrderedCol` and
  `evaluateOrderingOnlyPlans`' `breaksOrdering` — both treat a runtime set as
  ordering-breaking.

### `packages/quereus-store/src/common/store-module.ts`

- Private `equalitySeekCardinality` deleted; its three call sites
  (`claimFirstPerRole`, and `tryIndexAccessPlan`'s `eqFilter` lookup + `inCount`
  product) now use the shared `equalitySeekKeyCount`. Its doc comment moved to the
  shared function.
- `tryIndexAccessPlan` gained an `isMultiSeek` flag (see deviation 3 below). The
  existing gates — the 1000-key `MAX_MULTI_SEEK_KEYS` cap, the semantic-ordering
  decline, `eqSafeToHandle`, the partial-index exclusion — are otherwise untouched and
  fire on a runtime set exactly as on a literal list.
- A `NOTE:` tripwire on `getBestAccessPlan` records that this module never validates the
  request (see deviation 2).

### `docs/module-authoring.md`

New **"Runtime-valued `IN` sets"** subsection under § 2, stating the contract: what
`runtimeSet` means, that `value` is absent, what accepting promises, that the delivered
`FilterInfo` is an ordinary `plan=5` multi-seek indistinguishable from a literal list,
that the engine (not the module) enforces `maxCount`, and that declining is always
correct. See deviation 6 — fitting it required trimming the doc.

## Deviations from the ticket — check these first

1. **The memory module does NOT decline a runtime set on a semantic-ordering
   (`TIMESPAN`/`JSON`) column.** The ticket said "decline in both modules". The store
   must decline because its multi-seek windows are byte-equality over encoded keys, which
   under-fetch a type whose equality is semantic. The memory module's index comparators
   are typed (`createTypedComparator(columnSchema.logicalType, …)` in
   `vtab/memory/index.ts`), so its multi-seek compares by elapsed time and is correct —
   it does not decline a literal `IN` on a `TIMESPAN` column today either, and making it
   decline only for runtime sets would be an inconsistency, not a fix. Pinned as a parity
   test instead: a runtime set on a `TIMESPAN` column plans identically to a literal `IN`
   of the same length.

2. **`validateAccessPlanRequest` does not fire for the store module.** It is called from
   `validateAccessPlan`, which the memory module and every test module call but the store
   module does not (it never did). A malformed request therefore reaches the store
   unvalidated. Mitigated rather than left sharp: `equalitySeekKeyCount` returns `null`
   for every malformed shape, so a bad `runtimeSet` is simply never claimed and survives
   as a residual. Recorded as a `NOTE:` at `store-module.ts` `getBestAccessPlan`. The
   alternative — validating at all four engine-side `getBestAccessPlan` call sites in
   `planner/rules/` — is a wider change than this ticket scoped.

3. **`equalitySeekKeyCount` rejects a malformed `runtimeSet` (returns `null`), and
   `isMultiValueEquality` treats a well-formed one as multi-valued even at
   `maxCount === 1`.** Neither was in the ticket text.
   - The first exists because of deviation 2: without it, `maxCount: 0` produced
     `inCount = 0` in the store and a *claimed* zero-key multi-seek.
   - The second is the conservative answer: the delivered count is unknowable at plan
     time, and folding a multi-seek into the scan-constant set would elide a `Sort`.
     It is the one place the two helpers deliberately disagree with each other, and it
     is documented on both.
   - Consequence in the store: `tryIndexAccessPlan` now tracks `isMultiSeek` separately
     from `inCount > 1`, so a `maxCount: 1` runtime set still takes the `plan=5` arm and
     still trips the semantic-ordering gate. That is the honest shape — the engine
     delivers `plan=5` whatever the ceiling.

4. **The memory module does not seek a composite index from a leading-column-only
   prefix.** Pre-existing behaviour: `findEqualityMatches` demands equality on *every*
   index column before taking the seek arm. The ticket's "composite index, runtime set on
   the leading column only" case is therefore covered on the **store** side (where
   `tryIndexAccessPlan`'s prefix loop does claim a length-1 prefix of a 2-column index);
   the memory side is pinned as parity-with-literal-`IN` instead.

5. **No test was added to `packages/quereus/test/vtab/best-access-plan.spec.ts`.** The
   `validateAccessPlan` runtime-set cases live in the new
   `test/vtab/runtime-key-set-protocol.spec.ts` alongside the rest of the protocol's
   coverage, rather than being split across two files.

6. **`docs/module-authoring.md` had to shrink to make room.** At `HEAD` it was 11,925
   words against an unratcheted 12,000-word cap (`docs/.doc-budget.json`), i.e. 75 words
   of headroom — any real subsection breaks `yarn docs:check`. Rather than grandfather
   the doc past the cap with `--update-ratchet --force`, ~590 words of duplication were
   cut:
   - § 2's inline `getBestAccessPlan` example was a near-duplicate of Common Patterns →
     *Indexed Table*; replaced with a link.
   - That *Indexed Table* example **claimed every `=` on column 0**
     (`filters.filter(...)` → `handledFilters: req.filters.map(f => eqFilters.includes(f))`),
     contradicting the same document's positional-claim rule two sections earlier. Fixed
     to claim the first only. **This is a real doc bug fixed in passing — worth a look.**
   - *Simple In-Memory Table* was a strict subset of *Indexed Table*; folded into a
     one-line note.
   - Best Practices §§ 1–4 were four generic bullet lists restating § 2; condensed to
     two paragraphs. § 5 (Preserve Attribute IDs) survives as § 3.

   Final: 11,992 words. **Whether these cuts are the right ones is a judgement call the
   reviewer should second-guess** — the alternative was `--update-ratchet --force` plus a
   commit-message justification.

## Test status

Two new spec files, **43 tests, all passing**:

- `packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts` (25) — the two helpers
  across all four `IN` shapes and every malformed one; `validateAccessPlan`'s three
  request-side rejections plus both accept cases; an inline stub module that predates
  `runtimeSet` declining without throwing; and the memory module's plan for a runtime set
  on an indexed column / an unindexed column / a `maxCount` of 1000 and 1001 / with and
  without `estimatedCount` / under `requiredOrdering` / on a `TIMESPAN` column / on a
  composite index / marked unusable / with a literal `IN` competing for the same column.
- `packages/quereus-store/test/runtime-key-set-plan.spec.ts` (17) — the same shape for
  the store, plus the cap boundary in both directions (1000 accepts, 1001 declines
  cost-only with the filter unhandled), the composite-index leading-prefix claim, a
  runtime × literal cross-product both under and over the cap, the semantic-ordering
  decline at `maxCount` 4 and 1, the `K = BINARY` over a `NOCASE` column collation
  decline, the partial-index exclusion, and the primary-key arm's refusal.

Both drive `getBestAccessPlan` directly (no SQL) — see **Known gaps**.

Suite runs:

| Run | Result |
| --- | --- |
| `packages/quereus` full (no `--bail`) | 7575 passing, 13 pending, **2 failing** (pre-existing) |
| same with `QUEREUS_TEST_STORE=true` | 7568 passing, 20 pending, **2 failing** (same two) |
| every other workspace | all green (store 1128, sync 594, isolation 330, …) |

**The 2 failures are pre-existing and unrelated**, recorded in
`tickets/.pre-existing-error.md`: `coarsened-backing-key.spec.ts:196` and
`mv-coarsening-collision-telemetry.spec.ts:91`, both *"materialized view 'm' cannot be
materialized: its body has no provable unique key"* from
`database-materialized-views-analysis.ts:413`. Verified empirically, not assumed: with
`vtab/memory/module.ts` temporarily swapped for its `HEAD` contents (and restored
immediately), both still fail identically. Note the runner's default `--bail` hides the
second one.

That file also records a third pre-existing failure: **`yarn docs:check` fails on
`docs/runtime.md`** (13,248 words vs. its 13,096 ratchet, +152). `docs/runtime.md` is
byte-identical to `HEAD`; this ticket never touched it.

## Known gaps — the reviewer should treat these as open

- **There is no end-to-end coverage and there cannot be.** Nothing in the planner emits a
  `runtimeSet`, so no SQL query produces one. Every test constructs the request by hand.
  The first real integration test arrives with `feat-key-set-semi-join`.
- **The central promise is untested by construction.** "At `query()` time the module
  receives a `plan=5` multi-seek `FilterInfo` byte-for-byte identical to a literal `IN`
  list's" is an obligation on the *engine* side, not on anything in this diff. Nothing
  here can verify it. If `feat-key-set-semi-join` breaks that promise, these tests stay
  green and the modules silently seek wrong. It is worth deciding now whether that
  deserves an assertion in the engine-side ticket.
- **The "un-updated third-party module" case uses an inline stub function**, not a
  registered `VirtualTableModule` driven through a real query. It proves the
  well-formedness predicate declines and that the request does not throw; it does not
  prove an unmodified real module survives the full planner path.
- **`estimatedCount` is validated for nothing.** No check that it is a non-negative
  integer, nor that it is `≤ maxCount`. It is advisory and neither module reads it, so
  garbage is currently harmless — but the field is unguarded.
- **Cost modelling for runtime sets is `maxCount`-driven, i.e. worst-case.** Both modules
  price a runtime set as if it always delivers `maxCount` keys, ignoring `estimatedCount`
  entirely. A plan probed with a large ceiling but a tiny actual set will look more
  expensive than it is, and may lose to a scan it should beat. Whether that matters
  depends on what ceilings `feat-key-set-semi-join` chooses.
- **The memory module has no seek-key cap of its own.** It relies entirely on the
  engine's `maxCount` promise. Its cost model prices `inCardinality * 0.3` with no
  per-seek positioning term (unlike the store's `inCount * INDEX_SEEK_COST`), so a large
  runtime set over a small memory table is priced optimistically compared to the store.
- **Isolation-layer interaction is untouched and unexamined.** A runtime-set multi-seek
  on a secondary index reaches the same runtime path as a literal `IN` multi-seek, so
  `backlog/bug-isolation-multiseek-merge-order` applies to it identically. Nothing here
  makes that better or worse; it is simply inherited.
- The primary-key arm still declines every `IN`, runtime or literal
  (`backlog/feat-store-pk-in-list-multiseek`). No change to this protocol is needed when
  that lands.

## Tripwires parked

- `packages/quereus-store/src/common/store-module.ts`, `getBestAccessPlan` — `NOTE:` that
  this module never validates the request, why that is currently safe
  (`equalitySeekKeyCount` returns `null` for malformed shapes), and what to do if it ever
  needs to catch rather than absorb.
- `packages/quereus/src/vtab/best-access-plan.ts`, `equalitySeekKeyCount` doc — the
  runtime-set arm has **no counterpart** in `rule-select-access-path`'s `eqBySeekCol`,
  which still tests `Array.isArray(c.value)`. That is correct today (nothing emits a
  runtime set) and is precisely what `feat-key-set-semi-join` must reconcile: it has to
  lower a runtime set to a literal seek-key list before that rule runs, or teach the rule
  the new arm.
