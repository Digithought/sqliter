# Window Function Implementation in Quereus

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

This document describes the architecture and implementation of SQL window functions in Quereus's Titan runtime system.

## Overview

Window functions perform calculations across a set of table rows related to the current row without collapsing them into a single result (unlike aggregate functions in GROUP BY). Quereus provides comprehensive window function support with a modern, extensible architecture that follows the Titan principles of immutable PlanNodes and instruction-based runtime execution.

**Supported window functions:**
- **Ranking Functions**: `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `NTILE()`, `PERCENT_RANK()`, `CUME_DIST()`
- **Navigation Functions**: `LAG()`, `LEAD()`, `FIRST_VALUE()`, `LAST_VALUE()`
- **Aggregate Functions**: `COUNT()`, `SUM()`, `AVG()`, `MIN()`, `MAX()` with OVER clause

## Architecture Components

### Parser Layer (`src/parser/parser.ts`)

The parser handles full SQL standard window function syntax:

```sql
window_function([arguments]) OVER (
  [PARTITION BY partition_expression [, ...]]
  [ORDER BY sort_expression [ASC | DESC] [NULLS FIRST | LAST] [, ...]]
  [frame_clause]
)
```

**Key Features:**
- Parses `PARTITION BY` and `ORDER BY` clauses
- Supports `NULLS FIRST/LAST` in ORDER BY
- Handles frame specifications: `ROWS BETWEEN ... AND ...`
- Creates `WindowFunctionExpr` AST nodes

### Planner Layer

**WindowNode (`src/planner/nodes/window-node.ts`):**
- Carries one window specification and the functions computed over it
- Converts AST expressions to `ScalarPlanNode` objects for proper attribute resolution
- Maintains separate collections for partition expressions, ORDER BY expressions, and function arguments

**Query Building (`src/planner/building/select-window.ts`):**
- Identifies window functions in SELECT lists (via `analyzeSelectColumns`)
- Emits one `WindowNode` per window specification group, then ONE projection above them all
- That projection is the query's select list — stars already expanded, in written order —
  rewritten so each window-function subtree becomes an `ArrayIndexNode` pointing at its
  computed window-output column. Everything else passes through untouched, so `select *,
  row_number() over (…)` keeps the star's columns and an unaliased window column is named
  after the expression the user wrote.

**Grouped queries.** A window function in a grouped select list runs over the
**grouped rows** — the plan is `Aggregate → [HAVING Filter] → Window → Project`, so
`row_number() over (order by a) … group by a` numbers the groups. The window
specification and the function's arguments are therefore subject to the same GROUP BY
restriction as the rest of the select list.

Those expressions are built against a scope that falls through to the *pre-aggregate*
select scope, so a grouping key spelled any way other than the one the aggregate output
scope registered (`wg.a` against `group by a`, or a non-bare key written out again)
binds to a base-table column the grouped row does not carry. Two passes fix and police
this, shared with every other post-aggregate clause of a grouped query:

1. the window phase passes each built specification and argument through
   `redirectPostAggregate` (`select-aggregates.ts`, the one entry point every
   post-aggregate expression uses), which rewrites every subtree that *is* a grouping
   key onto the AggregateNode's own output column for that key, matching either by
   identity fingerprint or, for a bare-column key, by base attribute id (so any
   qualifier spelling works);
2. `assertGroupedPlanCoverage` then walks the grouped query's **finished plan** (from
   the end of `buildSelectStmt`, stopping at the AggregateNode) and rejects anything
   still naming a pre-grouping column, with the same plan-time message a select-list
   entry gets.

Both passes descend through **relational** children too, because a window specification
may contain a subquery that correlates back to the grouping key (`over (order by (select
max(t.b) from wg t where t.a = wg.a))`). Inside such a subquery live two unrelated kinds
of column reference — the subquery's own columns, and correlated references pointing back
out — so both passes key off `aggregateInputAttrIds`: every attribute id produced in the
AggregateNode's *input* subtree, i.e. exactly the columns this query could read before it
grouped. Attribute ids are minted per relation instance, so a subquery's own `wg t` scan
and the outer `wg` scan never share one, and membership separates the two cases exactly:

- in the redirect, the base-attribute-id rule needs no guard at any depth (only a genuine
  reference to this query's grouping column can match). The *fingerprint* rule is
  unconditional above any subquery, where the expression is written in this query's own
  scope — that is what lets a whole correlated subquery be the grouping key and be named
  again in the specification. Inside a subquery it is guarded on "every column reference
  in this subtree is a pre-grouping column of this query", because there the same text can
  name something else: a bare `a` written inside the subquery names the subquery's own
  `t.a` and would otherwise be silently rewritten onto the outer group column;
- in the coverage check, only a pre-grouping attribute id that is absent from the
  aggregate's output is rejected. A reference to anything else — the subquery's own
  columns, or a correlated reference to an **enclosing** query — is legal here and passes
  through. That is what lets a grouped subquery's window specification correlate outward
  (`select … (select count(*) from (select row_number() over (order by i.b, o.a) … from wg
  i where i.a = o.a group by i.b) z) … from wg o group by o.a`).

The coverage check exempts an **aggregate**'s arguments from the GROUP BY restriction —
they read pre-grouping columns by definition — but only for this query's own aggregates,
which sit at the top level of the specification. An aggregate reached through a subquery
belongs to that subquery, so its arguments are checked like anything else: `over (order by
(select max(wg.b) from wg t))` reads an ungrouped column of the grouped query and is
rejected at plan time.

The one subtree both passes stop at is a **CTE definition**. A `with` clause builds it
once and every reference points at that same node, so when the grouped query and a
subquery in its window specification read the same CTE, the body is reachable from both.
A CTE body is a closed scope — it cannot name a column of the query referencing it — so
its internal attribute ids are excluded from `aggregateInputAttrIds` and neither pass
descends into it. Without that, `with c as (select a, b from wg where b <> '') select a,
row_number() over (order by (select count(*) from c z)) from c group by a` was rejected
with "Column 'b' must appear in the GROUP BY clause", naming a column that appears only
inside the CTE.

An aggregate inside a window specification of a grouped query must be one the select
list already computes — the window runs *above* the aggregation, so there is nothing
left to aggregate. Matching uses the same structural rule as HAVING (see
[SELECT § 3.4](sql-select.md#34-having-clause)): identifier case is folded, literals
and qualifiers compare exactly. A spelling that does not match any select-list
aggregate is rejected at plan time — `Aggregate function <name> in a window function's
<PARTITION BY | ORDER BY | arguments> is only supported when the same aggregate also
appears in the SELECT list` — rather than silently binding to a different aggregate.

### Runtime Layer (`src/runtime/emit/window.ts`)

Complete implementation following Titan architecture principles:

**Key Features:**
- **Attribute-based context resolution** - No hard-coded column mappings
- **Proper expression evaluation** - Uses callbacks for all expressions
- **Frame-aware execution** - Implements correct windowing semantics
- **SQL-compliant sorting** - Uses `compareSqlValues` for proper NULL handling
- **Collation-aware partitioning** - PARTITION BY and ranking keys use shared key serialization (`util/key-serializer.ts`) with per-column collation normalizers resolved against the connection's collation registry via `EmissionContext.resolveKeyNormalizer()` (e.g., NOCASE → case-insensitive grouping; a custom `registerCollation` normalizer is honored too)

**Execution Model:**
1. **Materialization**: Collects all input rows (required for window functions)
2. **Partitioning**: Groups rows by PARTITION BY expressions
3. **Sorting**: Orders rows within partitions by ORDER BY expressions
4. **Frame Processing**: Calculates window frames and computes function values
5. **Output**: Returns original rows augmented with window function results

## Frame Specification Support

The implementation correctly handles all SQL standard frame types:

```sql
{ROWS | RANGE} {
    UNBOUNDED PRECEDING |
    CURRENT ROW |
    <value> PRECEDING |
    <value> FOLLOWING |
    BETWEEN <start_bound> AND <end_bound>
}
```

**Default Frame Behavior:**
- **No ORDER BY**: Frame includes entire partition
- **With ORDER BY**: Frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`

