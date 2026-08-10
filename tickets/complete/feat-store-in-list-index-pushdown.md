---
description: When a query matches an indexed column against a list of values, the persistent storage backend now uses the index — one lookup per distinct list value — instead of reading the whole table. Built, reviewed, and validated.
files:
  - packages/quereus-store/src/common/store-module.ts    # plan side — tryIndexAccessPlan, IN as an equality role
  - packages/quereus-store/src/common/store-table.ts     # runtime side — scanMultiSeek and the query() dispatch
  - packages/quereus-store/src/common/key-builder.ts     # buildIndexPrefixBounds — safety note updated in review
  - packages/quereus-store/test/pushdown.spec.ts         # plan-shape, result, and narrowing coverage
  - packages/quereus-store/test/isolated-store.spec.ts   # isolation-over-store merge coverage (added in review)
  - packages/quereus-store/README.md                     # user-facing description of the behavior
  - packages/quereus-store/package.json                  # typecheck now covers test files (review)
difficulty: hard
---

# `IN`-list index seeks for the store backend

## What it does

`where v in (1, 2, 3)` against a store-backed table with a secondary index on `v` now
plans an index seek — the engine's multi-value seek, `plan=5` — instead of a full table
scan with a leftover filter. Parameter-bound lists (`v in (?, ?, ?)`) work the same way.

- `NULL` list values match nothing and are skipped.
- Duplicate list values yield each row once.
- A composite index serves the cross-product of per-column lists: `a in (1,2) and b in
  (10,20)` is four seeks.
- Lists over 1000 seek keys, and lists on a column whose declared type defines its own
  notion of equality (`TIMESPAN`, `JSON`), fall back to the scan path — still correct,
  just not accelerated.
- `IN` against the primary key still scans; that is deferred to backlog
  `feat-store-pk-in-list-multiseek`, which is itself gated on the pre-existing
  `bug-isolation-multiseek-merge-order`.

## How it works

**Plan side (`store-module.ts`).** `tryIndexAccessPlan` treats a well-formed `IN` (a
non-empty array value) as filling an equality role when it builds the leading-prefix seek
columns; `inCount` is the cross-product of the per-column list sizes. The first
role-filling filter per column decides, matching the engine access-path rule's own pick —
the shared shape gate lives in `equalitySeekCardinality` so the two cannot disagree. The
primary-key arms deliberately keep `=`-only (`EQ_OPS`); only the secondary-index arm uses
`EQ_OR_IN_OPS`. The plan declines to the pre-existing cost-only advertisement (residual
retained, answer right, speed-up lost) above the 1000-key cap or on a semantically-ordered
seek column. Cost for a multi-seek is `inCount * 0.5 + min(estimatedRows, inCount *
perKeyRows) * 0.3`, with `isSet` false and no ordering advertised. The single-key path is
byte-identical to before.

**Runtime side (`store-table.ts`).** `query()` dispatches a decoded `plan=5` idxStr to
`scanMultiSeek` **before** `analyzePKAccess` — see the regression note below.
`scanMultiSeek` decodes N tuples of width W, drops NULL-bearing tuples, builds one byte
window per distinct encoded prefix, sorts the windows ascending by encoded bytes, and
scans them lazily through the existing `scanIndex` path (so read-your-own-writes, the
stale-entry defenses, and `limit` early-exit all hold per seek key). Ascending encoded-byte
order is index-key order, which the isolation layer's overlay merge requires.

Three details worth knowing, all deliberate departures from the original spec:

- **Windows merge rather than dedup.** When the table key collation is coarser than the
  column's comparison collation (`NOCASE` key over a `BINARY` column — the one such
  pairing the plan admits), `v in ('a', 'A')` produces one byte window but two distinct
  residuals. Keeping only one would drop the other value's row, so key-equal tuples share
  a window and a row is yielded when it matches **any** member tuple.
- **The cross-window `seen` set is added to on yield, not on visit.** Adding at visit time
  would let a stale index entry that fails its residual suppress the row's live entry in a
  later window.
- **A window with no finite upper bound absorbs every later window** rather than letting
  them re-scan an overlapping range out of order. Near-unreachable in practice (NULL
  tuples are dropped before encoding); defensive.

A malformed multi-seek `FilterInfo` throws `StatusCode.INTERNAL` rather than falling
through to the scan arm, which would AND N mutually-exclusive equalities into a silent
zero-row answer.

