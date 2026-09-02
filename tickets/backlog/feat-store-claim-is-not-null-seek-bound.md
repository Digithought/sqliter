description: Finding the smallest or largest value in a column that allows blanks is still slow on storage backends where reading a row is expensive, because the "skip the blanks" test the engine adds cannot be handled by the storage layer. Reaches only columns explicitly declared to allow blanks, since this engine forbids them by default.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # seek-role vocabulary: EQ_OR_IN_OPS / LOWER_BOUND_OPS / UPPER_BOUND_OPS, claimFirstPerRole
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # buildIsNotNull — the filter that is added and never claimed
  - packages/quereus-store/test/plan-time-limit.spec.ts   # "declines the bound when a filter is left unclaimed" pins today's behaviour
tradeoffs: Only backends with expensive random row reads notice — on a cheap-read backend the boundary plan already wins — and teaching the seek arms a fifth operator shape touches the one function whose positional claiming contract is load-bearing for correctness.
----

# `min` / `max` over a nullable column never reaches the boundary read

## What a user sees

On a storage backend whose individual row reads are costly (IndexedDB was the reported
one, GitHub #31), this is fast:

```sql
create table t (id integer primary key, b integer not null, c integer not null);
create index ix_bc on t (b, c);
select min(c) from t where b = 1;     -- reads one row
```

and this — the same query, with `c` explicitly declared nullable — reads the whole table:

```sql
create table t (id integer primary key, b integer not null, c integer null);
```

**Correction to this ticket's original framing.** It was filed saying nullable is what a
column is unless you say otherwise, which would make the fast path the exception. That is
true of standard SQL and NOT true here: `default_column_nullability` defaults to
`'not_null'` (`core/database.ts`, and `createDefaultColumnSchema`'s `defaultNotNull = true`
— Third Manifesto). A column in this engine is NOT NULL unless it is declared `null` or
the session sets the pragma to `'nullable'`.

So the common case is the fast one, and this ticket covers the explicitly-nullable
minority. That lowers its priority rather than raising it — worth stating plainly, because
the original wording would have ranked it as a headline regression.

## Why

`min(c)` is answered by reading the first row of an index on `c` and stopping. Because
this engine sorts NULLs first in both directions, that first row could be a NULL — which
would make `min` answer NULL instead of the minimum. So when `c` is nullable the
optimizer adds a `c is not null` test underneath the ordered read (see `buildIsNotNull`).

The storage module can push equality (`=`, `IN`) and range (`<`, `<=`, `>`, `>=`)
comparisons into its index seeks. It has no notion of `IS NOT NULL`, so that test is left
over as an ordinary filter sitting above the scan.

A filter above the scan is what stops the whole thing: a scan may only be told "you can
stop after one row" when nothing above it can throw that row away, and a leftover filter
can. The engine therefore withholds the row bound, the module prices the ordered read for
the entire table, decides scanning-and-sorting is cheaper, and the one-row read is priced
out — exactly the symptom the original report described, for the nullable case only.

## Narrowed by measurement, 2026-09-02 — the engine side is already done

Probed directly rather than reasoned about, at `pointRead = 3.0` and at parity, over
`select max(date) from entry where entity_id = 1` with a `(entity_id, date desc)` index:

| `date` declared | backend | boundary read? |
|---|---|---|
| `not null` | `pointRead = 3.0` | **yes** |
| `not null` | parity | yes |
| `null` | `pointRead = 3.0` | no |
| `null` | **parity** | **yes** |

The nullable case working at parity is the finding. It means **the ordering claim is
already granted for a nullable column** — `IS NOT NULL` is in `NULL_EXCLUDING_OPS`
(`vtab/best-access-plan.ts`), so `nullSafeOrderingPrefixLength` does not truncate the DESC
claim when the rewrite's own `is not null` filter is in `request.filters`. Nothing on the
engine side is missing.

The only thing separating the two rows is **price**: the filter is unclaimed, so
`truncationIsSafe` withholds the bound, the arm is costed for every matching row, and the
seek-vs-scan veto drops it — at parity it survives the veto anyway, which is exactly why
this is invisible without a cost profile.

So the whole ticket reduces to `claimFirstPerRole` claiming `IS NOT NULL`.

### The part that is not a one-liner

Claiming a filter asserts the scan will not emit rows violating it, and that is
**direction-dependent** — which the original "NULLs are a contiguous run at the front, so
it is a lower bound" framing gets right for only one of the two walks:

- **ASC walk**: NULLs are emitted FIRST. Claiming `IS NOT NULL` requires genuinely seeking
  past the NULL run — a real lower bound the key encoder has to express as "just above the
  NULL tag". This is the case `min()` needs.
- **DESC walk**: the store bit-inverts the key bytes, so NULLs land LAST. A bounded read
  never reaches them, but an unbounded walk does — so claiming the filter outright would be
  wrong for a full walk while being harmless under a limit. This is the case `max()` needs,
  and it is the one the measurement above exercises.

Do not add `'IS NOT NULL'` to a shared ops list and stop there. The claim has to be
conditioned on the walk direction, and on the ASC side it needs the seek bound to actually
exist.

## What is wanted

The storage module should be able to serve `IS NOT NULL` on a seek column. On an
ascending index the NULLs are a contiguous run at the front, so "skip the NULLs" is a
lower bound the seek machinery can already express — the missing piece is the vocabulary,
not the mechanism. Claiming it makes the filter disappear from above the scan, which in
turn lets the engine hand the module the row bound, which is what makes the boundary read
win on an expensive-read backend.

Expected outcome:

- `select min(c) from t where b = 1` over a nullable `c` produces the same plan shape it
  produces over a non-nullable `c` — an ordered index access with a LIMIT above it — and
  the same answer it produces today.
- `select max(c) from t where b = 1` likewise, over a descending index.
- Answers must not change in any case. A NULL-skipping bound that is off by one row would
  turn `min` into "the second-smallest value", so the acceptance bar is answer-equality
  against the current plan across nullable, all-null, and no-null columns.

`packages/quereus-store/test/plan-time-limit.spec.ts` carries a case named
`declines the bound when a filter is left unclaimed (nullable min column)` that pins the
current (slow, correct) behaviour. It is the canary: when this lands, that case should be
rewritten to expect the fast plan rather than deleted.

## Scope note

This is about the storage module's seek vocabulary. `IS NOT NULL` is already extracted as
a constraint by the engine and already handed to the module — nothing on the engine side
needs to change for the module to start claiming it. A separate backlog ticket,
`4-is-bool-predicate-constraint-pushdown`, covers the unrelated `IS TRUE` / `IS FALSE`
shapes, which are not extracted as constraints at all.