**RANGE vs ROWS:**
- **ROWS**: Frame bounds are physical row offsets from the current row
- **RANGE**: Frame bounds are value-based offsets on the first ORDER BY expression. `CURRENT ROW` includes all peer rows (rows with the same ORDER BY values)

## Usage Examples

### Basic Window Functions

```sql
-- Row numbering
SELECT name, ROW_NUMBER() OVER (ORDER BY salary DESC) as rank
FROM employees;

-- Partitioned ranking
SELECT name, department,
       RANK() OVER (PARTITION BY department ORDER BY salary DESC) as dept_rank
FROM employees;
```

### Frame Specifications

```sql
-- Running totals
SELECT date, amount,
       SUM(amount) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) as running_total
FROM transactions;

-- Moving averages
SELECT date, value,
       AVG(value) OVER (ORDER BY date ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) as moving_avg
FROM measurements;

-- RANGE frame: value-based window (include all rows within 10 of current value)
SELECT date, price,
       SUM(price) OVER (ORDER BY price RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) as nearby_sum
FROM products;
```

Frame offsets must be non-negative **integer** literals, in `RANGE` as well as
`ROWS`; anything else (a fraction, a parameter, an expression) raises
`Invalid window frame offset`.

In `RANGE` mode, a row whose ORDER BY value is NULL has no position on the
numeric line, so its frame is its peer group — every other NULL-keyed row, and
nothing else. Symmetrically, NULL-keyed rows never fall inside a non-NULL row's
`[v - n, v + m]` interval, not even one that spans zero.