## Coverage

`pushdown.spec.ts` — plan shape (index seek for single/composite, decline for over-cap and
`TIMESPAN`), exact results for basic / duplicate / NULL / all-NULL-parameter /
single-element / parameter-bound lists, `NOCASE` case variants, the coarser-key merge case,
DESC index, mixed ASC/DESC composite, `IN`×`IN` / `IN`×`EQ` / `EQ`×`IN` cross-products,
memory-module oracle cross-check, read-your-own-writes, `ORDER BY` over an unsorted list,
the cap boundary, an index over the primary-key column, and a counting-data-store proof that
the seek reads only matching rows (0 data-store iterations vs. 100 for a scan).

`isolated-store.spec.ts` — a multi-seek under the isolation layer: raw emission order with
overlay rows interleaved between committed seek windows, plus overlay updates and tombstones
applied per window.

## Validation

`yarn build`, `yarn test` (all workspaces green; store package 1111 passing), `yarn lint`,
`yarn typecheck` — all clean at review time. The implement stage additionally ran
`yarn test:store` (7544 logic tests against the LevelDB backend, which exercises the foreign-key
`RESTRICT` batched-`IN` shape and the isolation layer over live multi-seeks); that sweep was
not re-run in review since the review's code changes were confined to a doc comment, a code
comment, and test files.

## Review findings

Read the implement diff first, then the handoff. Reviewed against: correctness under the
collation/DESC/NULL/duplicate matrix, plan/runtime agreement with the engine's access-path
rule, interaction with the isolation layer, single-purpose functions, DRY, error handling,
type safety, resource cleanup, source hygiene, test breadth, and doc currency.

### Verified correct — no change needed

- **Plan/runtime agreement with the engine rule.** `equalitySeekCardinality` encodes exactly
  the predicate `rule-select-access-path`'s `eqBySeekCol` applies (`=`, or `IN` with a
  non-empty array), and both sides take the *first* matching constraint per column, so the
  module's positional claim and the rule's seek pick cannot diverge. The rule's own literal
  reduction only ever *shrinks* the seek count, so the module's `inCount` is a true upper
  bound and the 1000-key cap can never be under-counted.
- **Window disjointness.** Encoded column values are self-delimiting, so two distinct
  same-width prefixes are never byte-prefixes of one another and their `[prefix, prefix+1)`
  windows cannot overlap. The unbounded-window subsumption branch is the only overlap case,
  and it is correctly folded before scanning.
- **DESC handling.** Per-column direction inversion is baked into the encoded bytes before
  the windows are sorted, so ascending byte order is index-scan order for any mix of
  directions. Confirmed with a new mixed ASC/DESC composite test.
- **Isolation layer.** `IsolatedTable.buildConstraintMatcher` already interprets `multiSeek`
  by treating per-column `EQ` values as an `IN` set; because a composite multi-seek is always
  a *full* cross-product, that per-column decomposition is exactly equivalent, not merely a
  superset. Verified end-to-end with the new merged-emission-order test.
- **Semantic-ordering guard.** The plan declines and the runtime throws, and the runtime's
  throw is genuinely unreachable from this module's plans — a belt-and-braces pair, not
  redundancy, since the runtime has no residual left to degrade to.
- **`seen`-set add-on-yield timing, and the residual-OR over merged tuples.** Both are
  correct for the reasons the handoff gives; the `BINARY`-under-`NOCASE` test pins the second.
- **The `_primary_` branch (`scanMultiSeekPrimary`) is dead code today.** Confirmed
  unreachable: the module never claims an `IN` on the primary key, and the isolation layer's
  `_primary_` retarget fires only for a module-supplied primary index descriptor, which the
  store does not set. Kept rather than deleted — it is documented as unreachable, it is the
  base for `feat-store-pk-in-list-multiseek`, and deleting it would only convert a correct
  answer into an `INTERNAL` throw.
- **Resource cleanup.** Every window goes through the same `yield*` delegation chain as an
  ordinary index scan, so an early `limit` exit propagates `return()` down to the KV
  iterator exactly as before. No new resource to release.

### Minor — fixed in this pass

