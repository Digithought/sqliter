---
description: On the persistent storage backend, looking up rows by a list of primary keys now fetches just those rows instead of reading the whole table. Reviewed and shipped.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts     # the PK arms + the shared equality-pin helper
  - packages/quereus-store/src/common/store-table-scan.ts             # scanMultiSeekPrimary — the runtime twin
  - packages/quereus-store/test/pushdown.spec.ts                      # literal-list end-to-end block (~line 1754)
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts          # plan-level PK cases
  - packages/quereus-store/test/key-set-seek-store.spec.ts            # PK-declines test inverted
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts        # stale comment corrected
  - packages/quereus-store/README.md                                  # docs
  - docs/store.md                                                     # access-pattern table row
---

# Complete: primary-key multi-seek for `pk in (…)` on the store backend

## What shipped

`select … from t where pk in (1, 2, 3)` against a `using store` table is now served as one
deduplicated point read per distinct key tuple (`_primary_` `plan=5`) instead of a full
table scan with the `IN` re-checked as a residual filter. Composite keys cross-product
(`a in (1,2) and b in (10,20)` on `primary key (a, b)` is four point reads); a key only
partly pinned still scans. The arm advertises primary-key ordering — the point reads are
emitted ascending by encoded data key, which IS primary-key order with per-column `DESC`
inversion baked into the bytes — so `where pk in (…) order by pk` elides its `Sort`.
Declines (correct, just not accelerated): over 1000 seek keys, and a semantic-ordering key
member (TIMESPAN, JSON).

The plain `=` point arm now names its seek columns, which routes it through
`rule-select-access-path`'s index-aware arm instead of its legacy primary-key arm — needed
because the same branch also claims a single-element `IN`, which the legacy arm (matching
`op === '='` only) would leave seeked nowhere.

Implemented across `05f396ee` / `cb79c8a7` / `54fb375d`; this review pass added the DRY
consolidation, one doc-accuracy correction, and three tests described below.

## Review findings

Everything below was checked against the implement diff read first, with the handoff
summary read afterwards.

### Fixed in this pass (minor)

- **DRY — two copies of the equality-pin loop.** `resolvePrimaryKeyPins` and
  `tryIndexAccessPlan` each carried their own near-identical loop computing (pinned
  columns, seek-key cross-product, `isMultiSeek`) from `equalitySeekKeyCount` /
  `isMultiValueEquality`. That duplication is exactly how the `'='`-only primary-key arm
  and the `IN`-claiming index arm drifted apart in the first place — the drift this whole
  ticket exists to repair. Extracted `resolveEqualityPins(filters, colIdxs)`, returning the
  longest pinned LEADING run plus its arithmetic; the primary-key arms require the run to
  cover the whole key, the index arm takes whatever prefix it gets. One site now defines
  the positional pick both arms claim against.
- **An incomplete soundness comment.** The `**No collation gate, and that is not an
  oversight**` block gave two reasons (schema-side collation reconciliation, and
  `matchesFilters` re-application) that between them cover only over-fetch and schema
  divergence. Neither covers the PREDICATE-side shape `where pk collate nocase in (…)` over
  a BINARY key column, which would UNDER-fetch. `PredicateConstraint` carries no collation,
  so the module cannot see that and always claims; the engine's `classifyCollationCover`
  (reading the predicate's effective collation off the source expression) is what declines
  it to a scan + residual. Verified by probe: that query, and its composite-key variant,
  both plan `plan=0` + `FILTER` and match a memory-module oracle row for row. Added the
  missing sentence naming the engine-side gate as the third net — a future PK arm inherits
  it only by going through the rule's index-aware path.
- **Test gaps closed.** Three tests added:
  - `runtime-key-set-plan.spec.ts` — the belt-and-braces check the handoff itself asked
    for: a plain `=` and a one-element `IN` build an identical `_primary_` point plan,
    pinning `seekColumnIndexes` on the point arm (the widest-blast-radius line in the diff)
    at the plan level rather than relying on suites-still-pass.
  - `pushdown.spec.ts` — a predicate on a non-key column stays a residual over the seek.
  - `pushdown.spec.ts` — a range on the SAME pk column loses to the multi-seek and comes
    back as a residual (`pk in (1,3,5) and pk > 2`), pinning the arm-order decision the
    diff made and the per-ROLE rather than per-column claim it depends on.

### Checked, found sound (no action)

- **Ordering advertisement** — the one wrong-rows mode here. `buildPkOrderingAdvertisement`
  is the shared helper every other primary-key arm uses, truncated to
  `pkOrderPreservingPrefixLength` and voided at 0; `scanMultiSeekPrimary` sorts by encoded
  data key, and `encodeDataKey` bakes per-column `DESC` into the bytes, so the advertised
  order IS the emitted order for ASC keys, DESC keys, composite keys, and per-column mixed
  directions. Direction-mismatched and `NULLS FIRST` orderings correctly keep their `Sort`.
- **`claimFirstPerRole` vs `rule-select-access-path`'s `eqBySeekCol`** — both take the FIRST
  filter per column under the same well-formedness test, so the module's claim and the
  rule's pick cannot disagree. The one shape where they could (a runtime set and a literal
  `IN` on one column) is unreachable today and degrades to seek + reattached residual
  anyway, because `RECLAIMABLE_OPS` includes `IN`.