### Navigation Functions

```sql
-- Access previous/next row values
SELECT date, amount,
       LAG(amount) OVER (ORDER BY date) as prev_amount,
       LEAD(amount) OVER (ORDER BY date) as next_amount
FROM transactions;

-- With offset and default value
SELECT date, amount,
       LAG(amount, 2, 0) OVER (ORDER BY date) as two_back
FROM transactions;

-- First and last values in frame
SELECT date, amount,
       FIRST_VALUE(amount) OVER (PARTITION BY month ORDER BY date) as first_in_month,
       LAST_VALUE(amount) OVER (PARTITION BY month ORDER BY date
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_in_month
FROM transactions;
```

### Statistical Ranking

```sql
-- Percentile ranking and cumulative distribution
SELECT name, score,
       PERCENT_RANK() OVER (ORDER BY score) as pct_rank,
       CUME_DIST() OVER (ORDER BY score) as cume_dist,
       NTILE(4) OVER (ORDER BY score) as quartile
FROM test_results;
```

### NULL Handling

```sql
-- Explicit NULL ordering
SELECT name, score,
       RANK() OVER (ORDER BY score DESC NULLS LAST) as rank
FROM test_results;
```

## Performance Optimizations

### Window Specification Grouping (not currently effective)

`groupWindowFunctionsBySpec` is *meant* to put window functions with identical
specifications under one `WindowNode` — a single sort pass and shared partition
processing per unique specification. It does not do so today: the grouping key is
`JSON.stringify` over raw AST fragments, which carry each fragment's source-location
data, so two textually identical `over (…)` clauses never key equal and every window
function gets its own node. Fixing that also requires teaching `findWindowColumnIndex`
to match a function to its output column by identity or position rather than by
name + specification; see the `NOTE:` comments in `select-window.ts`.

### Efficient Execution

- **O(n) ranking pre-computation**: After sorting each partition, a single linear pass (`precomputeRankings`) detects peer group boundaries and computes RANK, DENSE_RANK, PERCENT_RANK, and CUME_DIST for all rows at once. Per-row ranking lookups are then O(1).
- **Pre-evaluated ORDER BY values**: Sort keys are evaluated once and cached in `orderByValues`, reused for sorting, peer detection, and frame bounds — no re-evaluation of expressions.
- **Partitioned functions**: Buffer only current partition
- **Frame-bounded aggregates**: Process only necessary frame data

### Streaming fast path over `MonotonicOn`

When the source already arrives in `[PARTITION BY..., ORDER BY[0]]` order — its
`physical.monotonicOn` covers the leading ORDER BY key and `physical.ordering`
shows the partition keys as an emit-order prefix — `rule-monotonic-window` tags
the `WindowNode` with a `streaming` config and the runtime switches from the
buffer/sort path to a one-pass emitter (`runStreaming` in `runtime/emit/window.ts`).

The streaming emitter:

- Walks the source in source order, emitting in source order.
- Maintains `O(P)` per-partition state where `P` is the open partition (only one
  partition is alive at a time since input is partition-sorted), with sub-state
  per function: ranking counters, LAG ring buffers, LEAD read-ahead queues,
  FIRST_VALUE caches, and running-aggregate accumulators with peer-group
  buffering for RANGE-mode frames.
- Skips the sort entirely — `O(N log N)` per partition saved.
- Skips materialization — `O(N)` memory saved.
- Preserves the source's `monotonicOn` on the `WindowNode`'s output so
  downstream rules (`monotonic-limit-pushdown`, `monotonic-merge-join`,
  `monotonic-range-access`) compose cleanly above streaming windows.

**Recognized functions** (the rule fires only when *all* functions in a single
WindowNode are individually recognized):

