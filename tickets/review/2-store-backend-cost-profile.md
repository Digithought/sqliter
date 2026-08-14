----
description: Storage backends can now declare how expensive their random row reads and index seeks really are, so the query planner stops pricing a browser-database lookup as if it were as cheap as a disk-backed one.
files:
  - packages/quereus-store/src/common/cost-profile.ts (NEW — the profile type, parity defaults, resolver)
  - packages/quereus-store/src/common/kv-store.ts (`KVStoreProvider.costProfile`)
  - packages/quereus-store/src/common/index.ts (exports)
  - packages/quereus-store/src/common/store-module-base.ts (`protected readonly costProfile`)
  - packages/quereus-store/src/common/store-module.ts (`getBestAccessPlan` passes it through)
  - packages/quereus-store/src/common/store-module-access-plan.ts (the consumer; `vetoCost`)
  - packages/quereus-plugin-indexeddb/src/provider.ts (the declared profile + its derivation)
  - packages/quereus-plugin-leveldb/src/provider.ts (comment: parity is deliberate + unmeasured)
  - packages/quereus-store/test/cost-profile.spec.ts (NEW — 45 tests)
  - packages/quereus-store/test/key-set-seek-store.spec.ts (2 new tests; provider helper now takes a profile)
  - packages/quereus-store/README.md (§ Backend cost profile)
  - packages/quereus-plugin-indexeddb/README.md (§ Query planning)
difficulty: medium
----

# What landed

A storage backend can now tell the query planner what its basic reads cost. Before this,
two constants in `store-module-access-plan.ts` priced every backend identically:
"resolving one index entry to its row costs about what one sequentially scanned row costs"
and "positioning one seek key costs half a scanned row". True enough for LevelDB, false for
IndexedDB, where every point read is a separate request across a browser IPC boundary.

## The surface

`KVCostProfile` (new, `packages/quereus-store/src/common/cost-profile.ts`) has two optional
fields, both expressed as a **ratio to one sequentially scanned row (= 1.0)**:

| field | prices | parity default | IndexedDB declares |
|---|---|---|---|
| `pointRead` | resolving one secondary-index entry to the row it names | 1.0 | 3.0 |
| `seekPositioning` | one key of a multi-seek — position the window *and* read its row | 0.5 | 5.0 |

Declared on the **provider** (`KVStoreProvider.costProfile?`), resolved once in
`StoreModuleBase`'s constructor beside `atomicProvider`, and passed to
`computeBestAccessPlan` as a fifth parameter. `resolveCostProfile` fills parity defaults
per field and replaces any non-finite or non-positive declaration with its parity value
plus a `console.warn`.

Only IndexedDB declares anything. LevelDB, React Native LevelDB, NativeScript SQLite and
every in-memory test double declare nothing and therefore plan byte-identically to before.

## The one policy decision worth re-reading

`pointRead` scales what an index arm **advertises** and how two index arms **rank** against
each other. It deliberately does **not** decide whether an index is used at all: the
seek-vs-scan veto compares a new `IndexPlanCandidate.vetoCost` — the arm repriced at the
parity `pointRead` — instead of the declared cost. Reasoning is stated in full at the veto
site in `store-module-access-plan.ts` and encoded by the "the seek-vs-scan veto is
profile-independent" tests; the short version is that the match-count guess is a fixed
fraction of the table, so raising `pointRead` past 2.83 would switch the range arm off for
*every query on every table* — a knife edge that sits on the guess, not on the measurement.
`store-column-statistics` (plan/, next) is what deletes the clamp.

So on this pass the live lever is `seekPositioning`, which is what moves the engine's
key-set-seek break-even (≈ `N/(2S)`).

# How to exercise it

## The unit surface

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/cost-profile.spec.ts" --reporter spec
```

`cost-profile.spec.ts` drives `StoreModule.getBestAccessPlan` directly with an explicit
`estimatedRows: 1000`, over `t(id integer primary key, a, b, c)` with `ix_a (a)` and
`ix_bc (b, c)`. Groups:

- **`resolveCostProfile`** — absent / empty / partial / malformed declarations. The
  malformed cases capture `console.warn` and assert the *other* field's declared value
  survives.
- **parity is byte-identical** — 11 predicate shapes planned against a provider declaring
  nothing and one declaring `{ pointRead: 1.0, seekPositioning: 0.5 }`; full `deep.equal`
  on the whole plan object, not a field subset.
- **`pointRead` scales the single-window arms** — `eq` = `0.3 + rows·(0.3 + R)`,
  `range` / `prefixRange` = `0.2 + rows·(0.5 + R)`, at R ∈ {1, 3, 7}. Also asserts `rows`
  never moves and the full scan is profile-independent.
- **`seekPositioning` scales both multi-seek arms** — secondary `k·S + 0.3·multiRows`,
  primary `k·S + 0.3·rows`, at S ∈ {0.5, 5.0}; plus an explicit linearity check
  (equal first differences at k = 2..5), because `rule-key-set-seek` fits a line through
  the module's cost at 2 and 1000 keys.
- **the veto is profile-independent** — at `pointRead: 50` (past every arm's flip point)
  each of `eq` / `range` / `prefixRange` still wins: same `indexName`,
  `seekColumnIndexes`, `handledFilters`, `rows`, `explains`; only `cost` moves, and it moves
  past the scan cost. Paired with a check that the veto is not *dead* — on a one-row table
  the range arm is still dropped, on both backends.
- **a profile never changes a row set** — the same 10 queries end to end at 200 and 5 rows,
  parity vs `{ pointRead: 3, seekPositioning: 5 }`, asserting identical rows.

## The key-set rewrite (the motivating behavior change)

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/key-set-seek-store.spec.ts" --reporter spec --grep "IndexedDB profile"
```

