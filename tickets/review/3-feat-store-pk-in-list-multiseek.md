---
description: On the persistent storage backend, looking up a list of rows by their primary key now fetches just those rows instead of reading the whole table. Review the planner arm and the test suite that proves it.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts     # the PK arms (landed in an earlier commit)
  - packages/quereus-store/src/common/store-table-scan.ts             # scanMultiSeekPrimary — the runtime twin
  - packages/quereus-store/test/pushdown.spec.ts                      # NEW: literal-list end-to-end block (~line 1754)
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts          # plan-level PK cases
  - packages/quereus-store/test/key-set-seek-store.spec.ts            # PK-declines test inverted
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts        # stale comment corrected
  - packages/quereus-store/README.md                                  # docs
  - docs/store.md                                                     # access-pattern table row
difficulty: medium
---

# Review: primary-key multi-seek for `pk in (…)` on the store backend

## What the feature does

Before: `select … from t where pk in (1, 2, 3)` against a `using store` table read the
whole table and re-checked the `IN` as a residual filter. The primary-key arm of the
store's access planner matched `'='` only, so an `IN` fell through to the full scan.

After: an `IN` covering **every** primary-key column is claimed by the primary-key arm and
served as one deduplicated point read per distinct key tuple (`_primary_` `plan=5`). The
runtime half (`StoreTableScan.scanMultiSeekPrimary`) already existed and was previously
reachable only from the engine's key-set rewrite; the planner change makes the literal-list
form reach it too.

Three things ride along:

- **A cross-product on composite keys.** `a in (1,2) and b in (10,20)` on `primary key
  (a, b)` is four point reads. A key only *partly* pinned still scans.
- **Primary-key ordering is advertised.** The point reads emit ascending by encoded data
  key — which IS primary-key order, DESC members included — so `where pk in (…) order by
  pk` elides its `Sort`. This is the only claim in the change that can produce *wrong-order
  rows* rather than merely slow ones.
- **A routing change on the plain `=` point arm.** The point-lookup branch now calls
  `setSeekColumns(pkColumns)`, which routes it through `rule-select-access-path`'s
  index-aware arm instead of its legacy PK arm. Needed because the branch also claims a
  single-element `IN`, which the legacy arm (`op === '='` only) would leave seeked nowhere.
  **This is the widest-blast-radius line in the diff** — every full-primary-key `'='`
  predicate against a store-backed table now takes the index-aware path.

Declines (correct, just not accelerated — the residual is kept and the answer is
unchanged): over 1000 seek keys, and a semantic-ordering primary-key member (TIMESPAN,
JSON), where a byte window has no faithful position for every member.

## State of the work

The planner arm and the plan-level tests landed in commits `05f396ee` / `cb79c8a7`
(a prior run of this ticket). **Unchanged and unreviewed since** — review them as part of
this ticket, not as already-blessed code. This run added the end-to-end coverage, inverted
one test that asserted the old behaviour, and updated the docs.

Full validation, all green:

- `yarn build`
- `yarn test` — 9326 + 1685 + … passing, 0 failing
- `yarn test:store` — 9318 passing, 33 pending, 0 failing
- `yarn workspace @quereus/store run typecheck` (includes `tsconfig.test.json`)
- `yarn workspace @quereus/isolation run typecheck`

One pre-existing-looking failure turned out to be **mine**: `key-set-seek-store.spec.ts`'s
`a runtime set on the PRIMARY KEY declines: the store claims IN for secondary indexes only`
asserted exactly the behaviour this feature changes. It is now
`a runtime set on the PRIMARY KEY is served as a `_primary_` multi-seek`, moved out of the
`gates that must decline` describe, asserting `KEYSETSEMIJOIN` fires and the store receives
`multiSeekRe('_primary_')`. Sibling ticket `feat-store-pk-key-set-seek-coverage` had that
inversion on its own TODO list; its ticket has been struck through accordingly, and its
merge-arm open question is partly answered by it (the rewrite DOES fire on a single-column
store PK with no `order by`).

## Use cases to exercise while reviewing