| Function class | Recognized | Notes |
| --- | --- | --- |
| `ROW_NUMBER`, `RANK`, `DENSE_RANK` | yes | per-partition counter + last-key |
| `LAG`, `LEAD` | yes | offset must be a non-negative integer literal |
| `FIRST_VALUE`, `LAST_VALUE` | yes | LAST_VALUE only under default frame; both also stream under sliding frames (see below) |
| Running `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` | yes | default frame (`UNBOUNDED PRECEDING TO CURRENT ROW`, ROWS or RANGE) |
| Sliding `SUM`, `COUNT`, `AVG`, `MIN`, `MAX`, `FIRST_VALUE`, `LAST_VALUE` | yes | `ROWS BETWEEN n PRECEDING AND m FOLLOWING`, or `RANGE BETWEEN n PRECEDING AND m FOLLOWING` over a single numeric ORDER BY key. `n` and `m` must be non-negative **integer** literals in both modes — that is the whole set of offsets Quereus accepts anywhere (a fractional RANGE offset raises `Invalid window frame offset`) |
| One-sided sliding (`n PRECEDING AND CURRENT ROW`, `CURRENT ROW AND m FOLLOWING`, `CURRENT ROW AND CURRENT ROW`) | yes | `CURRENT ROW` is the offset-zero case of the bound it replaces, so these run the same sliding state machine. The start-only spellings (`ROWS n PRECEDING`, `RANGE n PRECEDING`, `ROWS CURRENT ROW`) mean `... AND CURRENT ROW` and stream too |
| `NTILE`, `PERCENT_RANK`, `CUME_DIST` | no | need partition size up-front |
| Unbounded-on-one-side sliding (`UNBOUNDED PRECEDING AND m FOLLOWING`, `n PRECEDING AND UNBOUNDED FOLLOWING`) | no | future work — no bounded buffer |
| `DISTINCT` aggregates | no | future work |

**Bail conditions** (any one drops to the buffered path):

- The leading ORDER BY key is not a trivial column reference, or doesn't match
  source's `monotonicOn` direction.
- Source's `physical.ordering` doesn't cover the full ORDER BY key set.
- PARTITION BY columns aren't an emit-order prefix of the source ordering. In
  practice this rules out *every* partitioned window today: a table access
  advertises `monotonicOn` for its leading unbound index column only, so on an
  index `(g, k)` the advertisement names `g` and the leading-ORDER-BY-key check
  fails for `partition by g order by k`. Widening that advertisement is what
  would unlock partitioned streaming windows.
- Any partition-by expression is non-trivial (not a column reference).
- Any function falls outside the recognized set.
- Frame is anything other than the default (or the explicit equivalent
  `UNBOUNDED PRECEDING TO CURRENT ROW`), or a supported sliding shape (see
  the table above). Note that `UNBOUNDED PRECEDING AND CURRENT ROW` keeps
  routing to the cheaper running-accumulator path, not to the sliding buffer.
- Frame carries an exclusion other than `NO OTHERS` (not currently parseable
  either — see *Future Enhancements*).
- For RANGE-mode sliding frames: more than one ORDER BY key, or a single key
  whose logical type is not numeric. A numeric RANGE offset is arithmetic on
  the ORDER BY value, which the SQL standard only defines for one sort key of a
  type arithmetic applies to. The buffered walk falls back to peer-group
  scanning for a non-numeric key and the streaming scan does not, so the rule
  leaves that case buffered rather than answer differently.
- A frame offset that is not a non-negative *integer* literal. The buffered
  frame walk raises `Invalid window frame offset` for those, so recognizing a
  wider set here would make the query's success depend on the chosen plan.

**Both paths must return the same rows.** A shape the rule recognizes runs a
different piece of code from the same shape with the rule disabled, so any
divergence is a bug in one of them, not a licensed difference. Two rules of
thumb keep them aligned: never recognize an offset the buffered walk rejects
(above), and treat a NULL ORDER BY key as *outside* every finite interval —
`NULL` is not zero, on either path. `test/plan/window-one-sided-frames.spec.ts`
runs every case on both shapes and deep-compares.

### Sliding-frame state machine

Under a sliding frame, `runStreaming` keeps a per-function `slidingBuffer` of
`{argVal, orderByVal0}` for rows currently in scope plus a list of pending
entries awaiting finalization. Each pending entry's slot is filled as soon as
its right edge has been seen. `rule-monotonic-window` normalizes every
recognized frame to a `(preceding, following)` offset pair before it gets here,
so a one-sided frame is simply that pair with a zero on one side — the state
machine below has no separate case for it.

