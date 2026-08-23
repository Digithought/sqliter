# Optimizer Streaming Recognition

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Rules that recognize a plan shape whose input already arrives in the order the
operator would otherwise have to establish, and replace the buffering operator with a
one-pass streaming one. All of them read `physical.monotonicOn` — the "this relation
is totally ordered on attribute *x*" advertisement described in
[the optimizer hub](optimizer.md#core-components).

## Streaming asof scan

The "asof join" — for each left row, a single right row whose key relates to
the left's key by the asof predicate, optionally per partition — is a recurring
shape in time-series and event-stream queries. Two symmetric forms are
recognized:

- **Latest-le** (`direction = 'desc'`): largest right.K ≤ left.K. Predicate
  `q.K <= t.K` (or strict `<`), sort `order by q.K desc limit 1`.
- **Earliest-ge** (`direction = 'asc'`): smallest right.K ≥ left.K. Predicate
  `q.K >= t.K` (or strict `>`), sort `order by q.K asc limit 1`.

Standard SQL writes both as a lateral-top-1 subquery:

```sql
-- Latest-le (desc):
select t.*, q.bid, q.ask
from (select * from trades order by ts) t
left join lateral (
  select bid, ask from quotes q
  where q.symbol = t.symbol and q.ts <= t.ts
  order by q.ts desc limit 1
) q on true;

-- Earliest-ge (asc):
select t.*, q.bid
from (select * from trades order by ts) t
left join lateral (
  select bid from quotes q
  where q.symbol = t.symbol and q.ts >= t.ts
  order by q.ts asc limit 1
) q on true;
```

Without specialization this executes as a per-left-row re-evaluation of the
lateral subquery — `O(L · log R)` at best. The `ruleLateralTop1Asof` rule
recognizes the pattern and rewrites the JoinNode to an `AsofScanNode`, which
runs in `O(L + R)`.

The node carries a `strategy` discriminator picked up by
`rule-asof-strategy-select` after the children's physical properties are
finalized:

- **`'hash'`** (default): bucket the right by partition key into
  `Map<string, Row[]>`; stream the left with per-bucket cursors. Memory `O(R)`,
  latency = first emit after R fully arrives. The right's monotonic
  matchAttr advertisement is the only ordering required.
- **`'merge'`**: co-stream both inputs in lockstep when both already arrive in
  `[partition cols..., matchAttr]` order. Memory `O(1)` (one in-flight
  partition's saved match), emits as left rows arrive.

**Required pattern** (peeled in any nesting order; AliasNode is transparent):

```
JoinNode (joinType ∈ {inner, left, cross}, condition absent or trivially true)
  left:  Left
  right: ProjectNode? | LimitOffsetNode(LIMIT 1, no OFFSET) | SortNode (single column key)
            └─ FilterNode (ANDed: q.K op left.K  AND  q.P_i = left.P_i ...)
                  └─ ...some pipeline... TableReference
```

`op` is `<=`/`<` (latest-le) or `>=`/`>` (earliest-ge). The lateral-side
projection must be trivial column references (so the rule can preserve
attribute IDs). The Sort must be a single column reference; its direction must
agree with the predicate (`desc` ↔ `<=`/`<`, `asc` ↔ `>=`/`>`).

**Required vtab capabilities**: the underlying right table's `getBestAccessPlan`
must advertise `monotonicOn(K)` and `supportsAsofRight: true` for an ordered
scan on the asof match column. The `memory` module advertises this for the
leading column of the primary key.

**Required left ordering**: the left input must expose
`physical.monotonicOn(matchAttr)` — typically by wrapping the left in
`ORDER BY matchAttr` (or by relying on a PK that orders by the match column).
Without this, the per-bucket cursor would regress and produce wrong rows for
out-of-order left input. When the precondition is unmet the rule does not fire
and the existing nested-loop lateral path executes unchanged.

**Bail conditions**: the rule does not fire when

- the right access plan lacks `monotonicOn(K)` or `supportsAsofRight`,
- the lateral has multiple inequalities on the right key,
- the lateral's projection contains a non-trivial expression,
- `LIMIT n` for `n ≠ 1` or `OFFSET ≠ 0`,
- the sort is on a computed expression (not a trivial column reference),
- the sort direction disagrees with the predicate (e.g. `q.K <= t.K` with `order by q.K asc`),
- the left is not monotonic on the match attribute.

The rule runs in the Structural pass — before
`predicate-pushdown` — so the lateral's `FilterNode` carrying
the asof predicate is intact when matching.

### Strategy selection (hash → merge)

`rule-asof-strategy-select` runs in the PostOptimization pass,
after `monotonic-range-access` has finalized the leaves' `physical.ordering` /
`monotonicOn` advertisements. It is a predicate-driven rewrite (no cost-side
search) that promotes `AsofScanNode.strategy` from `'hash'` to `'merge'` when:

- Both children's `physical.ordering` carries a leading
  `[partition cols..., matchAttr]` prefix. Partition columns may appear in any
  permutation, but the *positions* on left and right must pair via the
  `partitionAttrs` equi-pairs, with matching directions on each side.
- The trailing match-attr ordering is **ASC** on both sides. The merge emitter
  walks both inputs forward — `direction='desc'` accumulates the latest
  qualifier seen, `direction='asc'` returns the first qualifier — and that
  forward walk requires ascending match-attr sort regardless of asof
  direction.
- The right's estimated row count meets `tuning.asof.mergeRowThreshold`
  (default `10000`). Below the threshold, hash buffering's constant factors
  beat merge-state bookkeeping.

Bails (and the node stays on `'hash'`) on any failure. Disable via
`tuning.disabledRules` containing `'asof-strategy-select'`. Force-enable for
testing by setting `tuning.asof.mergeRowThreshold` to `0`.

The merge variant assumes the children's iterator already emits in the
required order; it does not synthesize the ordering. The current
`ruleLateralTop1Asof` precondition (`physical.monotonicOn(left.matchAttr)`)
typically requires the user to wrap the left in `ORDER BY matchAttr` — which
provides global match-attr monotonicity but no partition prefix. The
unpartitioned (`partitionAttrs.length === 0`) case is the natural fit today;
partitioned merge requires a left input with `[partition..., matchAttr]`
ordering, which is not yet recognized as "monotonic within partition" by the
recognition rule. That extension is a follow-up.

## Monotonic LIMIT/OFFSET pushdown

Paginating into the middle of a sorted result — `select … from t order by x limit n offset k` — is a common shape. Without specialization the runtime sorts/buffers `k + n` rows and discards `k` of them. When the access path advertises both `monotonicOn(x)` and `supportsOrdinalSeek`, the `monotonic-limit-pushdown` rule replaces the `LimitOffset[/Sort]/leaf` subtree with an `OrdinalSliceNode` that stamps `offset`/`limit` onto the leaf's `FilterInfo` so the vtab seeks directly to the kth row in `O(log N)` and emits at most `n` rows.

**Required pattern** (peeled top-down from `LimitOffsetNode`):

```
LimitOffsetNode
  └─ SortNode?           (single trivial column ref matching leaf monotonicOn)
        └─ (ProjectNode | AliasNode)*   (only trivial column-reference projections)
              └─ IndexScan / IndexSeek / SeqScan
                    (advertises monotonicOn AND accessCapabilities.ordinalSeek)
```

`OrdinalSliceNode` slots in directly above the leaf, preserving the original `Project`/`Alias` chain above it. The `Sort` is dropped — the slice's source already emits in the requested order, and re-sorting would be wasted work.

**Required vtab capabilities**: the leaf's access plan must advertise both `monotonicOn` and `supportsOrdinalSeek`. The vtab's `query()` implementation must honor `FilterInfo.offset` (positioning its iterator at the kth monotonic row) and `FilterInfo.limit` (capping output). Modules that advertise `supportsOrdinalSeek` but ignore the directives degrade silently to a streaming `LIMIT` (the slice still enforces the row cap as a guard above the leaf).

**Bail conditions**: the rule does not fire when

- the leaf lacks `accessCapabilities.ordinalSeek` or `monotonicOn`,
- a `Sort` sits between `LimitOffset` and the leaf with a different attribute, direction, or multiple keys,
- a non-trivial intermediate node (`Filter`, `Distinct`, `Aggregate`, `Project` with computed expressions, etc.) sits between `LimitOffset` and the leaf — the offset arithmetic only holds when the chain preserves row count and order,
- both `LIMIT` and `OFFSET` are absent (degenerate node),
- `ORDER BY` references multiple columns.

When the precondition is unmet the rule does not fire and the existing `LimitOffsetNode` path executes unchanged. The `memory` module currently does **not** advertise `supportsOrdinalSeek` (its layered store does not cheaply support ordinal seek across overlay layers); custom modules with native ordinal indexing — IndexedDB-backed stores, sorted external datasets — can opt in.

**Composes with `ruleOrderByFdPruning`**: a multi-key `ORDER BY` (the last bail condition) frequently arises from `ORDER BY pk, name` shapes where the trailing keys are functionally determined by the PK. The Structural-pass `ruleOrderByFdPruning` ([rule catalog](optimizer-rules.md#optimization-rules), under Sort) reduces such sorts to single-key form, which then satisfies this rule's `Sort`-shape precondition. Structural runs before PostOptimization, so the ordering is automatic.

The rule runs in the PostOptimization pass (after `join-physical-selection`, before `mutating-subquery-cache`) — late enough that `select-access-path` has produced the physical leaf with its capabilities, early enough to interact with downstream cache and materialization rules.

The rule id `monotonic-limit-pushdown` can be disabled via `tuning.disabledRules`.

**Composes with `minmax-index-boundary`**: the Structural-pass
`ruleMinMaxIndexBoundary` ([rule catalog](optimizer-rules.md#optimization-rules), under
Aggregation) rewrites an ungrouped `min(c)` / `max(c)` over an indexed column into
`Aggregate → LimitOffset(1) → [Filter(c is not null)] → ordered leaf`. When the leaf
also advertises `supportsOrdinalSeek`, the nullable-free variant of that shape
(`LimitOffset(1)` directly over the leaf) is exactly this rule's pattern, so the
`LimitOffsetNode` may become an `OrdinalSliceNode`. Both are correct and both stop
after one row, so tests over that shape must tolerate either operator — assert "one
row came out of the leaf" via work counters rather than pinning the operator name. The
nullable variant keeps its `Filter` between the two and therefore always bails here
(the intermediate-node condition above), which is fine: the plain `LimitOffsetNode`
already stops the walk after the first non-NULL row.

## Monotonic range-scan recognition

Range predicates that bound a `MonotonicOn` access column (`WHERE id BETWEEN 2 AND 5`, `WHERE id >= 2 AND id < 8`, `WHERE id > 4`, etc.) are already lowered to a range index seek by `rule-select-access-path`, which lifts the underlying access plan's `monotonicOn` advertisement onto the physical leaf. The `monotonic-range-access` rule sits on top of that plumbing and adds two things:

1. **Symbolic annotation (`rangeBoundedOn`)** — when the leaf advertises `monotonicOn(x)` and its `FilterInfo.constraints` carries a handled range/equality on `x`, the rule sets `physical.rangeBoundedOn` on the leaf so EXPLAIN and downstream rules can read off the symbolic bound:

	```jsonc
	"rangeBoundedOn": {
		"attrId": 17,
		"lower": { "op": ">=", "valueLiteral": 2 },
		"upper": { "op": "<=", "valueLiteral": 5 }
	}
	```

	`valueLiteral` is populated when the bound is a literal; for parameter / correlated bounds it is omitted (the bound is still recognized; only the literal display is). Half-open ranges omit `lower` or `upper`. The annotation is a pure label — it does not change the row stream.

2. **Defensive `monotonicOn` drop** — if a `FilterNode` sits directly above a leaf that advertises `monotonicOn(x)` and the Filter's predicate carries a range/equality on `x`, the vtab returned `handledFilters[i] = false` for the bound. The row stream emerging from the *Filter* is no longer monotonic over the WHERE-restricted set, so the rule drops `monotonicOn` (and the implied `accessCapabilities`) from the leaf via a `suppressMonotonic` flag on the leaf. In well-behaved modules this case never fires; the escalation is purely defensive against a misbehaving vtab.

### Recognition patterns

| SQL shape | Bound translation |
| --- | --- |
| `x BETWEEN a AND b` | `>= a` and `<= b` |
| `x >= a AND x <= b`, `x >= a AND x < b`, `x > a AND x <= b`, `x > a AND x < b` | as written |
| `x = c` | `>= c` and `<= c` (degenerate range; only fires when the leaf actually advertises `monotonicOn` for equality, which the memory module does not) |
| `x >= a` (alone), `x < b` (alone) | half-bounded `[a, ∞)` / `(-∞, b)` |
| `x IN (c1, c2, …)` | not annotated — multi-IN multi-seek emit is non-monotonic; the memory module does not advertise `monotonicOn` for it, so the rule no-ops |

### Composition with other rules

`rangeBoundedOn` is a passive annotation today — no other optimizer rule reads it. `monotonic-merge-join`, `monotonic-limit-pushdown`, and `lateral-top1-asof` continue to inspect `physical.monotonicOn` / `accessCapabilities`, so they compose cleanly with range-bounded leaves (a range-bounded merge / asof / slice still operates on the range's emit order).

The defensive `monotonicOn` drop, by contrast, is load-bearing: it is the safety net against a vtab that advertises `monotonicOn(x)` while declining a range filter on `x`.

### Registration

The rule is registered in the PostOptimization pass, on each of the four targeted node types: `IndexScan`, `IndexSeek`, `SeqScan` (annotation pass), and `Filter` (defensive drop). Its rule ids are `monotonic-range-access-IndexScan`, `monotonic-range-access-IndexSeek`, `monotonic-range-access-SeqScan`, and `monotonic-range-access-filter`, all individually disable-able via `tuning.disabledRules`.

## Monotonic streaming-window recognition

Window functions over a stream that already arrives in `[PARTITION BY..., ORDER BY[0]]` order don't actually need the buffer/sort the buffered emitter applies. The `monotonic-window` rule recognises these cases on a `WindowNode` and tags it with a `streaming` config that flips the runtime to a one-pass emitter (`runStreaming` in `runtime/emit/window.ts`). The streaming emitter walks rows in source order, maintains O(P) per-partition state (one partition alive at a time), and emits in source order — saving the `O(N log N)` sort and the `O(N)` materialisation buffer.

**Required preconditions** (all must hold; the rule no-ops on any failure):

- The leading ORDER BY key is a trivial `ColumnReferenceNode` whose `attrId` matches a `physical.monotonicOn` entry on the source, with the same direction.
- The source's `physical.ordering` covers any subsequent ORDER BY keys (in declared order, with matching directions).
- PARTITION BY columns are an emit-order prefix of the source ordering (any permutation; the rule reorders).
- All partition-by expressions are trivial column references.
- Every function in the `WindowNode` is individually recognised (see the [streaming fast-path table](./window-functions.md#streaming-fast-path-over-monotonicon) for the supported set).
- The frame is either absent (default), the explicit equivalent of `UNBOUNDED PRECEDING TO CURRENT ROW` (in `ROWS` or `RANGE` mode), or a bounded sliding frame — each of its two bounds being a non-negative integer literal offset or `CURRENT ROW`, which is that bound at offset zero. See the [streaming fast-path table](./window-functions.md#streaming-fast-path-over-monotonicon).
- No function is `DISTINCT`.

**Output invariant**: a streaming `WindowNode` preserves the source's `ordering` *and* `monotonicOn` unchanged (the streaming runtime is row-pass-through, no sort intervenes). Downstream rules that key off either — `monotonic-limit-pushdown`, `monotonic-merge-join`, `monotonic-range-access` — compose naturally above streaming windows. A *buffered* `WindowNode` is the case that does not pass its source's order through; see [window-functions.md § "What the `WindowNode` advertises as its emit order"](./window-functions.md#what-the-windownode-advertises-as-its-emit-order) for the full four-case table.

The rule runs in the PostOptimization pass (after `monotonic-merge-join` so child joins have already become MergeJoins and propagated their `monotonicOn`; before `monotonic-limit-pushdown`, though they don't directly interact since they target different node types). Its rule id `monotonic-window` is disable-able via `tuning.disabledRules`.

When the rule no-ops, the existing buffered emitter runs unchanged.
