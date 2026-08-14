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
  - packages/quereus-store/test/cost-profile.spec.ts (NEW — 46 tests)
  - packages/quereus-store/test/key-set-seek-store.spec.ts (2 new tests)
  - packages/quereus-store/README.md, packages/quereus-plugin-indexeddb/README.md, docs/module-authoring.md
difficulty: medium
----

# What landed

A storage backend can tell the query planner what its basic reads cost. Before this, two
constants in `store-module-access-plan.ts` priced every backend identically: "resolving one
index entry to its row costs about what one sequentially scanned row costs" and "positioning
one seek key costs half a scanned row". True enough for LevelDB, false for IndexedDB, where
every point read is a separate request across a browser IPC boundary.

## The surface

`KVCostProfile` (`packages/quereus-store/src/common/cost-profile.ts`) has two optional
fields, both a **ratio to one sequentially scanned row (= 1.0)**:

| field | prices | parity default | IndexedDB declares |
|---|---|---|---|
| `pointRead` | resolving one secondary-index entry to the row it names | 1.0 | 3.0 |
| `seekPositioning` | one key of a multi-seek — position the window *and* read its row | 0.5 | 5.0 |

Declared on the **provider** (`KVStoreProvider.costProfile?`), resolved once in
`StoreModuleBase`'s constructor beside `atomicProvider`, and passed to
`computeBestAccessPlan` as a fifth parameter. `resolveCostProfile` fills parity defaults per
field and replaces any non-finite or non-positive declaration with its parity value plus a
`console.warn`.

Only IndexedDB declares anything. LevelDB, React Native LevelDB, NativeScript SQLite and
every in-memory test double declare nothing and therefore plan byte-identically to before.

## The one policy decision worth re-reading

`pointRead` scales what an index arm **advertises** and how two index arms **rank** against
each other. It deliberately does **not** decide whether an index is used at all: the
seek-vs-scan veto compares a new `IndexPlanCandidate.vetoCost` — the arm repriced at the
parity `pointRead` — instead of the declared cost. Reasoning is stated in full at the veto
site and encoded by the "the seek-vs-scan veto is profile-independent" tests; the short
version is that the match-count guess is a fixed fraction of the table, so raising
`pointRead` past 2.83 would switch the range arm off for *every query on every table* — a
knife edge sitting on the guess, not on the measurement. `store-column-statistics` (plan/,
next) is what deletes the clamp.

So on this pass the live lever is `seekPositioning`, which moves the engine's key-set-seek
break-even (≈ `N/(2S)`).

# Review findings

Reviewed the implement diff (`70dbe7a3`) before the handoff summary. Checked: the veto
policy and its interaction with arm ranking; the resolver's failure modes; every seam the
declaration crosses (provider → `StoreModuleBase` → `computeBestAccessPlan`, including the
isolation layer and both plugin `register()` paths); the IndexedDB derivation against the
bench data and the bench harness source; test coverage; docs.

## Verified, no change needed

- **The IndexedDB arithmetic reproduces.** Re-derived every cell of the provider's table
  from `bench/README.md`: `pointRead` 2.80 / 2.89 / 3.43 at the three sample points, and
  `seekPositioning` 5.57 / 5.78. Band and roundings are as claimed.
- **The `pointRead` derivation models the real code path.** The concern was that the bench
  might have measured unbatched per-key transactions while `StoreTableScan` batches through
  `getMany`. It does not: bench arm A resolves through `resolveRowsOneTx` at the same
  `RESOLVE_BATCH`, and `IndexedDBStore.getMany` is N `store.get()` calls on one transaction.
  Same shape, so the ratio transfers.
- **Ranking-vs-veto cannot disagree.** Candidates rank on declared cost but are vetoed on
  parity cost, which in principle allows picking an arm that then loses a veto another arm
  would have survived. It cannot happen here: `eq` prices below `range`/`prefixRange` at
  every `pointRead > 0` (0.3 + 0.1N(0.3+R) vs 0.2 + 0.3N(0.5+R)), so the order is fixed by
  arm shape and the declaration cannot reorder it.
- **No provider wrapper drops the declaration.** Only four types implement
  `KVStoreProvider`, there are no delegating provider proxies, `IsolationModule` forwards
  `getBestAccessPlan` to the inner `StoreModule`, and both plugins hand the raw provider to
  the module. `CachedKVStore` wraps stores, not the provider.
- **`computeBestAccessPlan` has exactly one caller**, so the new parameter has no unmigrated
  call site.

## Fixed in this pass (minor)

- **Four stale references to the deleted constants.** `ROW_RESOLUTION_COST` and
  `INDEX_SEEK_COST` were removed, but `docs/module-authoring.md`,
  `packages/quereus/src/vtab/memory/module.ts`, `packages/quereus-store/test/pushdown.spec.ts`
  and `tickets/plan/3-store-column-statistics.md` still named them — each now points at the
  profile field that replaced it.
- **`docs/module-authoring.md` documented only half the pattern.** Its "charge the work your
  seek actually does" guidance told module authors to add a per-row resolution term as one
  constant. Added the second half: when a module runs over more than one backend, let each
  backend declare the ratio, with `KVCostProfile` as the worked example.