Two new tests, both observed rather than predicted:

- **200-row table, IndexedDB profile** — the rewrite still fires (`KEYSETSEMIJOIN` in the
  plan) and the store is still handed a `plan=5` multi-seek. Break-even interpolates to
  ~37 keys against the query's 3.
- **5-row table, IndexedDB profile** — the rewrite **declines** (no `KEYSETSEMIJOIN`),
  where a parity backend still rewrites; both return the same rows. This is Decision 4's
  small-table outcome, deliberately pinned. Physics: the two-key probe costs 10.6 against a
  5-row scan baseline of 5, so `interpolateBreakEven` returns 0.

The 16 pre-existing tests in that file run on parity providers and were not touched.

## Manual / by hand

`IndexedDBProvider.costProfile` carries the full derivation table from
`packages/quereus-plugin-indexeddb/bench/README.md` in its comment. Reviewing the numbers
means checking that table against the bench's arm A / arm B2 / arm C rows — the arithmetic
is reproduced in the comment, not just the conclusion.

# Validation run

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn typecheck` | clean (all workspaces) |
| `yarn lint` | clean |
| `yarn test` | all green — quereus 9601, store 1751, indexeddb 179, sync 725, everything else green; **0 failing** |
| `yarn workspace @quereus/plugin-indexeddb test` | 179 passing |
| `yarn test:store` (LevelDB logic tests) | 9593 passing, 33 pending, 0 failing (~2 min) |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

# Known gaps and things a reviewer should push on

- **The IndexedDB `pointRead` derivation contains an estimate, not a measurement.** The
  bench never timed two-store index paging on its own, so "arm A per row minus entry
  paging" charges entry paging at 0.8× a data row, borrowed from arm B2 (a *native*-layout
  control, and a lower bound at that). The comment says so; whether 0.8 is a fair borrow is
  a fair thing to challenge. The declared 3.0 sits in a band (2.8–3.4) that the estimate
  moves within, not across.
- **`seekPositioning: 5.0` is derived, not measured.** "≈ 2× the point-read cost, neither
  half amortized across a page" is an argument from the request model, calibrated against
  two bench cells (5.5 and 5.7 scan-rows). It is the knob that actually changes plans, and
  it is the softer of the two numbers.
- **The declared cost now reaches the engine, not just this module.** An IndexedDB store
  index seek advertises ~3× its old cost, which feeds join ordering, cache decisions, and
  `rule-key-set-seek`'s `baselineCost` for a seek leaf. No in-repo test exercises an
  IndexedDB-profiled *join*, because the only profiled provider needs a browser. The
  profiled tests here are all over in-memory providers hand-declaring the same numbers,
  which is the right unit-level proxy but is not the real backend.
- **Nothing measures LevelDB.** Parity is a deliberate, unmeasured default; the code says
  so at `LevelDBProvider` and `backlog/debt-leveldb-cost-profile-measurement` is the ticket
  that would fix it. Worth confirming the reviewer agrees that "unmeasured default" beats
  "plausible guess" here.
- **`resolveCostProfile` logs via `console.warn`, not `createLogger`.** The ticket named
  `createLogger`; it is not exported from `@quereus/quereus`'s public entry point, and
  `console.warn('[StoreModule] …')` is this package's existing idiom (16 call sites). If
  the reviewer wants `createLogger`, the export has to be added first.
- **`cost-profile.spec.ts`'s float assertions use `closeTo(…, 1e-9)`** for the arm-cost
  formulas, because the test states them in a different association order than the builder
  computes them. Parity byte-identity uses exact `deep.equal`, which is where exactness
  actually matters.
- **The veto's known hole is unchanged, by design.** A vetoed single-window arm can still
  shadow a multi-seek candidate (`computeBestAccessPlan` picks the cheapest seek first,
  then vetoes). Raising `pointRead` makes single-window arms *less* likely to win the
  ranking, so this narrows the hole rather than widening it — but it is still there, with
  its pre-existing `NOTE:` at the comparison.

# Tripwires recorded (not tickets)

- `NOTE:` on `KVCostProfile` (`cost-profile.ts`) — no third `entryRead` knob for index-entry
  reads. That per-row term belongs to `AccessPlanBuilder`, and scaling it from the store
  would mean restating the builder's formula (the drift `addCost` exists to prevent). If a
  backend ever prices entry reads very differently from data rows, add `entryRead` *and*
  give the builder a per-row-entry hook.
- `NOTE:` at `IndexedDBProvider.costProfile` — the provider wraps every store in a
  `CachedKVStore` by default and the bench measured raw IndexedDB. A warm LRU makes point
  reads far cheaper than 3.0; a static profile cannot express a hit rate. Revisit if
  cache-hit rates become observable at plan time.
- `NOTE:` at `primaryKeyMultiSeekPlan` — that arm is slightly over-charged on an expensive
  backend (`seekPositioning` prices an index window it does not use: ≈3 units of real cost,
  charged 5). Accepted rather than split into a third knob; only ever makes a very large
  `where pk in (…)` prefer a scan slightly sooner than it should.
- Comment at `LevelDBProvider` — parity is a deliberate, unmeasured default, not an
  oversight; naming `backlog/debt-leveldb-cost-profile-measurement`.