- **ROWS** — entries finalize when row `j + following` arrives. SUM/COUNT/AVG
  maintain a `{ sum, count }` accumulator with step+unstep (skipping NULL
  argVals); MIN/MAX/FIRST_VALUE/LAST_VALUE recompute from the live buffer
  slice — MIN/MAX by folding the slice through the *bound* schema's own
  `step`/`final`, so they cannot rank differently from the buffered emitter.
  Memory is `O(preceding + following + 1)` per function per partition.
- **RANGE** — entries finalize when a later arrival's value strictly exceeds
  `v_j + following` (right edge has passed). Frame values are computed by
  scanning the buffer for rows with `v ∈ [v_j - preceding, v_j + following]`
  (finite `v_j`) or the contiguous non-finite peer span (NULL / non-numeric
  `v_j`). Buffer is trimmed front-of-line as old rows fall out of every
  remaining pending entry's frame.

At partition close, all remaining pending entries are flushed with their
right edges clamped to the last row.

The rule id `monotonic-window` can be disabled via `tuning.disabledRules`. See
[Monotonic streaming-window recognition](./optimizer-streaming.md#monotonic-streaming-window-recognition).

## Testing

Window functions are comprehensively tested through SQL Logic Tests (`test/logic/07.5-window.sqllogic`):

- Basic functionality (ROW_NUMBER, RANK, DENSE_RANK)
- Partitioning with multiple expressions
- Complex ORDER BY with ASC/DESC and NULLS FIRST/LAST
- Frame specifications (ROWS BETWEEN, UNBOUNDED PRECEDING/FOLLOWING)
- Aggregate functions with window frames
- NULL handling and edge cases
- Multiple window functions in single query
- Collation-aware PARTITION BY (NOCASE grouping)
- Collation-aware ranking (DENSE_RANK / RANK with NOCASE ORDER BY)
- NULL PARTITION BY grouping (SQL standard: NULLs group together)
- Navigation functions (LAG, LEAD with offset/default, FIRST_VALUE, LAST_VALUE)
- Statistical ranking (PERCENT_RANK, CUME_DIST with ties)
- NTILE bucket distribution
- RANGE BETWEEN value-based frames (CURRENT ROW peers, N PRECEDING/FOLLOWING)
- Window functions in a GROUPED query (window over the groups, HAVING interaction,
  plan-time rejection of an ungrouped column in the window specification)
- `*` alongside a window column (position, duplicate-name disambiguation) — column
  names and order in `test/plan/grouped-projection-shape.spec.ts`

## Extensibility

New window functions can be added through the function registry system. A
registration is a single schema object (`WindowFunctionSchema`):

```typescript
registerWindowFunction({
    name: 'NEW_FUNC',
    argCount: 1,              // or 'variadic'
    returnType: { /* ScalarType */ },  // fallback type
    requiresOrderBy: false,
    kind: 'aggregate',       // 'ranking' | 'aggregate' | 'value' | 'navigation'
    step: (state, value) => { /* update state */ },
    final: (state, rowCount) => { /* return result */ }
});
```

**Return-type inference.** Pass-through functions whose result is the argument
value verbatim (`MIN`, `MAX`, `FIRST_VALUE`, `LAST_VALUE`, `LAG`, `LEAD`) supply
an optional `inferReturnType(argTypes) => ScalarType` that derives the result
type from `argTypes[0]` (the value expression) rather than the fixed
`returnType`. For `LAG`/`LEAD` the offset and default arguments do not widen the
result. When no argument types are available the planner falls back to the
declared `returnType`.

**Comparison context.** A function whose result depends on how values *compare*
(`MIN`, `MAX`) also supplies `bindArgs(args) => { step?, final? }`. The emitter
calls it once per call site — never per row — with each argument's declared
logical type and resolved collation, and runs the returned closures in place of
the declared ones (`bindWindowSchema`, `schema/window-function.ts`); an omitted
field keeps the declared default. Route the comparison through
`createSemanticValueComparator` (`util/comparison.ts`) so the window ranks
exactly as the matching aggregate and `order by` do — see `docs/types.md`,
"Semantic ordering". Resolving a type or a collation inside `step` instead is a
bug: `step` runs per row.

## Future Enhancements

**Advanced Features:**
- Named window specifications (WINDOW clause)
- Custom frame exclusion options

The window function implementation provides a solid foundation for advanced SQL analytics while maintaining the architectural principles of the Titan runtime system. 
