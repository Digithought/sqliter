---
description: The persistent store now answers sorting and range-filter queries over duration and JSON key columns straight from its stored key bytes instead of reading the whole table and re-sorting. Reviewed, and one wrong-result bug found and fixed in the transaction layer.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts
  - packages/quereus-store/src/common/json-key.ts
  - packages/quereus-store/src/common/store-table-scan.ts
  - packages/quereus-store/src/common/key-builder.ts
  - packages/quereus-isolation/src/isolated-table.ts        # REVIEW FIX — constraintComparator
  - packages/quereus-isolation/test/isolation-layer.spec.ts # REVIEW — 2 regression tests
  - packages/quereus-store/test/semantic-key-predicates.spec.ts
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # REVIEW — +1 test
  - packages/quereus-store/test/json-semantic-key-order.spec.ts
  - packages/quereus-store/test/collation-order-preserving.spec.ts
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts
  - packages/quereus-store/test/pushdown.spec.ts            # REVIEW — +1 test
  - docs/types.md
  - docs/store.md                                           # REVIEW — layer-size NOTE refreshed
  - docs/design-isolation-layer.md                          # REVIEW — window-matcher rule
---

# Complete: re-opened ordering advertisements and range windows over TIMESPAN / JSON key columns

## What shipped

A store-backed table whose primary key (or leading secondary-index column) is declared
`timespan` or `json` now:

- **advertises its stored order**, so `order by <that column>` runs with no Sort; and
- **serves a range predicate (`>`, `>=`, `<`, `<=`) as a byte-window seek** instead of
  reading every row and re-filtering.

Both were previously declined outright. They are sound because the store already writes
those columns' key bytes through an order-preserving transform (a duration's total
seconds; JSON's structural byte form), so raw byte order *is* the order the engine's
`ORDER BY` and comparison operators use.

Two gates keep it honest, both in `packages/quereus-store/src/common/pk-key-resolution.ts`:

- `semanticKeyOrderIsFaithful(type)` — an explicit per-type allow-list (TIMESPAN, JSON),
  deliberately not inferred from "a transform exists". Any other such type keeps the old
  blanket decline.
- `semanticProbeIsKeyFaithful(type, probe)` — a per-VALUE gate on each seek bound, since
  nothing coerces a query's bound to the column's declared type. A bound with no faithful
  byte position (a numeric or unparseable duration bound; a blob or bigint JSON bound) is
  **dropped**, which only widens the window; the type-aware residual still decides rows.

Left declined on purpose: equality-shaped seeks over such columns (ticket
`feat-store-semantic-key-point-seeks`, in `implement/`) and IN-list multi-seeks (backlog
`feat-store-semantic-key-multiseek`) — neither has a widen-instead-of-decline escape.

One deliberate behaviour change: a range bound on a declared-`json` primary key whose
string carries an unpaired surrogate now raises instead of full-scanning, matching the
rule text primary keys already carry.

## Review findings

### Major — found and fixed in this pass

**Wrong rows from a transaction's own uncommitted writes, when the query used a
duration/JSON secondary index range.** (`packages/quereus-isolation/src/isolated-table.ts`)

The transaction isolation layer merges a transaction's staged rows into the committed
stream, and re-applies the query's window to those staged rows itself — because the
storage module already claimed the filter *handled*, nothing downstream re-checks them.
That re-application compared with plain text ordering, ignoring the declared type. On a
duration column that inverts in **both** directions: `'PT1M'` (1 minute) sorts *above*
`'PT1H'` textually, and `'PT180M'` (3 hours) sorts *below* it. So inside a transaction,
`where d > 'PT1H'` leaked a staged 1-minute row in and dropped a staged 3-hour row.

- Reproduced end-to-end (isolated store module, timespan secondary index, staged inserts):
  expected ids `[2,3,5]`, got `[2,3,4,5]`.
- Newly reachable because of this ticket — before it, such a range was declined at plan
  time, so the engine kept its own `Filter` above the scan and caught it.
- The **equality** arm of the same matcher was already wrong before this ticket, and is
  fixed by the same change: `where d = 'PT60M'` dropped a staged row spelled `'PT1H'`
  (reproduced: expected `[2]`, got `[]`). Same code site, so one fix, not a second ticket.
- Fix: `constraintCollation` became `constraintComparator`, which returns the declared
  type's `compare` for a semantic-ordering column and storage-class + collation otherwise
  — mirroring what the storage module applies to its own committed rows, and the idiom
  `buildDescriptorComparators` a few lines away already used. Both matchers
  (single-window and multi-range) now go through it.
