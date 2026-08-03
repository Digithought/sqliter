---
description: Looking up a single row by a duration or JSON key in a persistent table now jumps straight to the row instead of reading the whole table, and still finds it when the query spells the duration differently than the stored row. Reviewed and complete.
files:
  - packages/quereus-store/src/common/store-table-scan.ts          # analyzePKAccess point arm, analyzeIndexAccess EQ prefix
  - packages/quereus-store/src/common/pk-key-resolution.ts         # semanticProbeIsKeyFaithful — canonical per-arm degradation doc
  - packages/quereus-store/src/common/json-key.ts                  # jsonKeyEncodable doc
  - packages/quereus-store/src/common/store-module-access-plan.ts  # multi-seek decline rationale
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts
  - packages/quereus-store/test/json-semantic-key-order.spec.ts
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts
  - packages/quereus-store/test/pushdown.spec.ts
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts
  - docs/types.md   # § Semantic ordering
  - docs/store.md   # order-preservation bullet, layer-size NOTE
---

# Re-opened equality seeks over TIMESPAN and JSON key columns

## What shipped

A store-backed table whose primary key (or a leading secondary-index column) is declared
`timespan` or `json` now answers an **equality** predicate through its key bytes instead
of scanning the whole table:

- `where d = 'PT60M'` on a `timespan` primary key is one data-store `get` — and it finds
  the row stored as `'PT1H'`, because both spellings encode to the same key (total
  seconds).
- `where j = json('{"b":2,"a":1}')` on a `json` primary key finds the row stored as
  `'{"a":1,"b":2}'` (the structural key form sorts object keys).
- The same applies to a secondary index whose leading columns are such types.

Both were previously declined at the scan layer per **schema**. The plan side already
claimed those filters handled, so the answer was right but came from a full scan.

Three source changes, all in `store-table-scan.ts`:

1. **`analyzePKAccess`** — the schema-level `pkHasSemanticOrderingMember()` gate on the
   full-PK-equality arm is replaced by a per-value gate over the collected probes
   (`semanticProbeIsKeyFaithful`). An unfaithful probe **declines the whole arm** (an
   equality window is a single byte position and cannot be widened the way a range bound
   can), falling through to `{ type: 'scan' }`, where `matchesFilters` re-checks under the
   type's own comparator.
2. **`analyzeIndexAccess`** — the EQ-prefix loop breaks on an unfaithful *probe* rather
   than on `hasSemanticOrdering`. Here the prefix **stops short** instead of declining: a
   window over fewer columns is a strict superset, and the residual narrows it.