- **Stale safety note in `key-builder.ts`.** `buildIndexPrefixBounds`'s doc comment enumerated
  its callers ("both `StoreTable` callers…") to justify passing no key transforms — the exact
  kind of note that becomes dangerous when it goes stale. `scanMultiSeek` is a third caller;
  the note now lists all three and states each one's decline mechanism.
- **README paragraph broke a bullet list.** The new `IN`-list description was inserted between
  two items of the "Key Formats" list, splitting it. Moved out to its own subsection below the
  list, and pointed at the index-choice ticket filed below.
- **Test gap: an index whose leading column is the primary key.** This is the exact shape the
  `query()` dispatch reordering exists to protect — `analyzePKAccess` would otherwise take the
  first of the N equality constraints as a full primary-key match and point-read one value,
  whose own filter then ANDs all N mutually-exclusive equalities into zero rows. Confirmed by
  temporarily disabling the dispatch (the case returns `[]`); test added.
- **Test gaps: mixed ASC/DESC composite index, and the cap boundary.** Added. The boundary
  test pins that a list of exactly 1000 keys still seeks, so the `>` in the cap check cannot
  drift to `>=` unnoticed.
- **The store package's test files were never type-checked.** `@quereus/store` ships a
  `tsconfig.test.json` but its `typecheck` script only covered `src/`, so signature drift in
  any store spec — including the ones this ticket added — would not have surfaced in
  `yarn check`. Now `tsc --noEmit && tsc -p tsconfig.test.json --noEmit`, matching
  `@quereus/isolation` and `plugin-loader`. Verified clean: the existing specs had no latent
  type errors, so this adds a guard without a cleanup tail.
- **The isolation-layer gap the handoff flagged.** Two tests added to `isolated-store.spec.ts`:
  raw emission order with overlay rows falling between committed seek windows (asserted
  without `ORDER BY`, so a misordered merge cannot hide behind a Sort), and overlay
  updates/tombstones applied per window.

### Major — filed as tickets

- **`backlog/bug-store-index-choice-ignores-cost`** — `computeBestAccessPlan` returns the
  *first* index that can serve the query, never comparing the costs it already computed.
  That was near-harmless when every candidate was a single-value seek; now an `IN` list makes
  a much worse plan eligible to win on declaration order alone. Reproduced: `a = 7 and b in
  (<300 values>)` with `ix_b` declared before `ix_a` plans 300 seeks plus a residual filter,
  where one seek on `ix_a` would do. Results stay correct — this is work done, not answers.
  Filed rather than fixed inline because changing index selection affects every store query,
  not just the `IN` path.
- **`backlog/debt-store-source-files-too-large`** — `store-table.ts` (~3,300 lines) and
  `store-module.ts` (~4,400) are five times the size of anything else in the package, and this
  ticket added ~290 lines across the pair. Pre-existing, aggravated here; a split is far too
  large to fold into a review pass.

### Tripwires — recorded in code, not filed

- The cross-window `seen` set holds one hex string per yielded row for the life of a
  multi-seek — the only unbounded allocation on the path. Windows are byte-disjoint, so the
  only real duplicate source is a stale index entry. `NOTE:` at the `MultiSeekWindowContext`
  declaration in `store-table.ts` says what to do if a large-result `IN` ever shows up as a
  memory problem.

### Checked and deliberately left alone

- **Duplicate columns in one index (`create index ix on t (a, a)`).** Accepted by DDL, and the
  module counts the column twice into `inCount` and `seekCols`. Results are correct for both
  `a = 2` and `a in (1,2)` — the engine rule declines to build a seek from such a plan and
  falls back. Pre-existing shape, not introduced or worsened here, and chasing it would mean
  changing DDL validation.
- **`a in (1,2) and b > 5` on index `(a, b)` keeps the trailing range as a residual.** Correct,
  just not maximally narrow; the engine has no multi-value prefix-range seek, and the memory
  module documents the same limitation.
- **The narrowing test's `getCount` range assertion (1–6 rather than exactly 3).** Left as the
  implementer wrote it. It still fails loudly on a scan regression (a scan would iterate 100
  data rows and the test asserts zero iterations), so the loose bound costs nothing.

No findings were found in: performance of the single-key path (byte-identical to before),
type safety (no `any`; the `as unknown[]` casts match the engine rule's own idiom for `IN`
values), or error handling (the `INTERNAL` throws are specific, name the offending `idxStr`
and table, and are the correct response to an impossible-by-construction input).
