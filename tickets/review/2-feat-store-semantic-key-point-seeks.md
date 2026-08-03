---
description: Looking up a single row by a duration or JSON key in a persistent table now jumps straight to the row instead of reading the whole table, and still finds it when the query spells the duration differently than the stored row. Needs a review pass.
files:
  - packages/quereus-store/src/common/store-table-scan.ts          # analyzePKAccess point arm, analyzeIndexAccess EQ prefix, multi-seek comments
  - packages/quereus-store/src/common/store-module-access-plan.ts  # comment-only: multi-seek decline rationale
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts
  - packages/quereus-store/test/json-semantic-key-order.spec.ts
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts
  - packages/quereus-store/test/pushdown.spec.ts
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts
  - docs/types.md   # § Semantic ordering
  - docs/store.md   # order-preservation bullet, layer-size NOTE
---

# Review: re-opened equality seeks over TIMESPAN and JSON key columns

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

Both were previously declined at the scan layer per **schema** — any semantic-ordering PK
member killed the point arm outright, and any such index column stopped the EQ prefix at
position 0. The plan side already claimed those filters handled, so the answer was right
but came from a full scan.

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
   `scanMultiSeekPrimary`, with its doc comment rewritten (it described the point-arm
   decline it no longer causes).

`store-module-access-plan.ts` needed **no behavioural change** — its full-PK-equality arm
and `tryIndexAccessPlan`'s equality arm never consulted `hasSemanticOrdering` on the plain
EQ path. Only the multi-seek decline's rationale comment was refreshed (it claimed a plain
EQ "degrades safely" by breaking the prefix, which is no longer what happens).

**One deliberate behaviour change:** an equality probe against a declared-`json` key whose
string leaf or object key carries an unpaired surrogate now **raises** the existing
`unpaired surrogate` error, where before it silently returned zero rows via the full scan.
This matches what text primary keys and (since the prereq ticket) JSON range bounds already
do: a probe with no faithful byte position is refused, never silently widened or narrowed.