3. **`pkHasSemanticOrderingMember()` is kept**, re-pointed at its one remaining caller
   `scanMultiSeekPrimary` (itself unreachable from this module's own plans today).

`store-module-access-plan.ts` needed no behavioural change — its full-PK-equality arm and
`tryIndexAccessPlan`'s equality arm never consulted `hasSemanticOrdering` on the plain EQ
path.

**One deliberate behaviour change:** an equality probe against a declared-`json` key whose
string leaf or object key carries an unpaired surrogate now **raises** the existing
`unpaired surrogate` error, where before it silently returned zero rows via the full scan.
This matches what text primary keys and JSON range bounds already do.

**Still declined:** IN-list multi-seeks. Backlog `feat-store-semantic-key-multiseek`.

## Review findings

### Soundness — checked, nothing found

- **Plan/scan agreement** (the class where a bug returns wrong rows rather than slow
  ones). Walked each arm. The plan's full-PK-equality claim is now honoured by a real
  point seek, and when the probe gate declines, the fall-through still applies
  `matchesFilters`, which ANDs every pushed constraint under the column's real comparator
  — so the plan's "filters handled" claim survives an arm swap at runtime. On the index
  side the plan checks `indexPrefixSeekIsCollationExact` over the **full** EQ prefix `N`
  while the scan checks it over the possibly-shorter `k ≤ N`; the predicate is a
  per-position AND, so a passing `N` check implies a passing `k` check and the scan can
  never `return null` (dropping to a full scan) after the plan already dropped the
  residual. The reverse direction is a cost-only plan, which retains the residual.
- **Sparse-array hazard** in `eqValues.every((v, i) => …)`: `eqValues` is
  `new Array(pkColumns.length)` filled by a loop that `break`s early, and
  `Array.prototype.every` **skips holes** — a partially-filled array would pass the gate
  vacuously. Guarded correctly: `allEq && …` short-circuits, and whenever `allEq` is true
  the array is dense. Correct as written; the safety rests entirely on that short-circuit.
- **Gate totality.** The gate now runs on the hot point-lookup path and calls
  `type.groupKey?.(probe)`. `TIMESPAN.groupKey` → `timespanTotalSeconds` catches its own
  parse failure and returns `undefined`, so the gate can never throw where the old
  schema-level decline was silent.
- **Superset invariant** of the index EQ prefix stopping short, including stopping at
  position 0 (leaves `eqValues` empty, falls through to the range arm, which finds no
  range constraint and full-scans).
- **Overlay / read-your-own-writes** through `readLiveRowByPk` → `readEffectiveRowByKey`
  on the newly-reachable point arm — the implementer's isolated-store tests cover staged
  rows, pending deletes, and a differently-spelled overlay shadow.

### The implementer's own listed gaps — probed independently

- **Gap 1, "the EQ probe gate may be purely defensive."** Independently attempted and
  reached the same conclusion: it is invariant maintenance, not a row fix. Enumerated
  every unfaithful shape. A numeric TIMESPAN probe would seek a window that *is* a real
  stored key position (`d = 5` ↔ the row storing `'PT5S'`), but `matchesFilters` rejects
  it on the storage-class mismatch. An unparseable TIMESPAN probe seeks a TEXT-tagged
  position no stored key occupies, and can never equal a stored row's canonical text
  (canonical text always parses). A bigint JSON probe folds to the NUMBER rank in bytes
  while `deepCompareJson` ranks it at OBJECT — zero rows both ways. The one shape where
  the gate changes an *outcome* is a blob JSON probe (raise vs empty), which gap 2 shows
  cannot reach the equality arm. Documented as invariant maintenance; no ticket.
- **Gap 2, "the blob/bigint JSON EQ probe never reaches the store."** Confirmed, with the
  mechanism: `docs/types.md` § JSON records that `insertCrossTypeCoercion` wraps the
  non-JSON side of a comparison in `cast(… as json)`, and a blob casts to NULL, making the
  comparison UNKNOWN. So a raw blob genuinely cannot reach the EQ arm — that half of the
  gate is unreachable-by-construction on the equality path. Left in place (the range arm
  needs it, it is one cheap call, and removing it would make the two arms disagree); the
  implementer's tests for it assert engine folding rather than store behaviour, which is
  now said plainly in their comments. No ticket.
- **Gap 3, the exact `iterateEntryCount === 3` assertion.** Deliberate, and the direction
  argued in the handoff is right (a range would make the count *smaller*, the direction
  that would silently mask a regression). Left as-is.
- **Gap 4, no store-level equality twin of the isolation-package secondary-index overlay
  test.** The isolation package's own `store-semantic-index-window-overlay` already covers
  the equality arm of that fix. Not worth a ticket.
- **Gap 5, multi-seek may be closer to sound than the comment claims.** Already tracked as
  backlog `feat-store-semantic-key-multiseek` (verified present); the handoff's analysis is
  a useful head start for it. Nothing filed.

### Fixed in this pass (minor)

- `semanticProbeIsKeyFaithful`'s doc comment (`pk-key-resolution.ts`) was **stale**: it
  still described itself as "the per-VALUE precondition a re-opened **range** window
  needs" and stated flatly that "Callers SKIP an unfaithful bound … rather than declining
  the whole access". Both are now false — the PK point arm declines the whole access and
  the index EQ prefix stops short. Rewritten as **the** canonical per-arm degradation
  list (range bound skipped / point arm declined / index prefix shortened / multi-seek
  declined upstream per schema).
- `jsonKeyEncodable`'s doc comment (`json-key.ts`) carried the same range-only framing,
  and its blob bullet claimed only "the window widens". Corrected for both arms.
- The tripwire NOTE in `analyzePKAccess` claimed the double TIMESPAN parse costs "once per
  QUERY rather than per row". `runtime/emit/scan.ts:145` calls `vtabInstance.query()` once
  per **seek**, so a seek-driven nested-loop join pays it once per outer row. The
  magnitude claim is corrected; the tripwire itself stands (still nothing today).
- **DRY.** The widen-vs-decline rationale had been restated in full at six sites. Collapsed
  three of them (`analyzePKAccess`, `analyzeIndexAccess`, `buildPKRangeBounds`) to a
  pointer at the canonical doc plus their genuinely site-specific content — notably
  `analyzePKAccess`'s "declining at runtime is safe even though the plan already claimed
  handled", which is stated nowhere else. `store-table-scan.ts` 1,121 → 1,113 lines.
- `docs/store.md`'s layer-size NOTE re-measured after that trim.

### Tests added (2) — both were real gaps, not padding

- `timespan-semantic-key-identity.spec.ts` › **"gates each composite-PK probe against ITS
  OWN column when PK order differs from column order"**. Every pre-existing composite test
  declares the TIMESPAN column first, so PK position and column index coincide and nothing
  distinguishes the new `schema.columns[pkColumns[i]]` from a `schema.columns[i]` typo. The
  new table is `(id integer, d timespan, primary key (d, id))`, where the mis-pairing would
  test the duration probe against `id`'s type and the integer probe against TIMESPAN's,
  losing the seek. Pinned on plan shape as well as rows.
- `timespan-semantic-key-identity.spec.ts` › **"gates a PARAMETER-bound probe, which no
  literal folding ever sees"**. Every other point-arm probe in the suite is a literal,
  which the engine may fold or re-type before the module is asked. This binds `'PT60M'`,
  `5`, `'not a duration'`, and `null` as parameters — the raw-`SqlValue`-in-`filterInfo.args`
  shape the gate's "nothing coerces a query-supplied probe to the declared type" claim is
  actually about. All four match the memory oracle; the faithful one still seeks.

### Docs

Read every file the change touched and the ones it should have. `docs/types.md`
§ Semantic ordering and `docs/store.md`'s order-preservation bullet already state the three
per-arm degradations, the surrogate raise, and the remaining multi-seek decline accurately —
no correction needed there. The two stale statements were both **in source**, listed above.
`packages/quereus-store/README.md`'s remaining "semantic-ordering decline" is about IN-list
multi-seeks and reads correctly.

### Nothing filed

No new `fix/`, `plan/`, or `backlog/` tickets. Every finding was either resolvable inline
(the five above), already tracked (`feat-store-semantic-key-multiseek`), or a confirmed
non-issue. No new tripwires beyond the one the implementer recorded (whose magnitude claim
is now corrected in place).

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — all workspaces green, 0 failing: engine 8612 passing / 13 pending, store
  **1348** passing (1346 at handoff, +2 added here), isolation 376.
- `yarn test:store` (logic suite against LevelDB) — 8604 passing / 21 pending, 0 failing.
- `yarn docs:check` — fails only on `docs/schema.md`'s word-count ratchet, already listed in
  `tickets/.pre-existing-known.md` under `debt-doc-size-ratchet-red-at-head`. The three docs
  this ticket touched are under their ratchets. No `.pre-existing-error.md` written.

## How to exercise it

Everything is in `packages/quereus-store/test/`; a memory table is the oracle for every
row-set assertion. `yarn workspace @quereus/store run test`.

- **Headline behaviours** — `timespan-semantic-key-identity.spec.ts` and
  `json-semantic-key-order.spec.ts` § "primary key identity": re-spelled PK equality and
  reorder-equal JSON PK equality each seek (`INDEXSEEK` naming `primary`), and a
  TIMESPAN-led / JSON-led **secondary index** EQ seeks correctly.
- **Real narrowing, not scan-plus-filter** — `pushdown.spec.ts` § "window narrowing"
  against a `CountingKVStore`: 0 entries iterated, exactly 1 `get`, over a 60-row table.
- **Declines** — `pushdown.spec.ts` (`where d = 5` iterates all 3, issues 0 gets),
  `timespan-semantic-key-identity.spec.ts` (numeric / unparseable / parameter-bound probes,
  composite PK with one unfaithful member, rotated PK order),
  `any-json-pk-binary-key.spec.ts` (unfaithful interior column stops the prefix; position-0
  stop falls through; `collate nocase` on a `json` index keeps EQ declined).
- **Raise, don't decline** — `lone-surrogate-keys.spec.ts` § "a declared `json` primary
  key".
- **Writes and transactions** — re-spelled UPDATE/DELETE assert the full surviving row set;
  the isolated-store sections cover a staged row, a pending delete, and an overlay
  shadowing a differently-spelled committed key.
- **Multi-seek stays declined** — `any-json-pk-binary-key.spec.ts` and `pushdown.spec.ts`
  pin `where d in (…)`: no seek in the plan, correct rows, no malformed-FilterInfo raise.