- **`PARITY_COST_PROFILE` is now frozen.** `resolveCostProfile(undefined)` returns that very
  object rather than a copy, so every parity backend in the process shares one instance —
  and it is a public export, reachable from JS the interface's `readonly` cannot stop.
- **Test gap at the resolver/planner seam.** The resolver was unit-tested and the planner was
  driven with well-formed profiles, but nothing pinned that `StoreModuleBase` resolves the
  declaration before handing it on — a refactor passing `provider.costProfile` straight
  through would leave both groups green while a `NaN` turned every `<` in the module into
  `false`. Added a test that a provider declaring `{ pointRead: NaN, seekPositioning: -1 }`
  plans identically to an undeclared one across all 11 predicate shapes and warns once per
  bad field.
- **Test gap on joins.** The handoff correctly noted that a declared cost now reaches join
  ordering with nothing exercising it. Added a self-join to the "a profile never changes a
  row set" query set, so the safety property covers a shape where the engine, not this
  module, consumes the advertised cost.

## Recorded as tripwires, not tickets

- **`NOTE:` at `IndexedDBProvider.costProfile`** — the 0.8 entry-paging borrow is a *lower*
  bound, which biases the declared 3.0 pessimistic. Arm B2 spends one request per entry page;
  arm A spends two (`bench/arms.mjs` charges `requests += 2` per `readPage`), so charging
  arm A's paging at B2's price leaves too much in the resolution remainder and the true
  `pointRead` is likely at or below 2.8. Inert while the veto is parity-clamped — an
  over-stated `pointRead` can only inflate what an arm advertises, never switch one off.
  Revisit condition and the bench arm that would settle it are recorded at the site.
- Four tripwires the implementer recorded were re-read and left as they are: no third
  `entryRead` knob (`cost-profile.ts`), the `CachedKVStore` warm-cache caveat and the
  `primaryKeyMultiSeekPlan` over-charge (both accurate as stated), and LevelDB's deliberate
  unmeasured parity.

## Filed as tickets

None. The one class-level finding — 41 hand-copied `createInMemoryProvider` helpers in
`packages/quereus-store/test/`, of which this ticket added the 41st — is already claimed by
`backlog/debt-store-test-shared-inmemory-provider`. Appended an arm there recording that two
specs now take an optional `costProfile` and spread it in only when present, so a shared
factory that always sets the property would silently stop those tests testing what they test.

## Deliberately not filed

- **`store-module-access-plan.ts` is 936 lines.** Measured with `wc -l`; 557 of those are
  comment lines (`grep -c` on comment-leading whitespace), leaving ~380 lines of code across
  9 functions. Documentation-dense, not oversized — no size-debt ticket.
- **The flip-point numbers (2.83 / 6.17 / 9.7) appear in four places** — the profile comment
  block, the README, the test rationale, and by reference at the veto site. Three of those
  are audience-specific restatements and the fourth is a pointer, so this is not the kind of
  duplication that drifts silently; `store-column-statistics` deletes the clamp they justify.
- **The `pkPins` multi-seek arm returns without ever facing the veto**, and
  `seekPositioning: 5` makes it advertise higher. Pre-existing shape, unchanged by this
  ticket, and the direction is right: the engine's own comparison declines more often.

# Validation

Run on the post-review tree, not just the implement tree.

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn typecheck` | clean (all workspaces) |
| `yarn lint` | clean |
| `yarn test` | 0 failing — quereus 9601, store 1752, indexeddb 179, sync 725, all others green |
| `yarn test:store` (LevelDB logic tests) | 9593 passing, 33 pending, 0 failing (~6 min) |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

# Known limits carried forward

- **`seekPositioning: 5.0` is derived, not measured** — "≈ 2× the point-read cost, neither
  half amortized across a page" is an argument from the request model, calibrated against two
  bench cells (5.5 and 5.7 scan-rows). It is the knob that actually changes plans and the
  softer of the two numbers.
- **No in-repo test exercises a real IndexedDB-profiled backend**, because the only profiled
  provider needs a browser. Every profiled test runs over in-memory providers hand-declaring
  the same numbers — the right unit-level proxy, but not the real backend.
- **Nothing measures LevelDB.** Parity is a deliberate, unmeasured default; the code says so
  at `LevelDBProvider` and `backlog/debt-leveldb-cost-profile-measurement` would fix it.
- **`resolveCostProfile` logs via `console.warn`, not `createLogger`** — the latter is not
  exported from `@quereus/quereus`'s public entry point, and `console.warn('[StoreModule] …')`
  is this package's existing idiom (16 call sites). Switching would need the export first.
- **The veto's known hole is unchanged, by design.** A vetoed single-window arm can still
  shadow a multi-seek candidate (cheapest seek is picked first, then vetoed). A higher
  `pointRead` makes single-window arms less likely to win the ranking, so this narrows the
  hole rather than widening it; its pre-existing `NOTE:` stays at the comparison.