**Still declined:** IN-list multi-seeks (`scanMultiSeek`, `scanMultiSeekPrimary`,
`tryIndexAccessPlan`'s `isMultiSeek` arm). Backlog `feat-store-semantic-key-multiseek`.

## How to exercise it

Everything below is in `packages/quereus-store/test/`; a memory table is the oracle for
every row-set assertion. `yarn workspace @quereus/store run test`.

**The headline behaviours** — `timespan-semantic-key-identity.spec.ts` §"primary key
identity" and `json-semantic-key-order.spec.ts` §"primary key identity":

- re-spelled PK equality finds the row, and `query_plan` shows an `INDEXSEEK` whose detail
  names `primary`;
- reorder-equal JSON PK equality likewise;
- a TIMESPAN-led / JSON-led **secondary index** EQ seeks and returns the right rows (this
  is the regression that fails outright without the threaded `indexKeyTransforms` the
  prereq ticket added — the window would address raw text and return nothing).

**Real narrowing, not scan-plus-filter** — `pushdown.spec.ts` §"window narrowing", against
a `CountingKVStore`: a `timespan` and a `json` PK equality each iterate **0** entries and
`get` exactly **1** key over a 60-row table.

**Declines (the probe gate)** — an unfaithful probe must not seek:

- `pushdown.spec.ts`: `where d = 5` on a `timespan` PK iterates all 3 entries and issues
  **0** gets — i.e. it really declined to a scan.
- `timespan-semantic-key-identity.spec.ts`: numeric and unparseable probes match memory;
  a **composite** PK with one unfaithful member declines the whole arm while its faithful
  counterpart still seeks.
- `any-json-pk-binary-key.spec.ts`: a composite index whose **interior** column's probe is
  unfaithful stops the prefix there (rows still correct); a prefix stopping at position 0
  falls through; `create index … (j collate nocase)` keeps EQ declined
  (`indexPrefixSeekIsCollationExact`).
- `json-semantic-key-order.spec.ts`: a blob EQ probe (literal and parameter-bound) matches
  memory and raises nothing.

**Raise, don't decline** — `lone-surrogate-keys.spec.ts` §"a declared `json` primary key":
EQ probes carrying an unpaired surrogate (in a string leaf, in an object key, and as a bare
TEXT probe) all reject, on the PK and on a secondary index.

**Writes and transactions** — the data-loss-shaped direction, since UPDATE/DELETE `WHERE`
clauses now route through the re-opened point arm:

- `timespan-semantic-key-identity.spec.ts`: the re-spelled UPDATE/DELETE test now asserts
  the full **surviving** row set on a 3-row table, not just the target's disappearance.
- isolated-store section: a point lookup finds a row staged earlier in the same
  transaction under a different spelling, stops finding one hidden by a pending delete,
  and returns the **overlay's** row when it shadows a differently-spelled committed key.
- `json-semantic-key-order.spec.ts` isolated section: the reorder-equal twin of that
  overlay-shadow case.

**Multi-seek stays declined** — `any-json-pk-binary-key.spec.ts` and `pushdown.spec.ts`
already pin `where d in (…)` on an indexed `timespan` column: no seek in the plan, correct
rows, no `Malformed multi-seek FilterInfo`. Unchanged by this ticket, re-run as regression.

## Known gaps — please probe these

1. **The EQ probe gate may be purely defensive.** I could not construct a shape where
   declining changes the ROW set. For an equality, a bogus window's rows are rejected by
   `matchesFilters` anyway, and *missing* a row would need a stored value `S` and probe `P`
   with `compare(S, P) == 0` but different key bytes — which none of the unfaithful shapes
   produce (a numeric TIMESPAN probe fails on storage class; an unparseable one falls back
   to BINARY text against canonical stored text; a bigint JSON probe ranks at the OBJECT
   rank while its bytes land at the NUMBER rank). So the counting-store visit counts are
   the *only* observable proof the gate fires. Worth an independent attempt to find a
   row-observable case — or a conclusion that it is invariant maintenance, which is how I
   have documented it.
2. **The blob/bigint JSON EQ probe never reaches the store.** The engine folds
   `where j = x'01'` to an `EMPTYRESULT` before asking the module, and routes a
   parameter-bound blob through `CAST(? AS JSON)`. So `jsonKeyEncodable`'s blob/bigint arm
   is exercised end-to-end only on the **range** path (existing test), not the equality
   path. Whether a raw blob or bigint can reach the EQ arm at all is unverified — if it
   cannot, that half of the gate is unreachable-by-construction and the tests I added are
   asserting engine folding, not store behaviour.
3. **`pushdown.spec.ts`'s `iterateEntryCount === 3` assertion is exact**, so it will break
   if the scan arm ever gains an early-terminating bound for a declined equality. That is
   deliberate (a range would make the count *smaller*, which is the direction that would
   silently mask a regression), but it is brittle in the other direction.
4. **No end-to-end isolation test for a semantic-ordering SECONDARY-index EQ window with
   staged rows.** The prereq ticket's review added the range twin plus a direct
   isolation-package test (`store-semantic-index-window-overlay`) whose equality arm the
   same fix covers; I did not add the store-level equality twin of it.
5. **Multi-seek might now be closer to sound than the comment claims.** With the
   transforms threaded, a well-formed IN list over one semantic-ordering column encodes
   each member correctly and the per-tuple residual re-checks; what genuinely breaks is an
   *unfaithful* member (its tuple's rows silently dropped, or `jsonStructuralKey` raising
   INTERNAL for a blob). That is the honest justification I wrote into the comments, and it
   suggests `feat-store-semantic-key-multiseek` may be mostly a probe-gate + raise-vs-drop
   decision rather than new machinery. Not acted on — out of this ticket's scope.

## Tripwires recorded (conditional — not tickets)

- A TIMESPAN point lookup now parses the probe duration **twice**: once in the gate
  (`groupKey`) and once in `encodeDataKey`'s transform. Once per query, not per row, so it
  is nothing today. Parked as a `NOTE:` at the gate in `analyzePKAccess`
  (`packages/quereus-store/src/common/store-table-scan.ts`).

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean (store package verified directly too).
- `yarn test` — all workspaces green, 0 failing: engine 8612 passing / 13 pending,
  store **1346** passing (was 1328 — +18 new), isolation 376.
- `yarn test:store` (logic suite against LevelDB) — 8604 passing / 21 pending, 0 failing.
  Ran in ~3 min, comfortably inside the idle-timeout window.
- `yarn docs:check` — fails only on `docs/schema.md`'s word-count ratchet, which is already
  listed in `tickets/.pre-existing-known.md` under `debt-doc-size-ratchet-red-at-head`. The
  two files this ticket edited (`docs/types.md`, `docs/store.md`) are under their ratchets.
  No `.pre-existing-error.md` written.

## Docs updated

- `docs/types.md` § Semantic ordering — rewritten to state that equality is now served
  from key bytes, with the three per-arm degradations (range bound dropped / point arm
  declined / index EQ prefix stopped short) spelled out, the surrogate raise noted, and
  multi-seek left as the one remaining decline.
- `docs/store.md` — the order-preservation bullet now describes the gate as applying to
  every seek *probe* with its per-arm degradation, not just to range *bounds*; the
  layer-size NOTE refreshed to the measured `store-table-scan.ts` 1,121 lines.
- Swept `packages/quereus-store/README.md` and the spec headers: the README's remaining
  "semantic-ordering decline" is about IN-list multi-seeks and is accurate as written;
  `any-json-pk-binary-key.spec.ts`'s header claimed equality seeks remained declined and
  has been rewritten.
