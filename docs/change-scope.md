# Change-scope introspection

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The **change-scope** API exposes — as a small JSON-serializable data
contract — what base-table state and external inputs a prepared
`Statement` reads from. It is the external projection of the internal
binding-key analysis used by assertions and incremental view
maintenance (see [optimizer-assertions.md](optimizer-assertions.md) § "Binding-aware Delta
Planning").

A `ChangeScope` answers questions like:

- "Which tables does this query depend on, and which columns of each?"
- "If I want to know when this query's result might change, what
  rows/groups/parameters must I watch?"
- "Does this query depend on time, random, or external (parameter)
  inputs that watching state alone cannot detect?"

The companion `Database.watch` watcher consumes the same shape
end-to-end. The change-scope API itself stops at *analysis*: it
produces the description; the watcher fires callbacks. See the
[Watcher](#watcher) section below.

## Data contract

```ts
interface ChangeScope {
  readonly watches: ReadonlyArray<TableWatch>;
  readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
  readonly unboundParameters: ReadonlyArray<number | string>;
}

interface QualifiedName {
  readonly schema: string;   // lowercased
  readonly table: string;    // lowercased
}

interface TableWatch {
  readonly table: QualifiedName;
  readonly columns: ReadonlySet<string> | 'all';
  readonly scope: WatchScope;
}

type WatchScope =
  | { kind: 'full' }
  | { kind: 'rows';        key: readonly string[];      values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
  | { kind: 'groups';      groupBy: readonly string[] }
  | { kind: 'rowsByGroup'; groupBy: readonly string[];  values: ReadonlyArray<ReadonlyArray<ScopeValue>> };

type ScopeValue = SqlValue | ParamScopeValue;

interface ParamScopeValue {
  readonly kind: 'param';
  readonly index: number | string;
  readonly type: PortableScalarType;
}

interface PortableScalarType {
  readonly typeName: string;     // logical type name (e.g. 'TEXT', 'INTEGER')
  readonly nullable: boolean;
  readonly collationName?: string;
  readonly isReadOnly?: boolean;
}

type NonDetSource =
  | { kind: 'time' }
  | { kind: 'random' }
  | { kind: 'volatileUdf'; name: string }
  | { kind: 'parameter'; index: number | string };
```

### `columns` semantics

For each `TableWatch.columns`:

- A `ReadonlySet<string>` lists the lowercased column names actually
  read by the plan (output projection plus filter/group/order/aggregate
  inputs).
- The sentinel `'all'` is used in two cases: when the plan does not read
  any column-specific data (e.g. `select count(*) from t`), AND when the
  plan serves a table's *whole row* to its output (a `select *`, which the
  planner elides to a passthrough that forwards the base table's entire
  attribute set with no per-column `ColumnReferenceNode`). In the latter
  case pinning to `'all'` keeps the read set sound — a downstream host that
  emits precise pk+column change events would otherwise miss changes to
  every non-predicate column of the watched row.

A `kind: 'full'` watch with `columns: {a, b}` is meaningful: the
underlying query scans the table but only reads `a` and `b`. A future
watcher narrows row-change firings to changes that touch a watched
column.

### Equality, ordering, normalization

A `ChangeScope` returned by `analyzeChangeScope` is canonical:

- `watches` are sorted by `(schema, table)` then `scope.kind` then a
  deterministic key serialization of the scope.
- `unboundParameters` and `nonDeterministicSources` are
  sorted/deduplicated.
- Within a `rows`/`rowsByGroup` watch, `values` tuples are
  lex-sorted by their `ScopeValue` representation and duplicates are
  dropped.
- All qualified-table names use lowercased `schema` and `table` fields.

Two scopes describing the same constraints are deep-equal.

### Cloning and serialization

`ChangeScope` is plain data. Two equivalent round-trip paths are
supported:

```ts
// JSON path (wire-safe).
const wire = JSON.stringify(serializeChangeScope(scope));
const back = deserializeChangeScope(JSON.parse(wire));

// In-memory clone (no JSON, no string conversion).
const cloned = structuredClone(scope);
```

Both produce a value structurally identical to the input. The on-wire
shape uses sorted `string[]` for `TableWatch.columns` rather than a
`Set`; `deserializeChangeScope` re-hydrates it back into a
`ReadonlySet<string>`. `PortableScalarType` is intentionally a flat
data shape so the entire `ChangeScope` is `structuredClone`-safe; if
you need a full `ScalarType` (with the registered `LogicalType`'s
behaviour functions) from a portable shape, call
`scalarTypeFromPortable`.

### Composition lattice

`unionScopes(a, b)` widens; `intersectScopes(a, b)` narrows:

- Per table:
  - `full` ∨ anything = `full`.
  - `groups(G₁) ∨ groups(G₂)` keeps the shorter `groupBy` when one is a
    subset of the other; otherwise collapses to `full`.
  - `rows(K, V₁) ∨ rows(K, V₂)` merges the value sets when the keys
    match; otherwise collapses to `full`.
  - `rowsByGroup` follows `rows` with the additional `groupBy`
    constraint.
  - Mixed shapes (rows vs groups, etc.) collapse to `full` under union.
- `intersect` is the dual: same-key value sets are intersected; mismatched
  keys produce no watch for that table; nondeterministic-source and
  unbound-parameter sets are intersected.

`bindParameters(scope, params)` substitutes matching `ParamScopeValue`
placeholders with literal values and removes the bound indices from
`unboundParameters` and from `nonDeterministicSources` (kind `'parameter'`).

`isEmpty(scope)` is true iff `watches`, `nonDeterministicSources` and
`unboundParameters` are all empty.

`describesEverything(scope)` is true iff every watch is `full` and
covers every column (`columns === 'all'`) for every base table the
scope mentions.

## How the analyzer derives each field

`analyzeChangeScope(plan, options?)` accepts a `PlanNode` and:

1. Calls `extractBindings(plan)` from `binding-extractor.ts` to obtain
   a `BindingMode` per `TableReferenceNode` instance (see
   [optimizer-assertions.md](optimizer-assertions.md)).
2. Walks the scalar-expression tree to collect, per
   `TableReferenceNode`, the set of column indices its
   `ColumnReferenceNode`s touch.
3. Walks the scalar-expression tree to collect
   `nonDeterministicSources`:
   - Function calls whose schema does **not** carry
     `FunctionFlags.DETERMINISTIC`. Well-known builtins are mapped to
     `{kind: 'time'}` (`now`, `current_timestamp`, `date`, `time`,
     `datetime`, `julianday`, `epoch_s`, `epoch_ms`, `epoch_s_frac`,
     `strftime`) or `{kind: 'random'}` (`random`, `randomblob`); the
     rest become `{kind: 'volatileUdf', name}`.
   - Parameters referenced *outside* a recognized row/group binding
     equality become `{kind: 'parameter', index}` — the only signal
     that "watching state alone cannot tell you when the result
     changes."
4. For each `TableReferenceNode`, translates its `BindingMode`:
   - `global` → `{kind: 'full'}`.
   - `row {keyColumns}` → `{kind: 'rows', key, values}` with values
     drawn from the equality predicates that supplied the binding
     (literals stay as literals, parameters become `ParamScopeValue`
     placeholders).
   - `group {groupColumns}` → `{kind: 'rowsByGroup', groupBy, values}`
     when the predicates above the aggregate also pinned the binding
     values; otherwise `{kind: 'groups', groupBy}`.
5. Normalizes the result (sorting + dedup) before returning it.

If `options.params` is supplied (`SqlValue[]` or
`Record<string, SqlValue>`), the result has
`bindParameters(scope, params)` applied to it before being returned.

### DML statements

For an UPDATE / INSERT / DELETE plan:

- **With `RETURNING`**: the analyzer treats the RETURNING projection as
  a SELECT over the affected rows. Watches reflect the rows being
  returned (typically a `rows` scope on the target table's PK).
- **Without `RETURNING`**: the statement does not surface table state
  to the caller. `watches` is empty. Parameters in the WHERE / SET
  clauses still appear in `unboundParameters` so a caller binding the
  statement repeatedly can still observe what it parameterizes on.

### DML write-target propagation (FROM-position DML)

A SELECT that contains nested DML — e.g.
`select * from (insert into t (x) values (1) returning *) z` — writes to
`t` as part of its evaluation. The analyzer must surface `t` in the
outer statement's `ChangeScope` so a watcher subscribed to `t` (or any
caller introspecting the scope) sees the write surface.

`Insert` / `Update` / `Delete` nodes hold their write-target
`TableReferenceNode` on `.table`, **outside** `getChildren()` (only
visible via `getRelations()`). The analyzer's plan walk must descend
through both `getChildren()` and `getRelations()` to capture the target.
With that walk, the write target is classified the same way any other
table reference would be — typically `{kind:'full'}` — and the outer
statement's ChangeScope picks it up automatically.

The propagation chain rests on the [optimizer's side-effect audit
discipline](optimizer.md#audit-discipline-sideeffectmode): no rule may
silently drop the nested DML subtree (that would also break the
write-target propagation), and `physical.readonly` propagates as
AND-of-children so `subtreeHasSideEffects` is reliable.

### Materialized-view reference projection

A `select` from a materialized view resolves to a `TableReference` on the MV's
backing table (`_mv_<name>`), not a body expansion — so the analyzer would
naively report the *backing table* as the watched table. A watcher usually wants
the **sources**: the backing is maintained synchronously from them at the
row-write boundary (row-time), and source-granularity is what the caller means by
"watch this view".

The analyzer therefore **projects** a materialized-view backing reference onto
the MV's source tables. `Statement.getChangeScope()` passes
`analyzeChangeScope` a `resolveMaterializedViewSource` resolver (backed by
`SchemaManager.getMaterializedViewByBackingTable`); when a reference is a
materialized view's backing table, its watch is replaced by the MV's
cached source-union scope (`MaterializedViewSchema.sourceScope`, built once at
registration by `buildSourceUnionScope`). The projected scope is `unionScopes`-d
into the result, so reading both the MV and a source directly reports the source
once. v1's source-union is a `full` watch per source; a precise per-source
row/group scope is a future refinement.

Every materialized view is projected this way. See
[materialized-views.md § Change-scope projection](materialized-views.md#change-scope-projection).

**The projection is granularity-widening, not load-bearing.** A maintained table
*does* appear in the transaction change log in its own right: row-time
maintenance records each realized backing delta through the same
`TransactionManager.recordInsert/Update/Delete` surface the DML boundary uses
(`MaterializedViewManager.recordMaintenanceChanges` — see
[incremental-maintenance.md § Recording changes](incremental-maintenance.md#recording-changes)).
So a watch left on the backing table would fire, and a `create assertion` whose
body names a materialized view is dispatched at COMMIT like one over any other
table. Removing the projection would change *which* writes a watcher observes,
which is why it stays.

One consequence worth knowing: the projection is **one level deep** — it names
the view's *direct* sources, not the transitive closure. For `mv2` over `mv1`
over `w`, `scope(mv2)` is a watch on `main.mv1`. That fires only because `mv1` is
itself change-logged by maintenance; the projection alone would not reach `w`.

## The two cases that look the same but are not

Row-binding values come from two structurally similar SQL constructs;
the analyzer treats them differently and you should too:

| Source of binding values        | Treatment                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbound parameter (`where pk = ?`) | `{kind:'rows', key, values:[[ParamRef]]}`. Adds the index to `unboundParameters`. `analyzeChangeScope(plan, {params})` resolves the placeholder to a literal and removes the index from `unboundParameters`.                          |
| Subquery (`where pk in (select id from t2)`) | Falls back to `{kind:'full'}` for that watch. The subquery's source table gets its own `TableWatch`. Refining "watch rows of A whose key joins to current rows of B" is *out of scope* for v1 — see Known imprecisions.        |

## Known imprecisions

`analyzeChangeScope` is a sound, **conservative** static analysis: it
never describes *less* than what the query may read, but it sometimes
describes more.

- **Subquery-sourced row bindings.** Equality of a key against a
  subquery (`where pk in (select id from premium)`) collapses to
  `{kind:'full'}` for both tables. A refined "rows-of-A whose key
  joins to current rows-of-B" mode is deferred.
- **Unrecognized non-deterministic functions.** A function declared
  with `deterministic: false` whose name is neither in the known time
  set nor the known random set becomes
  `{kind: 'volatileUdf', name: <lowercased>}`. Callers that want to
  treat a custom UDF as time-like or random-like can post-process the
  scope themselves.
- **DML without `RETURNING`** produces empty watches by design — the
  statement returns no data, so the caller has nothing to "watch."
  Parameters used in the WHERE/SET clauses are preserved in
  `unboundParameters`.
- **Joins where binding extraction couldn't pin a key.** The analyzer
  falls back to `{kind:'full'}` rather than guessing. This is not a
  bug but may surprise callers who expect inter-table propagation
  beyond what the equivalence-class machinery already provides.
- **Row bindings whose values are non-literal/non-parameter expressions.**
  If the binding extractor sees an equality on a unique key but the
  right-hand side is a complex expression (e.g. `pk = coalesce(?, 0)`)
  that the analyzer cannot decode into a `ScopeValue`, the watch falls
  back to `{kind:'full'}` rather than emitting `{kind:'rows', values: []}`
  (which would describe "watch zero rows" and under-specify the scope).
- **MV source projection is whole-table.** Reading a materialized view projects
  to a `{kind:'full'}` watch per source table (see
  [Materialized-view reference projection](#materialized-view-reference-projection)).
  Even when the MV's body keys on a source PK or group key, the projected scope
  does not yet narrow to those rows/groups — sound but coarse.

## Watcher

`Database.watch(scope, handler)` registers a post-commit callback
driven by the same `ChangeScope` shape the analyzer produces.

```ts
interface Subscription {
  readonly id: string;        // 'watch:<base32-hash>:<nonce>'
  unsubscribe(): void;        // idempotent
}

interface MatchedWatch {
  readonly watch: TableWatch;
  readonly hits: ReadonlyArray<ReadonlyArray<SqlValue>>;
}

interface WatchEvent {
  readonly matched: ReadonlyArray<MatchedWatch>;
  readonly txnId: string;
}

type WatchHandler = (event: WatchEvent) => void | Promise<void>;

watch(scope: ChangeScope, handler: WatchHandler): Subscription;
```

The watcher is **plan-independent**: any `ChangeScope` value works —
freshly analyzed, deserialized from disk, hand-built in test code, or
received over a network.

### Firing semantics

- **After-commit only.** The handler runs once per successful commit,
  after every connection has committed and before the change log is
  cleared. Mirrors assertion COMMIT eval and MV maintenance.
- **One event per commit.** A multi-table scope produces a single
  `WatchEvent` whose `matched` array carries every `TableWatch` that
  saw a change in this transaction. Watches that weren't touched are
  omitted.
- **Empty match → no fire.** If every `TableWatch` would have an empty
  hits set (e.g. a `rows(pk=[7])` watch when only id=8 changed), the
  handler is not called at all.
- **Re-entrancy is safe.** A handler that calls `database.watch` or
  `subscription.unsubscribe` during a fire is legal; the kernel
  iterates a snapshot of subscriptions per commit, so the new/removed
  subscription takes effect on the next commit, not the current one.

### `hits` semantics

| `WatchScope.kind` | `hits` contents |
| --- | --- |
| `full`        | Always `[]` (the watch describes the whole table — no narrower set to report). |
| `rows`        | The bound tuples from `values` that intersected the changes in this txn. |
| `groups`      | The distinct group-key tuples touched in this txn. |
| `rowsByGroup` | The bound tuples from `values` that intersected the changes in this txn. |

If the kernel falls back to a global re-evaluation (e.g. missing PK,
the cost-based fallback fired, or the whole relation changed opaquely),
the watcher still fires — coarsely — rather than miss the change:

- `full` and `groups` watches fire with **empty** `hits` ("something
  changed, re-query"); neither carries a narrower set to report.
- `rows` / `rowsByGroup` watches surface every literal value the watch
  was registered for — "all of your watched keys may have changed."

### Validation

`watch(scope, handler)` rejects synchronously (throws `QuereusError`)
when:

- `scope.unboundParameters.length > 0` — the kernel can't bind values
  from `ScopeValue.param` placeholders. Call `bindParameters(scope,
  params)` first. The error message says so.
- Any `TableWatch` references a table that does not exist in the
  current schema, or any column referenced in `key`, `groupBy`, or
  `columns` (when not `'all'`) does not exist on its table.

`watch(scope, handler)` accepts and warns once (via the logger) when:

- `scope.watches.length === 0` **and**
  `scope.nonDeterministicSources.length === 0` — a dead subscription
  that will never fire. The warning includes the `Subscription.id`.

`scope.nonDeterministicSources` is **advisory metadata only**. The
watcher does not synthesize fake events for time/random sources. If
a caller needs polling for time-sensitive queries, that is out of
scope here.

### Handler errors do not roll back the commit

Asymmetric with assertions: assertions enforce (a violation rolls the
commit back); watchers observe. A handler that throws — synchronously
or via a rejected Promise — has its error logged and swallowed. The
commit has already succeeded by the time the handler runs.

### Schema-change invalidation

If a table or column the scope mentions is later dropped or altered
(any `'table_removed'` or `'table_modified'` schema change), the
subscription is **disposed**: capture-spec demand is released, the
kernel forgets it, and further commits won't fire it. A warning is
logged with the `Subscription.id`. To continue watching, build a fresh
`ChangeScope` against the new schema and re-subscribe. This is
intentional v1 simplicity — auto-rebind is deferred.

### External / out-of-band changes

```ts
notifyExternalChange(tableName: string, schemaName?: string): Promise<void>;
```

The post-commit path only fires for changes that flow through *this*
`Database`'s change log. A table backed by a replicated/external store
(e.g. an optimystic vtab) can learn of a **remote** write that never
touched the local change log — its watchers would otherwise never fire.
`notifyExternalChange` bridges that gap: it fires every active watcher
whose scope includes `schema.table` as if the whole table changed,
**without** a local commit. `schemaName` defaults to the current schema;
matching is case-insensitive on the lowercased `schema.table` key.

It is **coarse by design** — table-granular, no key narrowing. Each
matching subscription is driven through the same global re-evaluation
branch the commit-path fallback uses, so the `hits` follow the
global-fallback rules above (`full`/`groups` → empty `hits`;
`rows`/`rowsByGroup` → all registered literals). Over-firing only costs
the consumer an extra re-query; it never misses a change. A no-op when no
subscription matches; per-handler errors are logged and swallowed, never
rejecting into the caller (same contract as the post-commit path).
Handlers fire serially and are awaited. A future optional `changedKeys`
argument could add a precise key-scoped variant without breaking callers.

### `Subscription.id` shape

`watch:<base32-hash>:<nonce>` where the hash is a 6-character djb2
digest over a canonical serialization of the scope (sorted column
sets, JSON of each watch, sorted non-det sources). Two subscriptions
on the same scope share the same hash prefix; the nonce
disambiguates individual registrations. Useful in logs and for
cross-process correlation.

### `txnId`

Opaque string from a monotonic counter inside the `Database` —
`txn:1`, `txn:2`, .... Stable within one `Database` instance, not
portable across processes. There is no public transaction-id surface
today; the counter exists so handlers can deduplicate or correlate
events.

### Known limitations (v1)

- **Column tracking on `full` watches over-fires.** A
  `{kind: 'full', columns: {a, b}}` watch registers capture demand
  for `a` and `b` so the column-level deltas are recorded, but the
  watcher always fires on any change to the table — the underlying
  change-log API doesn't yet expose a "did column X change" predicate.
  This is sound (never misses) but coarse. A precise narrowing pass is
  a future optimization.
- **No auto-rebind on schema change.** As described above.
- **Watcher errors don't roll commits back.** As described above.

## See also

- [optimizer-assertions.md](optimizer-assertions.md) — § "Binding-aware Delta Planning" describes
  the internal `BindingMode` shape this API projects.
- [incremental-maintenance.md](incremental-maintenance.md) — runtime
  surface for delta-driven consumers (assertions today, MVs and
  watchers tomorrow).