- Pinned by two new tests in `packages/quereus-isolation/test/isolation-layer.spec.ts`
  (`store-semantic-index-window-overlay`: the range inversion in both directions, and the
  re-spelled equality row), plus the end-to-end store test below.

### Checked and sound — no change needed

- **Byte order vs comparator order, per type.** Verified `jsonStructuralKey`'s tag order
  (null < boolean < number < string < array < object) reproduces both the JSON deep
  comparator's rank order *and*, for values of different storage classes where the shared
  comparator short-circuits before ever reaching the JSON compare, the engine's
  NULL < NUMERIC < TEXT < BLOB < OBJECT class order. Every cross-kind pair agrees. For
  durations, the stored total-seconds numbers memcmp in elapsed-time order by
  construction.
- **Dropping a bound really is safe.** Traced the engine's own `>` semantics for the two
  dropped-bound shapes (`d > 5`, `d > 'not a duration'`) through the operator emitter: its
  runtime duration check declines a non-duration operand and falls back to the same
  storage-class + collation compare the store's residual uses. So the residual reproduces
  the predicate exactly — the widened window costs speed, never a row.
- **Descending key columns over variable-length bytes.** The prefix hazard (does `[2]`
  correctly sort *after* `[2,0]` when bytes are bit-inverted for DESC?) is closed by the
  encoder's escape scheme: content bytes are never `0x00`, so the terminator inverts to
  `0xff` and outranks every inverted content byte. Confirmed against `encoding.ts` and the
  implementer's DESC-json test.
- **Every stored duration parses.** Read all three write paths (insert, update, and the
  ALTER retype backfill) — each runs through the type's parser, which raises on anything
  unparseable. The claim the allow-list rests on holds.
- **The transform memo (`indexKeyTransforms`) invalidates on ALTER.** Keyed on the columns
  array identity, same rule as its collation twin; the implementer's ALTER test drives it.
- **Index-scan merge comparator** already used the declared type's compare
  (`getIndexComparator`) — that half was correct before this ticket.
- **Plan side vs scan side.** The two decline in lockstep through the same shared
  predicates; where the scan declines a window the plan still claimed (the equality arms),
  the store's own residual is always applied, so the fallback is a slower scan, not wrong
  rows.

### Test gaps the handoff flagged — both now filled

- *"No plan-level narrowing assertion for a JSON primary-key range."* Added to
  `pushdown.spec.ts`: 60 JSON-number rows, `where j > json('57')` must visit ≤ 3 stored
  entries and return exactly the two matching rows.
- *"No test drives a transaction merge off a range-seeked duration secondary index."*
  Added to `timespan-semantic-key-identity.spec.ts`: staged inserts, an update that moves
  a row **into** the window, and a delete that removes one from it, all inside one
  transaction. This is the test that first exposed the isolation-layer bug above.

### Tripwires recorded (conditional — not tickets)

- The isolation layer's window matcher now restates, in a second package, the same
  "semantic-ordering type ⇒ the type's compare, else collation" rule the storage module
  applies to committed rows. Two dimensions keep the duplication cheap; a third should be
  promoted to one shared engine helper instead. Parked as a `NOTE:` on
  `constraintComparator` (`packages/quereus-isolation/src/isolated-table.ts`).

### Source hygiene

- `store-table-scan.ts` is now 1,085 lines and `store-table-base.ts` 1,033 (`wc -l`), both
  past the ~1,000-line seam `docs/store.md` records — that NOTE still claimed "near 900"
  and has been refreshed with the measured counts, a pointer to backlog
  `debt-split-store-table-scan-and-base`, and the rule to keep new scan-side logic in a
  collaborator file meanwhile. No new ticket: the split is already filed.
- Naming, comment density, and function size in the new code match the surrounding file.
  The new predicates are small and single-purpose; the JSON encodability check sits beside
  the encoder whose node kinds it mirrors.

### Docs

Read every file the change touched plus the ones it should have. `docs/types.md` and
`docs/store.md` were correctly rewritten by the implementer. Two were stale and are now
fixed: `docs/store.md`'s layer-size NOTE (above) and `docs/design-isolation-layer.md`'s
index-scan-merge section, which described the overlay window matcher without stating the
comparison rule the fix above makes load-bearing. `packages/quereus-store/README.md`'s
one remaining "semantic-ordering decline" reference is about IN-list multi-seeks, which
are still declined — accurate as written.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — all workspaces green, 0 failing (engine 8612 passing / 13 pending; store
  1328 passing; isolation 376 passing).
- `yarn test:store` (logic suite against the LevelDB-backed store) — 8604 passing /
  21 pending, 0 failing.
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.