- **The `setSeekColumns` routing change.** Compared the legacy and index-aware arms line by
  line: identical collation lookup for `_primary_` (both resolve the table column's declared
  collation), identical `idxStr`, identical physical index name, identical NULL-key fold.
  The legacy arm's extra `rows <= 10` gate is satisfied by the point arm's `rows: 1`.
- **`resolvePrimaryKeyPins`' per-column pin with an `IN` mixed with an `=`** — `pk = 2 and
  pk in (1,2,3)` in either order pins on the first filter, claims exactly that one, and
  leaves the other as a residual; answers verified both ways.
- **Behaviour probes run against the store and, where meaningful, a memory-module oracle:**
  single-element `IN` bound to NULL, plain `=` bound to NULL, `delete` and `update` driven
  by an `IN` list, an `IN` list as the inner of a join, an `IN` over the whole key of a
  table with no declared primary key (every column is a key member — plans `seekWidth=2`
  and answers correctly), mixed-type members against an integer key, an explicit `collate
  binary` text key under the default NOCASE table key collation, and `limit`/`offset` over
  the ordered seek. All correct.
- **Docs.** `docs/store.md`'s access-pattern table, `packages/quereus-store/README.md`'s
  shape table and multi-seek prose, and the isolation-layer merge-order contract in
  `docs/design-isolation-layer.md` all read correctly against the new behaviour; no stale
  "IN on the primary key scans" claim survives anywhere in source or docs.

### Filed as tickets

None. The two things a ticket would have covered are already owned:

- Isolation-wrapped read-your-own-writes over a `_primary_` multi-seek belongs to
  `feat-store-pk-key-set-seek-coverage` (already in `implement/`, with the case list). Risk
  reviewed and judged low: the overlay side of that merge is a memory table either way, its
  window matcher documents and implements per-column-OR semantics for `multiSeek`
  specifically, and the store's contribution is the ascending-key emission this ticket
  verified.
- `bug-store-pk-range-preempts-cheaper-index` (backlog) already owns the general
  arm-competition problem; the multi-seek-before-range ordering here is a deliberate local
  decision, now pinned by a test rather than only by a comment.

### Recorded as tripwires

None — no new conditional concern surfaced that is not already carried by an existing
`NOTE:` at its site. The two candidates were both already documented in the source: the
multi-seek arm's exemption from the seek-versus-scan comparison (a measured decision, with
its reasoning and its failure mode recorded at the comparison site) and the `1000` seek cap
restated in the planner, the scan's malformed-plan assertion, and three test files (the
assertion is the net for the pair diverging, and it is pre-existing).

### Known gaps carried forward

- No performance measurement. "Reads only the listed rows" is asserted via KV-store
  operation counts (`iterateEntryCount === 0`, one `getMany`, exactly the listed keys), not
  timings; no benchmark exists for this path.
- The primary-key arm's cost-model exemption is inherited from the secondary multi-seek
  arm's measured reasoning; no test pins the PK arm's exemption specifically.

## Validation

- `yarn build` — clean
- `yarn lint` — clean
- `yarn test` — 9326 + 1688 + 725 + … passing, 0 failing (the store package's 1688 includes
  this pass's three new tests)
- `yarn workspace @quereus/store run typecheck` — clean
- `yarn test:store` was run green by the implement stage and not re-run here; this pass's
  changes are one behaviour-neutral extraction, one comment, and three new tests, all
  covered by the suites above.
