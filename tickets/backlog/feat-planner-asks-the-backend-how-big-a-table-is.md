description: The query planner only learns how many rows a table holds if someone has run the `analyze` maintenance command, even when the storage backend already tracks that number and can report it instantly — so plans on a freshly created database are costed against a made-up default.
files:
  - packages/quereus/src/planner/stats/table-cardinality.ts          # catalogRowCount — the shared "how big is this table" seam
  - packages/quereus/src/planner/stats/catalog-stats.ts              # CatalogStatsProvider.tableRows and its fallback
  - packages/quereus/src/planner/stats/index.ts                      # StatsProvider interface, NaiveStatsProvider default
  - packages/quereus/src/vtab/table.ts                               # the VirtualTable.getStatistics contract
  - packages/quereus/src/runtime/emit/analyze.ts                     # collectTableStatistics — today's only caller
  - packages/quereus-store/src/common/store-table-base.ts            # getKnownRowCount, getStatistics, primeStats
  - docs/module-authoring.md
  - docs/optimizer.md
tradeoffs: The planner would call into a storage backend during planning, which today is a pure catalog-and-rules phase — that adds an I/O-shaped dependency to a hot path, makes plan choice depend on live data (so two identical statements can plan differently), and only pays off for backends that maintain a running count, which the built-in in-memory backend does not.
----

# The planner never asks a table how big it is

## What happens today

The query planner decides how to execute a statement — which join algorithm, which index,
whether to keep intermediate results in memory — largely from how many rows it thinks each
table holds. It gets that number from one place: statistics saved by the `analyze`
maintenance command. If nobody has run `analyze`, the planner substitutes a fixed default
(1000 rows) and plans as if every table were that size.

Meanwhile the persistent storage backend (`quereus-store`, which backs the LevelDB,
IndexedDB and React Native plugins) already maintains a running row count for every table.
It updates it on every write, persists it, and reloads it when storage is opened. It uses
that count for its own internal sizing decisions. The planner never asks for it.

There is even a contract for asking — `VirtualTable.getStatistics` — and the store
implements it, returning its size in constant time with no scan. The only code that calls
it is the `analyze` command itself.

## Why it matters

Measured on the store backend, two tables of 10,000 and 20,000 rows joined with one
selective filter, returning a single row — the only variable being whether `analyze` had
been run:

| | plan chosen | time |
|---|---|---|
| no `analyze` | hash join over a full scan of the 10,000-row table | 47.3 ms |
| after `analyze` | correlated seek on the primary key | 17.8 ms |

A second measurement, 20,000 rows with a range filter matching 55% of them, showed the same
pattern in the access path: without statistics the planner chose to seek 11,000 scattered
rows (96.7 ms) where one batched scan would have done (43.8 ms).

Both plans were correct — this is a speed problem, not a wrong-answer problem. But the
information needed to choose better was sitting in the backend the whole time, and a user
on a freshly created database has no reason to know they were supposed to run a maintenance
command first.

## What "done" would look like

The planner, when it needs a table's size and has no `analyze` statistics, asks the table
itself; a backend that can answer cheaply does, and one that cannot declines and the
existing default applies. Nothing about the `analyze` path changes — a real `analyze`
result, which also carries per-column distributions, still wins over a bare size.

Open questions a design pass has to settle:

- **Where the call goes.** `catalogRowCount` is the shared seam every caller already funnels
  through, but it is synchronous and takes only a schema object; `getStatistics` needs a
  live table instance and may be asynchronous. That mismatch is the substance of the work.
- **Whether plan choice may depend on live data.** Today two identical statements plan
  identically. Consulting a live count means a statement can plan differently before and
  after a write — including partway through a transaction. That is desirable for
  correctness of costing and awkward for reproducibility, prepared-statement caching, and
  the golden-plan tests. Someone has to decide which property wins.
- **Cost of asking.** The store answers in constant time from memory, but the contract does
  not promise that for every backend. A "cheap or decline" signal may be needed.

## Related work already on the board

- `unknown-row-count-stops-pretending-to-be-zero` (implement) removes the fake zero every
  table currently carries, so "nobody knows" finally reports as unknown — the precondition
  for anyone asking a better question.
- `ask-the-backend-before-guessing-its-size` (implement) stops the planner filling in 1000
  before it asks a backend for an *access plan*, which lets the store size its own access
  paths. This ticket is the remaining half: the planner's **own** cost model — join
  algorithm choice, cache sizing — still reads only the catalog.
