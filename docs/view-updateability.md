# View Updateability

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

Quereus treats views, CTEs, and subqueries-in-`from` uniformly: any relation expression that can be written as a `select` can also be the target of an `insert`, `update`, or `delete`. The engine derives the required base-table operations from the relation's predicate, its functional-dependency surface, and the per-operator semantics described below. There is no `with check option`, no `instead of` trigger surface, and no view-level flag declaring updateability. A relation is updateable iff a deterministic decomposition exists at plan time; if it does not, the mutation surfaces a structured diagnostic naming the operator and column that obstructed propagation.

This document is the **overview**: the update-site model, mutation-propagation spine, multi-base-table and constraint interactions, diagnostics, and the information-schema surface. The subsystems large enough to read on their own live in the topic documents below.

## Topic documents

<!-- NOTE: the sections below that moved into a satellite left a one-line stub behind under
     their original heading, so their old anchors still resolve here. `yarn docs:check`
     therefore cannot tell a link deliberately left on a stub from one that should have been
     retargeted and was not. When linking real content that lives in a satellite, link the
     satellite — not the stub. -->

| Document | Covers | Written for |
| --- | --- | --- |
| [Per-Operator Semantics](vu-operators.md) | How each relational operator (projection, selection, inner/outer join, union/intersect/except, CTE and subquery DML targets) decomposes a write to its base tables. | An engine developer changing operator write-through. |
| [Set-Operation Membership](vu-setops.md) | The `exists <branch> as` membership column on set operations — its soundness, nesting, and the per-branch write fan-out. | An engine developer working on set-operation write-through. |
| [Scalar Invertibility and Authored Inverses](vu-inverses.md) | The invertibility registry, `with inverse`, view-level insert defaults, and mutation tags. | An engine developer touching column writeability. |
| [Mutation Context](vu-mutation-context.md) | Shared/surrogate key defaults, `new.<col>` minting versus resolving, per-row envelope threading. | An engine developer working on key generation. |
| [Round-Trip Laws](vu-roundtrip.md) | The derived backward walk, the three round-trip laws (PutGet / GetPut / lineage agreement), and the predicate-honest complement. | An engine developer changing the backward walk. |

## Overview

### View-body forms

A view body is any relation-producing `QueryExpr` except DML:

- **`SELECT`**: the canonical case. Updateability is FD-driven per the rules below.
- **`VALUES (…), …`**: a literal row set. The body has no base-table lineage, so the FD walker reaches no `TableReferenceNode`; the view is read-only. Insert / update / delete against a `VALUES`-bodied view raises the standard "no recoverable base operation" diagnostic.
- **`INSERT/UPDATE/DELETE … RETURNING`**: **rejected at view-creation time.** A view body re-evaluates on every reference; a DML body would re-drive the write per read, which is incoherent with view semantics. Mutations belong in the statement that *references* the view, not in the view body.

### Capabilities at a glance

The supported write-through shapes:

- **Single-source projection-and-filter** views — `insert` / `update` / `delete` route to the base table, with constant-FD defaults from equality selection predicates, base-column defaults, identity/rename/invertible projection lineage, `OR`-clause conflict resolution, RETURNING, and per-statement mutation-context threading.
- **n-way (≥2) key-preserving inner-join** bodies — `update` / `delete` / `insert` write-through, including **composite-PK sides** and **self-joins** (one base table under two or more distinct aliases). Each output column routes to its owning base table (by its producing scan, so a self-join's aliases stay distinct); rows are identified by an up-front base-PK key capture built over the planned join body (one capture column per side per PK column); an insert mints or threads the shared join key through a per-row surrogate envelope (a single-column shared key — a composite shared-key insert stays deferred).
- **n-way decomposition** bodies (the [lens layer](lens.md)) — fan-out write-through over a module-advertised decomposition.
- **Materialized-view names** — DML routes through this same substrate to the MV's source, and the row-time maintenance hook syncs the backing within the statement ([Materialized Views § Write boundary](materialized-views.md#write-boundary-write-through)).

The shapes still rejected at plan time (with a structured diagnostic) are listed under [Current limitations](#current-limitations).

## Philosophy: Predicates Rule

A mutation against a relation is a predicate over base-table state. The engine finds the smallest set of base-table operations whose post-state satisfies that predicate.

- **Insert** = "make this row exist in the relation"
- **Update** = "for rows matching this predicate, change these columns to these values"
- **Delete** = "make these rows not exist in the relation"

For n-ary operators (union, intersect, except, join), the default policy is **fan out to every branch whose own predicate is consistent with the mutation's row-identifying predicate**. The user controls fan-out by adding predicates (narrowing the rows to a single branch) or by writing a per-row **presence/membership column** (the outer-join existence column, the set-op membership columns) that states the routing explicitly. The engine never silently drops one of several consistent branches.

The classical view-update ambiguity (Bancilhon–Spyratos) only arises when one chooses to suppress effects on some branches. Quereus does not suppress: a mutation routed to *every* satisfying branch is unambiguous by construction. The cost is that mutations can produce more base-table operations than a one-branch policy would, but this is the honest reading of the predicate.

## The Update Site Model

> **Invariant:** [VU-001](invariants.md#vu-001--view-targeted-dml-rewrites-to-base-tables-and-re-plans)

Every relational `PlanNode` carries an `updateLineage` field mapping each output attribute to one of:

- **`base`** — the column traces to a base-table column through a chain of invertible transformations. The chain is recorded so the engine can compose a setter expression on the base column.
- **`computed`** — the column is the output of a non-invertible expression over inputs; it is read-only. Reads pass through; writes against this column are rejected with a diagnostic naming the originating expression.
- **`null-extended`** — the column is potentially null-extended by an outer join; updates require materialization of the missing side (see [Outer Joins](vu-operators.md#outer-joins)).
- **`existence`** — an outer-join `exists … as` match flag (a clean `{true,false}` boolean derived at the combinator). It has no base column and is **writable through an *effect*, not a base mapping**: a flag-flip inserts/deletes the named relational component (see [Existence columns](vu-operators.md#existence-columns-on-outer-joins)).

Lineage is computed in a single pass that mirrors the optimizer's physical-property pass, reusing the functional-dependency framework (see [Functional Dependency Tracking](optimizer-fd.md#functional-dependency-tracking)) to thread per-column provenance through every operator. Equivalence classes propagate writeability: if `a.x` and `b.y` belong to the same EC, a write to either reaches both bases. Constant FDs (`∅ → c = v`) supply default values without authorial intervention.

> **Surface authority.** `updateLineage` is computed in `computePhysical`, so it is available on the **logical** operator tree (Project / Filter / Join / TableReference) the substrate walks. It survives optimization through the pass-through boundary nodes (access scans, Retrieve, Alias) but **not** through operators that rewrite structure (physical `HashJoin` / `MergeJoin`, aggregates, set-ops, Sort/Limit/Distinct). EXPLAIN / `query_plan()` therefore shows full lineage for single-source projection-filter shapes and on every TableReference; a join's optimized top node shows degraded (`computed`) lineage. The logical operator tree is authoritative — both the forward FD walk and the backward propagation read it before those structure-rewriting operators apply, which is precisely why a shape the forward walk cannot thread is also one the backward walk cannot consume.

## Mutation Propagation

> **Invariant:** [VU-002](invariants.md#vu-002--updateable-iff-a-deterministic-decomposition-exists-at-plan-time)

A mutation statement is built like a query: parser → planner → optimizer. After the relation tree is finalized, a **propagation pass** walks the tree from the user-visible top-level relation down to base-table references, emitting a list of base-table operations.

```
UserMutation(M)
   ├─ relation R
   └─ propagate(R, M) → list of BaseOp
```

Each operator contributes its per-operator semantics (described below). Propagation terminates at `TableReferenceNode`s, each of which receives a fully-resolved per-base operation. The complete list of base operations executes atomically within the statement's transaction. If any operation fails (constraint, conflict resolution, store error), the entire statement aborts under the prevailing conflict-resolution mode.

The single entry point `propagate(ctx, view, req)` classifies the body and routes it: a decomposition-backed logical table (a module advertisement, no override) goes to the advertisement-driven fan-out; a single-table body to the single-source spine; a join body to the multi-source walk. All three share **one** plan-node backward-walk consumer that plans the body once and reads its threaded `updateLineage` for column→base routing — none re-walks the projection AST.

### Schema resolution during write-through

Decomposing a write re-plans the view body, and that re-plan uses the **view's own home-schema path** (its schema first, then the database default path — `Database._homeSchemaPath`), exactly as a read through the same view does; see [Schema § Stored bodies resolve against their home schema](schema.md). So a write through a view binds the same base tables its read binds, under any session `pragma schema_path` and any statement-level `with schema`. Only the stored body moves: the writing statement's own `where` / `set` / `returning` expressions and the `insert … select` source keep resolving on the caller's path.

The gate swaps the whole naming environment, not only the path: the body also plans with the caller's CTE definitions cleared, so `with t as (…) update v set …` cannot bind the caller's `t` in place of a base table the body reads (`planner/stored-body-context.ts`). Before that, such a write did not merely read the wrong rows — it failed outright with `view body operator 'CTEReference' is not updateable in phase 1`, because a CTE reference is not decomposable.

A CTE-name or inline-subquery DML target (`with c as (…) update c …`, `update (select …) as v …`) is **not** a stored object — it is part of the caller's statement — so its body keeps the caller's path verbatim. The single gate for both cases is `bodyPlanningContext(ctx, view)` in `planner/mutation/body-context.ts`.

The gate above covers the body **plan**. It cannot cover the body-derived fragments the lowering *copies* into the base statement — the view's own `where`, each column's base-term expression, an authored `with inverse` put expression, a `with defaults` value — because the lowered statement is a **mix** of caller-authored clauses and definition-derived fragments planned on one context (`buildBaseOp`, on the caller's). No single context is right for it, so the resolution decision is made **per fragment** and rides the AST node:

- `buildViewMutation` — the single funnel every view-mediated write passes through — deep-clones the stored body and stamps every **nested** sub-select root with the body's whole naming environment (`AST.StoredBodyEnv`, on `AST.SelectStmt.storedBodyEnv`), via `mapNestedSelects` in `planner/mutation/scope-transform.ts`. The clone matters: the schema's stored `selectAst` is never mutated. The top-level root is not stamped (it is the body, already planned under `storedBodyContext`); compound / union legs are, so a set-operation spine's per-branch synthetic view-likes inherit the marker.
- `buildSelectStmt` honours the marker at the top of the build, through `enterStoredBodyEnv` (`planner/building/select-context.ts`): it re-enters the home naming environment via `storedBodyContext` **and** replaces the explicit `parentCTEs` argument. Replacing it is load-bearing, not belt-and-braces: `buildExpressionPositionQueryExpr` passes the caller's `ctx.cteNodes` in as an explicit argument and `buildWithContext` prefers a non-empty explicit argument over `ctx.cteNodes`, so clearing the context alone still lets a caller `with` clause bind a body sub-select's source.
- `PlanningContext.storedBodyOf` (stamped by `storedBodyContext`) makes the marker inert while the body *itself* is being planned — that context already is the home environment, and re-swapping would clear the body's own `with` clause.

The environment is **one object with three pieces**, not three parallel markers, because they are always stamped together, always consumed together, and their consumption order is load-bearing. Each rides the body's *top-level* `SelectStmt`, which is never itself one of the copied pieces — so without the carry a fragment sees none of them:

| piece | what it carries | consumed |
| --- | --- | --- |
| `homeSchema` | the view's schema name | step 1 — `storedBodyContext(ctx, homeSchema)`: home path, caller's CTE namespace cleared |
| `schemaPath` | the body's declared `with schema` path, if any | step 2 — overrides the home path |
| `withClause` | the body's own leading `with` clause, if any | step 3 — built on the result of steps 1–2 (`buildStoredBodyCTEs`, `planner/building/select-context.ts`) as the fragment's parent CTE namespace |

Step 4 is the fragment's **own** `with schema` clause (`stmt.schemaPath`), which still outranks the carried path. Steps 2 and 3 are ordered that way so a *carried block's* own `from` sources resolve on the declared path, exactly as they do on the read path — reversing them fails inside `buildStoredBodyCTEs`. The declared path is applied in `buildSelectStmt` rather than folded into `storedBodyContext`: that function is shared with the read path, takes only a schema name, and has no access to the body AST (on the read path the body's top-level node applies its own `schemaPath` already).

Carrying the `with` clause (step 3) is what keeps a copied fragment that reads a body-local block bound: without it a write through `create view v as with c as (…) select … from a where id in (select id from c)` either failed with `Table 'c' not found` or, when a *real* table `c` existed, silently bound that table instead and wrote zero rows while the read of the same view returned them. Carrying the declared path (step 2) is the same failure one level out: a body ending in `with schema "temp", main` resolved its own FROM sources fine (the body statement carries `schemaPath` into its own plan) but a sub-select the lowering copied out of it did not, so the write failed with `Table 't' not found in schema path: <home>` where the matching read succeeded — and the diagnostic's "add 'temp' to your WITH SCHEMA clause" hint was misleading, since the definition already named it. The fragment's own `with schema` clause still wins over the carried one.

All fragments of one lowering share **one** plan node per body-local block, via a per-lowering memo `buildViewMutation` puts on the context (`PlanningContext.storedBodyCTECache`, keyed by the `with` clause AST object). The multi-reference advisory then marks that node `materialize`, so the block is evaluated once per statement — matching the read, and keeping a non-deterministic block from disagreeing between fragments. The `with` clause's own definitions are cloned *unstamped* (`rebuildSelect` does not descend into it): their sub-selects are already built under the home environment.

A body whose `with` clause defines a **data-modifying** block (`with m as (insert … returning …)`) is rejected up front on every write with `unsupported-body-cte-dml`, and `view_info` reports the conservative all-`NO` row for it. Reading such a view already executes the insert per read; carrying the definition would make a write execute it too, and the shared plan node makes a two-fragment reference fail inside the runtime.

A plain column reference never needed any of this: the lowering has already rewritten it to a resolved base column by the time the fragment is copied.

An **ephemeral** target is deliberately left unmarked, mirroring `bodyPlanningContext`'s ephemeral guard — its body is part of the caller's statement, so its sub-selects keep the caller's path and the caller's CTEs. The writing statement's own sub-selects (a user `where … in (select …)`, an `insert … select` source) are never marked and are unaffected.

A set-operation body's non-leading legs need a related but distinct carry: the parser attaches a trailing `with schema` clause to the whole compound but parses it onto the **leading leg's** statement node only (`isCompoundSubquery` suppression in `parser/parser.ts`), so every other leg's branch **body** (not its fragments — the marker above covers those) would otherwise plan on the view's plain home path instead of the declared one. `planner/mutation/set-op.ts`'s `withDeclaredPath` stamps the compound's declared path onto a leg body that has none of its own, right after the leg is unwrapped from its operand AST (`buildBranch` for the membership route, `flaglessShape` for the flag-less literal-discriminator route) — a nested sub-compound's own clause still outranks the carried one, and a definition with no clause at all is untouched.

Two related defects at the same symptom but different code sites remain open: a body lineage sub-select that qualifies its correlation with the base table's *name* (`fix/bug-view-write-lineage-subquery-base-table-qualifier`); and the shadow-analysis pass that sizes up a fragment's `from` sources against one fixed schema (`fix/bug-view-write-subquery-shadow-analysis-wrong-schema`).

### Identifying Predicates

Updates and deletes carry a **row-identifying predicate** built from base-table primary keys traced through the lineage. For a relation whose lineage proves `(b1.pk, b2.pk, ...)` is a superkey at the top, the row-identifying predicate is the equality on those PKs. The propagation pass uses this predicate to bind the per-base operations to specific underlying rows.

Inserts carry an **existence predicate** constructed from the inserted column values: `c1 = v1 ∧ c2 = v2 ∧ ...`. The predicate is symbolic — values may be expressions, parameters, mutation-context bindings, or `default`. It drives branch dispatch at every n-ary operator and supplies values for missing columns via equivalence-class lookup.

### Branch Consistency

When propagation reaches an n-ary operator, it evaluates each branch's accumulated predicate (the conjunction of every selection on the path from this operator to a base table) against the mutation's predicate using the same predicate-normalizer and FD/EC pipeline the optimizer uses:

- **Provably consistent**: the mutation fans out to that branch.
- **Provably inconsistent**: the branch is skipped.
- **Unknown**: the branch is included. The engine prefers honest fan-out over silent suppression.

## Per-Operator Semantics

Moved to [Per-Operator Semantics](vu-operators.md#per-operator-semantics). Set-operation membership columns and writes moved to [Set-Operation Membership](vu-setops.md).

## Scalar Invertibility

Moved to [Scalar Invertibility](vu-inverses.md#scalar-invertibility).

## Authored inverses (`with inverse`)

Moved to [Authored inverses (`with inverse`)](vu-inverses.md#authored-inverses-with-inverse).

## View defaults

Moved to [View defaults](vu-inverses.md#view-defaults).

## Tags

Moved to [Tags](vu-inverses.md#tags).

## Multi-Base-Table Mutations

A view that touches `n` base tables can emit operations against any subset in a single statement. The propagation pass aggregates the per-table operations and the statement-level executor issues them within the statement's transaction. Order of execution within the statement:

1. FK-parent operations precede FK-child operations where the dependency is provable from declared foreign keys.
2. Within an FK-equivalence class, order is unspecified.
3. All operations see a consistent pre-statement snapshot for **row identification**, realized by **eager key materialization**: a both-sides `update` — and a lenient multi-side `delete` fanned out to both candidate sides — captures each affected view row's base-PK identities once, before any base op fires, and routes every per-side op through that captured set (§ [Inner Join](vu-operators.md#inner-join)). The first op therefore cannot rewrite a predicate column — or, for the delete, empty the join — out from under the second op's row identification; both ops target the same pre-mutation set regardless of execution order (and an FK cascade that removes a row early is a silent predicate-scan no-op, not a double-delete).

Constraint enforcement runs at end-of-statement under the prevailing conflict-resolution mode (see [Conflict Resolution](sql-dml.md#conflict-resolution-or-clause)). Deferred CHECKs run at commit per the assertion framework. `Statement.getChangeScope()` (see [Change-scope Documentation](change-scope.md)) reports the union of all base-table operations a prepared statement may emit, providing accurate dependency information for reactive consumers even when the statement targets a complex view.

## Cycles, Self-Joins, Recursive Composition

**Self-joins.** A view that joins `t` to itself produces lineage referencing `t` under two distinct alias-bound update sites. Updates and deletes route per-alias; the engine executes the per-alias operations sequentially, each observing the previous one's effects. Cycles in update propagation (a → b → a via a self-join with mutual references) are detected at plan time and resolved by serializing in alias-declaration order.

**Recursive composition.** Views composed of views are flattened at planning time; propagation operates on the fully-inlined plan. A view whose body references itself (recursive CTE) is read-only.

**View update of a view's base table while the view is open.** Quereus's async iteration model captures a consistent snapshot per cursor (see [Memory Vtab Documentation](memory-table.md)); mutations through a view do not perturb concurrent reads of that view.

## Interaction with Constraints

- **`check` constraints** on base tables apply unchanged to base operations emitted by view mutations. A view selection predicate `σ_p` does *not* become a CHECK constraint — predicates are read-time filters, not write-time invariants. Users who want the converse (reject writes that would carry a row outside the view) attach the predicate as a base-table CHECK or a global `create assertion`.
- **`create assertion`** invariants enforce at commit time across the entire database, including any state produced by view-mediated mutations. This is the supported replacement for `with check option`: it composes across views, contributes premises through the [assertion-derived-premises](optimizer-fd.md#assertion-derived-premises) pipeline, and runs incrementally via `DeltaExecutor`.
- **Foreign keys** with `on delete` / `on update` cascades fire on the base operations emitted by propagation, not on the view-level mutation. A view-mediated delete that emits two base deletes triggers each base's cascade independently.
- **Generated columns** are `computed` lineage; they are read-only at every level. Writes to generated columns through any view are rejected.
- **Conflict resolution (`or` clauses)** applies per base operation. A view mutation with `or ignore` ignores constraint violations on each emitted base operation independently. `or rollback` aborts the enclosing transaction at the first violation, regardless of which base operation triggered it.

## `returning` Clauses

`insert`, `update`, and `delete` through a view support `returning`. The returned rows are projected through the **view's** column list, not the base tables'. The engine evaluates the view body against the post-mutation state to produce returning rows — equivalently, against the captured per-operation results, since the view's lineage maps base rows back to view rows. `returning` columns of `computed` lineage (a view-level computed expression) are evaluated against the post-mutation base values. `returning *` expands to the view's column list. When a `returning` clause is present, `ViewMutationNode` is **relational** — its row type / attributes are the view's projected columns. Two mechanisms realize it:

**Single-source.** The clause is rewritten into base terms — each view-column reference substituted to its base-term lineage, the user's view-spelling preserved as the result-column name — and attached to the rewritten base statement, so the base op's own RETURNING machinery yields the rows. Unqualified columns bind to NEW for insert/update and OLD for delete, so the result is the post-mutation (or, for delete, the deleted) view image; computed view columns re-evaluate against those base values. This is robust against an update that changes a predicate column (it reads NEW/OLD, not a re-query). MV write-through inherits it verbatim.

**Multi-source** (n-way join) `update` / `delete`. The view row spans multiple base tables, so it is not recoverable from the per-side base ops. The mechanism is threaded as `ViewMutationNode.returning` with a `returningTiming`:

- **`delete`** (`pre`): the OLD view image restricted to the mutation's predicate, projected as **plan nodes in base terms over the already-planned `JoinNode`** — `π_{<returning, view-spelled, recomputed from base columns>}( σ_{idPredicate}( JoinNode ) )` — captured **before** the base ops fire (the rows still match the predicate and are about to disappear). Recomputing each view-spelled column from its base term (rather than referencing the body root's output attribute id) is what lets a body-computed column (e.g. `c.note || '!' as banner`) survive: project-merge collapses the computed projection's intermediate attribute id, so a by-id reference would dangle.
- **`update`** (`post`, with an `identityCapture`): each affected view row's **base-PK identities** (every side's PK columns, flattened to `k<side>_<j>`) are captured **before** the base ops fire, built as plan nodes over the already-planned join body and materialized into a shared descriptor (the same working-table-in-context plumbing recursive CTEs and the insert envelope reuse). **After** the base ops, the same planned `JoinNode` is re-queried, projecting the view-spelled base-term RETURNING columns restricted to those captured identities by a correlated EXISTS. The EXISTS is **preserved-keyed**: a *preserved* side matches by exact per-PK-column equality (`k.k<p>_<j> = s<p>.pk<j>`), while a *non-preserved* (outer-join null-extended) side uses a matched-OR-null disjunction `(AND_j k.k<np>_<j> = s<np>.pk<j>) OR (AND_j k.k<np>_<j> is null)`. The matched branch finds a row whose non-preserved partner already existed pre-mutation; the null branch (the non-preserved PK was captured NULL — no partner) identifies the row by its preserved-side equalities **alone**, so a **freshly-materialized null-extended row** (an [outer-join non-preserved-column update](vu-operators.md#outer-joins) that minted a partner) surfaces instead of being silently dropped by a `NULL = <minted pk>` match. The same null branch fixes a latent partial-set bug: a **preserved-side update touching a still-null-extended row** is likewise recovered (its captured non-preserved PK is null). SQL three-valued comparison keeps the two branches disjoint (a null `k` value makes the matched-branch equality not-true), so no `is not null` guard is needed; for an all-preserved (inner) join every side is exact equality, byte-identical to the prior behavior. Because the match is on captured **identity** (not the now-stale user predicate), this is robust against an update that **rewrites a column its own WHERE filters on** — and a row the update pushed out of the view's filter is still returned (matching single-source NEW semantics). Composite-PK sides are supported (the capture and EXISTS carry one column per side per PK column); a RETURNING update requires each side to have a primary key (a keyless side is rejected with `unsupported-join`). The same capture also drives a both-sides update's per-side base ops, so a both-sides update *with* RETURNING materializes it exactly once.

An update that changes a **base PK** or the **join-key / FK** column determining which rows join breaks the captured identity, so such a matched row drops from RETURNING (these columns are generally not writable through the supported view shapes); the single-source path has no such limitation (it reads NEW/OLD). RETURNING on an **existence-flag write** (`set hasB = …`) stays rejected with `returning-through-view`: `set hasB = false` deletes the matched non-preserved partition, leaving the captured (non-null) non-preserved PK pointing at a now-null-extended row that neither disjunction branch recovers — genuinely unrecoverable by captured identity. Multi-source (join) **insert** RETURNING — which would need the minted shared surrogate threaded into the projection — and RETURNING through a decomposition-backed logical table are likewise not yet supported (rejected with `returning-through-view`).

## Mutation Context

Moved to [Mutation Context](vu-mutation-context.md#mutation-context).

## Diagnostics

When propagation cannot proceed, the engine raises a `QuereusError` whose `details.mutationDiagnostic` is a structured record:

```typescript
interface MutationDiagnostic {
  reason:
    | 'no-inverse'                      // scalar function with kind: 'opaque' on update path
    | 'unknown-view-column'             // a top-level where/set/returning ref names something that is not a column of the view (the encapsulation-scope guard)
    | 'no-default'                      // not-null column with no recoverable value on insert
    | 'recursive-cte'                   // recursive CTE in mutation target
    | 'aggregate-target'                // aggregate-shaped column written
    | 'null-extended-create-conflict'   // outer-join insert supplies only non-preserved columns (no preserved anchor), OR a non-preserved-side update's null-extended materialization insert leaves a not-null-without-default base column unset
    | 'unsupported-outer-join-update'    // update of a non-preserved outer-join column with no preserved anchor to key the materialization (a FULL outer join, or a non-preserved side related to no preserved side by an equi-join key) — the LEFT-anchored case is shipped
    | 'default-target-not-found'        // a `with defaults (col = expr, …)` entry names a column that is neither a view nor a base column
    | 'mutual-fk-restrict-delete'       // two-side join DELETE fan-out over a mutual FK whose ON DELETE actions no side order can satisfy under immediate enforcement
    | 'conflicting-assignment'          // two SET targets lower to the same base column
    | 'unsupported-body-cte-dml'        // the view body's own WITH clause defines a data-modifying block (`with m as (insert … returning …)`) — the lowering carries the body's definitions into the base statement and cannot carry a DML one
    | 'predicate-contradiction';        // statement's predicate is unsatisfiable
  planNodeId: number;
  column?: string;
  table?: string;
  suggestion?: string;
}
```

An UPDATE that assigns the same base column twice — directly (`update t set b = 1, b = 2`), or via two view columns that lower to one base column (`update v set b = 5, bp = 100` over `select id, b, b + 1 as bp`) — is rejected **unconditionally**: there is no value-agreement softening (`set b = 5, b2 = 5` still rejects), since value equality of arbitrary expressions is undecidable. Enforcement is layered. The base UPDATE builder is the authoritative backstop: every lowered statement (direct base UPDATE, the single-source lowering, and each multi-source per-side / decomposition per-member lowering) is re-planned through it, and it rejects a repeated SET target with a generic `duplicate assignment to column '<col>'`. On top of that, the single-source and decomposition spines detect the collision *during lowering* and raise `conflicting-assignment` naming **both** colliding view columns — a friendlier message. The multi-source join spine relies on the base backstop (it sees only base names anyway).

The INSERT family is guarded by the same reject-unconditionally rule, also layered. An `on conflict do update set b = 1, b = 2` is caught by a name-based `seenTargets` set in upsert-clause building (this path never routes through the base UPDATE builder, so it carries its own backstop). An explicit duplicate INSERT column list (`insert into t (a, a) …`) is caught up front in `buildInsertStmt`. That same column-list guard is the single authoritative backstop for the INSERT analogue of the multi-source collision: every view INSERT spine (single-source, multi-source join, decomposition) re-plans through `buildInsertStmt` with an explicit base-column list, so two view columns that lower to one base column land a duplicate there and are rejected — naming the **base** column.

Diagnostics include a suggestion when one applies — for instance, a missing shared-key default includes a `DEFAULT`-declaration recipe ready to copy. `query_plan().properties` includes the per-column `updateLineage` summary so the user can inspect propagation behavior without issuing a mutation.

## Information Schema Surface

The SQL-standard intent is `information_schema.views`. Quereus has no `information_schema` namespace and no registered `sqlite_schema` — every introspection surface is a **table-valued function** (`schema()`, `table_info(name)`, `foreign_key_info(name)`, …). The engine-idiomatic realization of `information_schema.views` is therefore a TVF in that same family:

```sql
view_info()          -- one row per plain (non-materialized) view, all schemas
view_info('my_view') -- the single matching view (optional name filter)
```

Each row exposes the per-view propagation summary (`'YES'` / `'NO'` text to match the SQL-standard convention):

| Column | Meaning |
|---|---|
| `schema` | schema name (`main`, `temp`, …). |
| `name` | view name. |
| `is_insertable_into` | `'YES'` if every `not null`-without-declared-default, non-generated base column of every reachable base has a recoverable value — projected, or a recoverable default (constant-FD selection pin / declared base default / view-declared insert default). |
| `is_updatable` | `'YES'` if at least one output column has `base` lineage. Per-column updateability is exposed by the companion `column_info(name)` TVF. |
| `is_deletable` | `'YES'` if the row-identifying predicate is constructible at every base reachable from the view — operationally, every reachable base's PK columns are exposed through `base` lineage. |
| `effective_targets` | JSON array of base-table names that mutations through the view may touch by default (`'[]'` when none). |

**Static derivation, not a dry run.** Every column is derived statically from the planned view body's backward `updateLineage` / `attributeDefaults` plus the base-table not-null/default/generated flags — `view_info()` never executes a probe mutation. The body is planned *logically* (preserving the Project/Filter/Join/TableReference operator tree that threads `updateLineage`), the same way the view-mutation substrate plans it, so `effective_targets` agrees with the base set `propagate()` reaches. The substrate's dynamic `propagate()` is the authoritative check; the static surface is the conservative reading — a body whose lineage is not yet threaded (VALUES / aggregate / set-op / recursive-CTE / wholly-computed) yields the conservative all-`NO` / `'[]'` row, never an error — and gains accuracy as later phases thread more lineage, with no rework here.

**Outer-join contract.** A decomposable equi-join body — `inner` / `left` / `right` / `full`, the shape `propagate()` decomposes (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`; composite-PK sides and self-joins included) — is read **per-side** from each column's `null-extended` lineage plus a preserved-anchor check, *not* gated wholesale. A **LEFT or RIGHT** outer join is partially writable: every preserved-side base column is `is_updatable = 'YES'`, and a non-preserved (null-extended) column is `'YES'` too — a preserved anchor pins each row's identity for the matched-update / null-extended-insert materialization — so the view is `is_insertable_into` / `is_deletable`. A **FULL** outer join has no preserved side (every row is null-extended on some side), so there is no anchor to key a materialization off: it self-conservatizes to the all-`NO` / `'[]'` row, as does a LEFT/RIGHT body that projects away its entire preserved side. A non-decomposable shape (cross / comma / subquery- or function-source join, or a non-join body) likewise reports the conservative row. `propagate()` is the authoritative dynamic check and the static surface agrees with it per-side (reporting `'YES'` where a write is accepted, `'NO'` where it rejects). (Insert-default recovery is honored from a view's own `with defaults (…)` clause.)

Materialized views are **not** enumerated: a maintained table lists as a *table* in `schema()` (one catalog name, one `TableSchema`), so `view_info()` — walking `getAllViews()` — stays plain-view-only. Its per-column write-through lineage surfaces through `column_info(name)` instead (below), which walks the derivation body with the same classification, so the two functions tell one consistent story.

### Per-column updateability — `column_info(name)`

`information_schema.columns.is_updatable` — per-column updateability for every view, base table, *and* maintained table (materialized view) — is the engine-idiomatic companion to `view_info()`: `view_info : schema()` :: `column_info : table_info`. It takes a **required** target (a base-table or view name) and emits one row per output column:

```sql
column_info('my_table')  -- one row per base-table column
column_info('my_view')   -- one row per view output column
column_info('my_mv')     -- one row per maintained-table column (derivation-body lineage)
```

| Column | Meaning |
|---|---|
| `schema` | schema name the object resolved in. |
| `name` | the table / view name. |
| `cid` | column ordinal (0-based). Base table: column index. View: output-attribute index. |
| `column_name` | the column's output name (the view's alias spelling for a renamed column). |
| `is_updatable` | `'YES'` if a write to this column propagates to a base column (a `base` `UpdateSite`); `'NO'` if read-only (computed / generated / un-threaded lineage). |
| `base_table` | owning base-table name for an updatable column; `null` for a read-only column. |
| `base_column` | owning base-column name for an updatable column; `null` for a read-only column. |

**Static derivation.** For a **base table**, a column is updatable iff it is not `generated` — `base_table`/`base_column` are the column itself. For a **view**, the body is planned *logically* (the same path as `view_info()`) and each output attribute's backward `updateLineage` site is read: a plain `base` site resolving to its producing `TableReferenceNode` is `'YES'` with its base trace; everything else (`computed`, un-threaded, or a site that fails to resolve) is `'NO'` with `null` trace. Every `is_updatable='NO'` row carries `null` `base_table`/`base_column`.

`column_info` shares `view_info`'s gates and reads the same per-column `null-extended` lineage: a non-decomposable join shape — cross / comma (implicit) / subquery- or function-source — short-circuits to all-`NO`/`null` via a non-throwing AST shape check (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`), while a decomposable `inner` / `left` / `right` / `full` equi-join (n-way `≥ 2`, composite-PK sides and self-joins included) reports per-side. For a LEFT/RIGHT outer join both the preserved and the non-preserved columns are `'YES'` (the preserved anchor pins identity for the materialization); a FULL join, having no preserved anchor, self-conservatizes to all-`NO`. The two surfaces agree with each other and with the dynamic truth. The `'YES'`/`'NO'` text encoding matches `information_schema.columns.is_updatable` — deliberately **not** `table_info`'s integer `0`/`1`.

A **materialized view** — a maintained table, i.e. a `TableSchema` carrying a `TableDerivation` (detected structurally, never by name pattern) — resolves through the base-table lookup but is *not* reported as plain writable base columns: write-through inherits these view-updateability rules, so `column_info` walks its **derivation body** through the same lineage classification as a plain view. Passthrough/rename columns report `'YES'` tracing to their *source* base column, invertible expressions report `'YES'` through the inverse, and non-invertible expression columns report `'NO'`/`null` ([Materialized Views § Write boundary](materialized-views.md#write-boundary-write-through)). The table's registered columns supply the authoritative output names; a derivation body that fails to plan (e.g. stale source) degrades to conservative all-`'NO'` rows over the registered columns. A dedicated TVF rather than a `table_info` extension keeps base-table introspection decoupled from view-body planning: `table_info` resolves base tables only and carries per-column metadata a view has none of, whereas `column_info` resolves either kind uniformly and emits only the column-granular updateability facts.

## Round-Trip Laws and the Derived Backward Walk

Moved to [Round-Trip Laws and the Derived Backward Walk](vu-roundtrip.md#round-trip-laws-and-the-derived-backward-walk).

## Implementation Map

No new subsystem is introduced — view updateability is the existing FD / EC / predicate-normalization infrastructure consulted in the mutation direction: lineage parallels FDs, propagation parallels emission, view metadata parallels table metadata. The principal source files:

| Concern | Location |
|---|---|
| `updateLineage` / `attributeDefaults` on `PhysicalProperties`; threaded as `computePhysical` overrides on TableReference / Project / Filter / Join, passed through access / Retrieve / Alias boundary nodes | `src/planner/nodes/plan-node.ts` |
| Backward-walk helpers (`deriveProjectUpdateLineage` / `deriveFilterAttributeDefaults` / `deriveJoinUpdateLineage`), the AST-level `deriveViewColumns`, the shared n-way per-site reader `resolveBaseSite` | `src/planner/analysis/update-lineage.ts` |
| Authored-inverse (`with inverse`) build-time validation (`validateAuthoredInverses`) + the validated `new.*` index reader the lowering spines share | `src/planner/analysis/authored-inverse.ts` |
| Law-gated `InvertibilityProfile` registry (`classifyInvertibility`) + recursive inverse-chain composer (`traceInvertibleColumn`) | `src/planner/analysis/scalar-invertibility.ts` |
| Predicate-honest complement (`viewComplement` / `complementOf`) | `src/planner/analysis/view-complement.ts` |
| Single propagation entry (`propagate`, `classifyViewBody`) routing single-source / multi-source / decomposition | `src/planner/mutation/propagate.ts` |
| The one schema-path gate every body re-plan goes through (`bodyPlanningContext`) — home path for a stored view/MV, the caller's path for an ephemeral CTE / subquery target | `src/planner/mutation/body-context.ts` |
| The one scope-aware column-substitution primitive all backward callers share (`transformExpr`, `collectFromColumnNames`, `transformScopedExpr` / `transformScopedQuery` via a `ScopeContext`) | `src/planner/mutation/scope-transform.ts` |
| Single-source projection-and-filter rewrite (`rewriteViewInsert/Update/Delete`, `analyzeView`) | `src/planner/mutation/single-source.ts` |
| Shared plan-node backward-walk consumer (`analyzeBodyLineage`) — plans a body once, reads `updateLineage` into column→base routing | `src/planner/mutation/backward-body.ts` |
| Two-table inner-join decomposition (`analyzeJoinView`, `decomposeUpdate`/`decomposeDelete`, `buildMultiSourceKeyCapture`, `analyzeMultiSourceInsert`) | `src/planner/mutation/multi-source.ts` |
| n-way decomposition put fan-out (DELETE/UPDATE/INSERT) | `src/planner/mutation/decomposition.ts` |
| Shared-surrogate envelope scan leaf | `src/planner/nodes/envelope-scan-node.ts`, `src/runtime/emit/envelope-scan.ts` |
| `mutation_ordinal()` per-row context primitive (the surrogate-default building block) | `src/func/builtins/mutation.ts` (read off `RuntimeContext.mutationOrdinal`, set by the insert executor + envelope) |
| `ViewMutationNode` wrapper + builder (`buildViewMutation`, `buildMultiSourceInsert`, `buildMultiSourceReturning`) | `src/planner/nodes/view-mutation-node.ts`, `src/planner/building/view-mutation-builder.ts` |
| Base-op issue order + envelope materialization + RETURNING surfacing | `src/runtime/emit/view-mutation.ts` |
| `InvertibilityProfile` type, built-in registry, UDF hook | `src/func/invertibility.ts` |
| `ViewSchema.effectiveTargets` / `defaultsForColumn` (populated at view creation) | `src/schema/view.ts` |
| `view_info()` and `column_info(name)` TVFs | `src/func/builtins/schema.ts` |

## Background

Quereus's view updateability draws on the following bodies of work:

- **Bancilhon, F., & Spyratos, N. (1981). "Update Semantics of Relational Views."** Established the constant-complement framework. Quereus sidesteps the ambiguity by adopting predicate-honest fan-out: rather than choosing one of several legal complements, Quereus applies every consistent base operation.
- **Date, C. J., & Darwen, H. (2006). "Databases, Types, and the Relational Model: The Third Manifesto."** The principle that any relation expression should be a first-class mutation target underpins the unification of views, CTEs, and subqueries-in-`from` as the same propagation surface.
- **Keller, A. M. (1985). "Algorithms for Translating View Updates to Database Updates for Views Involving Selections, Projections, and Joins."** Source of the per-operator decomposition strategies, adapted here to use functional dependencies rather than per-view annotation.
- **Bohannon, A., Pierce, B. C., & Vaughan, J. A. (2006). "Relational Lenses: A Language for Updatable Views."** Types `select` / `project` / `join` lenses with FD-and-predicate annotations and proves GetPut / PutGet *compositionally, per operator*. Directly on point for Quereus's FD-annotated operators, and the basis for the discipline in § Round-Trip Laws: the backward (`put`) direction is a *derived, law-checked* dual of each operator's forward FD walk, never a parallel hand-maintained walk. See also Foster et al. (2007) in [the lens layer's background](lens.md#background).
- **Voigtländer, J. (2009). "Bidirectionalization for Free!"** Source of the committed north-star: mechanically deriving `put` from `get`. Quereus authors every operator's backward method as a get→put derivation now, so the eventual mechanical derivation is a refactor behind the same round-trip law.
- **Dataphor (Alphora, D4 language).** The closest commercial precedent. Quereus borrows the per-view default-annotation idea (realized first-class as the `with defaults` clause) and the view-as-first-class-target stance; it extends the model with FD- and EC-driven default recovery, eliminating most cases where a Dataphor user would have annotated.
- **Litak, T., & Mikulás, S. (2012). "Relational Lattices."** Algebraic framework over the relational lattice. Quereus's propagation rules read as the lattice-dual of the optimizer's query-rewriting rules.
- **Hegner, S. (2004). "An Order-Based Theory of Updates for Closed Database Views."** Influential on the outer-join materialization semantics.

## Departures from SQL Standard

| Standard Feature | Quereus | Rationale |
|---|---|---|
| `with check option` | Not supported. | Replaced by `create assertion`, which composes across views and runs incrementally. |
| `with read only` | Not supported. | Inferred per-column from lineage; no view-level read-only flag. |
| Updateable-view restrictions (key-preserved tables, etc.) | Not enforced as a separate ruleset. | The FD framework subsumes these — views are updateable iff FD-driven propagation succeeds. |
| `instead of` triggers | Not supported (no trigger system). | Tags provide the override surface; predicate-driven dispatch handles the cases that motivate `instead of`. |
| Per-dialect updateability rules (Oracle key-preserved, PostgreSQL simple views, SQL Server schema-bound) | A single uniform rule. | Reduces the user's mental model to "predicates rule, FDs trace lineage". |

## Current limitations

The following shapes are rejected at plan time with a structured diagnostic; they are not yet wired into the propagation substrate:

- **Non-preserved-side outer-join update** — **now shipped for LEFT joins**: an UPDATE of a non-preserved column splits per row into a matched UPDATE + a null-extended-materialization INSERT, both riding the pre-mutation `__vmupd_keys` capture (see [Outer Joins](vu-operators.md#outer-joins)). Still deferred: a non-preserved-**only** insert (`null-extended-create-conflict`); a non-preserved update through a **full outer join**, whose every-side-null-extended shape has no preserved anchor to key the materialization (`unsupported-outer-join-update`, surfaces report it conservative); a **composite** non-preserved join key, which the single-column materialization insert cannot re-join (`unsupported-outer-join-update`); **RETURNING** through a non-preserved-side update, which the captured-identity re-query cannot recover for a materialized null-extended row (`returning-through-view`, owned by `view-write-outer-join-nonpreserved-returning`). **RIGHT joins are now write-through-able** — the exact per-side mirror of LEFT (`view-write-right-join-readmit`), admitted into recognition and reported per-side by the static surfaces; only **FULL** stays conservative (no preserved anchor, as noted above for the full-outer non-preserved update).
- **Cross-source `set` values** — an inner-join `update` value that reads a partner-side **`base`** column (`update v set a.x = b.y`, or a scalar expression whose cross-source leaves are all `base`) is **now supported**: the read column rides the `__vmupd_keys` capture under a `srcN` alias and the reference is rewritten to a correlated read keyed by the owning side's PK (the pre-mutation partner value — robust to a both-sides update that also rewrites it). Still rejected: a cross-source value whose **assigned side joins more than one partner row** — the 1:many direction, where the join does not pin a unique key of the partner table (`cross-source-ambiguous-cardinality`, a plan-time reject naming the ambiguity rather than the runtime `Scalar subquery returned more than one row`; multi-hop owner↔partner is conservatively included); a cross-source value reading a **`computed`** (non-base) partner column (`no-inverse`); a cross-source `set` through an **outer** join that reads a non-preserved (null-extended) partner column (`no-inverse` — the partner value is not recoverable from a captured base column); and a cross-source (cross-member) `set` in the **decomposition** fan-out (`cross-source-assignment` — its single-member-table SET cannot express the partner read).
- **Composite shared-key `insert`** — the shared-surrogate envelope threads a single-column key, so an n-way insert whose shared join key spans multiple columns on a side is deferred (`unsupported-decomposition-key`). Composite-PK *identification* (the update/delete capture path) is supported; only the insert envelope's shared key stays single-column.
- **Multi-parent shared-key outer `insert`** — a single shared-key column that references **more than one** presence-gated (optional, outer-joined) parent (`cc.pr references p1(pp) references p2(qq)`, both LEFT-joined and supplied) is deferred (`unsupported-decomposition-key`, detected statically as `keyGate.groups.length >= 2`). One key value cannot satisfy two FK constraints for a partial-supply row — the AND-gate would null the whole key, silently losing the supplied value and orphaning the present parent — so the shape is rejected rather than threaded as a broken AND-gated key (`view-write-outer-insert-shared-key-multi-parent-orphan`). The n-way generalization (per-parent key columns) is future work.
- **Multi-source (join) `insert` RETURNING** — needs the shared key threaded into the RETURNING projection; rejected with `returning-through-view`. RETURNING through a decomposition-backed logical table is likewise rejected.
- **Authored-inverse (`with inverse`) routing gaps** — a multi-source (join) **insert** through an authored column is deferred (the shared-surrogate envelope projects supplied columns verbatim per side; per-row put evaluation over it is a follow-up — `no-inverse`, naming the column); a write targeting an authored column of a **decomposition**-backed logical table is deferred (`unsupported-decomposition-member`, naming the member(s) the puts route to); a **single-source insert with a SELECT source** through an authored column is deferred (`unsupported-source` — VALUES required, the same boundary as the appended-defaults rewrite). The single-source UPDATE/INSERT and multi-source UPDATE paths are wired (§ [Authored inverses](vu-inverses.md#authored-inverses-with-inverse)).
- **Cross-member logical CHECK / FK on a decomposition `update`** — a lens-synthesized row-local CHECK or child-side FK is threaded onto a decomposition UPDATE's member fan-out only when a **single** member op resolves every write-row column it references ([per-op resolvability gate](lens.md#enforcement-by-constraint-class)). A logical CHECK / FK spanning columns on **more than one** member resolves on no single member op and is **deferred** (silently not enforced — a debug `log` traces the drop), matching the decomposition INSERT path, which also defers cross-member row-local / set-level enforcement. A single-member-resolvable CHECK / FK is enforced normally, and a set-level uniqueness CHECK rides only the op that owns the key (a key-unchanged member UPDATE provably cannot create a duplicate, so dropping it there is sound — not a limitation).
- **Aggregate / window write propagation** — read-only at the column level; reserved for the extension that consumes the [incremental-maintenance](incremental-maintenance.md) framework.
- **Recursive CTE bodies** — read-only (`recursive-cte`).
- **Composite shared keys** — the shared-key envelope threads a single-column key; a multi-column surrogate / shared key is deferred (`unsupported-decomposition-key`). (The surrogate's *value source* is now an ordinary column `default`, so non-integer / non-deterministic allocators — `uuid7()`, a custom UDF — are fully supported; only the multi-column shape remains deferred.)
- **Mechanical `put`-from-`get` auto-derivation** — the committed north-star, deferred until the operator set stabilizes; each backward method is hand-written today but shaped to fold into it behind the round-trip laws.