Each of these is a query you can run against a `using store` table; the interesting part is
the `filterInfo.usableIndex` string in `query_plan()`'s `properties` (`idx=_primary_(0);
plan=5;inCount=N[;seekWidth=W]` for the multi-seek, `plan=2` for the point lookup, `plan=0`
for a scan) — rows alone cannot tell a seek from a scan + residual.

| Query | Expected |
|---|---|
| `where pk in (1, 3)` | `plan=5;inCount=2`, no residual `Filter` |
| `where pk in (3, 3, 1)` | two rows, each once |
| `where pk in (1, null, 3)` | NULL dropped |
| `where pk in (?, ?)` with `[null, null]` | zero rows, data store untouched |
| `where pk in ()` | folded to `EmptyRelation` before planning |
| `where pk in (2)` / `where pk = 2` | `plan=2` — the point arm, not the multi-seek |
| `where pk in (5, 1, 3) order by pk` | no `Sort`, rows emitted `1, 3, 5` |
| `primary key (pk desc)`, `order by pk desc` | no `Sort`, rows descending |
| `primary key (pk desc)`, `order by pk` | `Sort` survives, rows ascending |
| `a in (1,3) and b in (10,20)` on `(a, b)` | `plan=5;inCount=4;seekWidth=2` |
| `a in (1, 2)` alone on `(a, b)` | `plan=0` + residual `Filter` — unchanged behaviour |
| 1001-element list | `plan=0` + residual, answer unchanged |
| exactly 1000 | `plan=5;inCount=1000` |
| `timespan primary key`, `d in ('PT1H', 'PT3H')` | `plan=0` + residual; matches `'PT60M'` |
| `text primary key`, `name in ('alice', 'ALICE', 'BOB')` | 3 seek keys, 2 distinct rows (store's default key collation is NOCASE) |

## What the new tests cover

`packages/quereus-store/test/pushdown.spec.ts`, new top-level describe
`primary-key IN-list multi-seek (feat-store-pk-in-list-multiseek)` (~line 1754), 30 cases:

- single-column key: arm selection, no-residual, basic/duplicate/NULL/no-match lists, the
  empty list, parameter-bound lists, the single-element and plain-`=` point-arm routing,
  `limit 1`;
- ordering: ASC elision + emitted order, DESC key elision + descending order, DESC key with
  an opposite `order by` (Sort survives), composite `order by a, b`, composite with a
  `DESC` member. **Rows are never re-sorted in JS anywhere in this block** — a re-sort would
  hide exactly the failure the ordering advertisement can cause;
- composite key: IN × IN, IN × EQ, no-match, and the partial-pin scan;
- declines: over-cap, exactly-cap, TIMESPAN key;
- text key under the table key collation; read-your-own-writes inside a transaction
  (uncommitted insert surfaces, uncommitted delete does not);
- a memory-module oracle comparison over five composite-key predicates;
- narrowing on a counting KV store: `iterateEntryCount === 0`, one `getMany` round trip,
  exactly 3 keys batched, `getCount === 3`; and an all-NULL list that touches the data
  store zero times.

## Known gaps — treat the tests as a floor

- **Isolation-wrapped read-your-own-writes over a `_primary_` multi-seek is not covered
  here.** Deliberately: it belongs to `feat-store-pk-key-set-seek-coverage`. The path was
  reasoned about but not run — `IsolatedTable.resolveScanIndex` maps a `role: 'primary'`
  access path to a primary-key-ordered merge, and the memory module's `scan-plan.ts`
  decodes a `_primary_` `plan=5` into `equalityKeys`, so the shape is *believed* to work.
  The store's own (non-isolation) pending-op read-your-own-writes IS covered.
- **The `setSeekColumns` routing change is covered only by the suites passing**, not by a
  test that names the two arms and asserts they build the same plan. If a reviewer wants a
  belt-and-braces check, `runtime-key-set-plan.spec.ts` is where a direct
  `getBestAccessPlan` comparison would go. The fallback if it ever regresses — setting seek
  columns only when the branch claimed an `IN` — is recorded in the source comment, but
  prefer fixing the real cause: two shapes for one arm is how the plan and the scan drift.
- **No performance measurement.** "Reads only the listed rows" is asserted via KV-store
  operation counts, not timings. No benchmark exists for this path.
- **Cost-model behaviour is inherited, not re-verified.** The multi-seek arm returns
  straight out of the PK branch and never reaches the seek-versus-scan comparison, matching
  the secondary multi-seek arm's documented exemption (the engine reads the arm's cost as a
  line at 2 and 1000 keys). No new test pins the PK arm's exemption specifically.
- **`MAX_MULTI_SEEK_KEYS` (1000) is stated in two files** (`store-module-access-plan.ts`
  and `store-table-scan.ts`'s malformed-plan assertion) plus three test files as a literal.
  Not new, and the assertion is the safety net for the pair diverging.

## Suggested review focus

1. The ordering advertisement — `buildPkOrderingAdvertisement` merged into the multi-seek
   result, against `scanMultiSeekPrimary`'s actual emission order, for a DESC key member and
   for a composite key. Wrong-order rows are the one silent-corruption mode here.
2. `resolvePrimaryKeyPins`'s per-column `find`: the doc comment explains why counting raw
   equality filters instead would claim both filters on `a = 1 and a = 2` over `(a, b)` and
   return the whole table. Confirm the reasoning holds for an `IN` mixed with an `=`.
3. The `setSeekColumns` addition on the point arm — whether any plan-shape assertion
   elsewhere in the repo silently changed meaning rather than failing.
4. `claimFirstPerRole`'s positional claim against `rule-select-access-path`'s `eqBySeekCol`
   pick, now that an `IN` can fill a PK equality role.
