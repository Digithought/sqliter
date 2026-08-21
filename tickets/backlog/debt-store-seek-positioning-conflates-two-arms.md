----
description: The persistent storage layer uses a single number to describe how expensive a multi-value lookup is, but two different lookup paths with very different real costs both read that number, so on some storage backends no value can be correct for both.
files:
  - packages/quereus-store/src/common/cost-profile.ts               # the `seekPositioning` knob and its parity default
  - packages/quereus-store/src/common/store-module-access-plan.ts   # both arms that charge it: tryIndexAccessPlan's multi-seek, primaryKeyMultiSeekPlan
  - packages/quereus-store/src/common/store-table-scan.ts           # the two runtime shapes: scanMultiSeek vs scanMultiSeekPrimary
  - packages/quereus-plugin-leveldb/src/provider.ts                 # the backend that cannot declare a profile because of this
  - packages/quereus-plugin-leveldb/README.md                       # § Measured read cost — the evidence
  - packages/quereus-plugin-indexeddb/src/provider.ts               # the backend where the same bias was measured small and accepted
tradeoffs: Nothing returns a wrong answer today and the only backend this currently blocks (LevelDB) is fine on the parity default, so a maintainer may reasonably wait until a real LevelDB query is measured planning badly before growing the cost-profile surface.
----

# One cost number, two lookup paths

A storage backend can describe its own read costs to the query planner, relative to
reading one row sequentially during a full scan. One of those descriptions is
`seekPositioning`: what it costs to look up **one key** of a multi-key lookup — the shape
behind `where col in (a, b, c, …)`.

Two different access paths charge that same number:

| path | what it actually does at runtime | cost shape |
| --- | --- | --- |
| **secondary-index multi-seek** | opens one bounded iterator per distinct value, over the index store | pays a fixed per-iterator setup cost for every key |
| **primary-key multi-seek** | groups the keys into pages and fetches each page in one round trip | amortizes that setup across a whole page |

On a backend where opening an iterator is cheap relative to a batched fetch, the two are
close enough that one number describes both. On a backend where it is not, no single value
is right: setting it for the iterator path massively over-prices the batched path, and
setting it for the batched path leaves the iterator path far too cheap.

# The evidence

LevelDB was benchmarked on 2026-08-19 (full table, machine and caveats in
`packages/quereus-plugin-leveldb/README.md` § *Measured read cost*). Against a sequentially
scanned row = 1.0:

- one **batched** key — the shape the primary-key path runs — costs about **1.3 to 1.6**;
- one **single-key windowed** read — the shape the secondary-index path runs — costs about
  **15**.

Roughly an order of magnitude apart, and the framework's default for both is 0.5. The cause
is plain in the raw milliseconds: a batched read is ~3.2 µs per key while a one-key iterator
is tens of microseconds, nearly all of it fixed setup and teardown that batching amortizes
away.

Quoted as bands rather than decimals on purpose: re-running the same benchmark on the same
machine and commit moved three of the four ratios by 10-26%. The README records both runs.
Anyone sizing the new knob should re-measure across several runs rather than reading a digit
out of that table.

IndexedDB hit the same conflation earlier and it was accepted, because there the gap was
about 1.7× — small enough that over-charging the primary-key path only makes a very large
`where pk in (…)` prefer a table scan slightly sooner than it should. That acceptance is
recorded at the primary-key arm. LevelDB is where the gap stops being a rounding decision.

# Why it matters

The number does not merely inflate a displayed cost. It is what the engine's key-set-seek
rewrite reads at 2 keys and at 1 000 keys to fit a line and solve for the key count at
which a seek beats the plan it would replace. Move the number ten-fold and that break-even
moves about ten-fold — so the rewrite either fires on lists where a full scan would be
faster, or stops firing on lists where it would have won.

The immediate consequence is already visible: **LevelDB has been measured and still
declares nothing**, because either available value would be badly wrong for one of the two
paths. A measurement that cannot be acted on is the symptom this ticket names.

# What would settle it

Give each path a cost it can be honest about. The obvious shape is a second field
alongside `seekPositioning` — one term for a windowed per-key seek, one for a batched
per-key fetch — with the batched term defaulting to the existing point-read cost, which is
already the same operation. Any design that lets a provider state the two separately, and
lets a provider that only knows one of them fall back safely, resolves it.

Two things to preserve while doing it:

- Every field must stay optional with a parity default, so a backend that declares nothing
  plans exactly as it does today. That property is what makes the whole mechanism safe to
  extend.
- The framework deliberately has no per-row `entryRead` knob, for reasons recorded in
  `cost-profile.ts`. This is not a request to reopen that; the split here is between two
  *seek* shapes, not between row kinds.

Once it lands, LevelDB can declare its measured numbers, and
`debt-leveldb-cost-profile-measurement` reduces to writing them down.

## Cross-references

- `debt-leveldb-cost-profile-measurement` — the open decision this blocks.
- `feat-store-multiseek-coverage-gaps` — a different multi-seek concern (which column
  *types* the multi-seek refuses); unrelated to cost.
