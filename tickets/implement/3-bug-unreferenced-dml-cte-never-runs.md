---
description: A query can name a block that inserts, updates or deletes rows; if the rest of the query never mentions that block, the write is silently skipped, where other SQL databases would still perform it. Make the write happen.
files:
  - packages/quereus/src/planner/planning-context.ts        # add the per-statement CTE-identity memo
  - packages/quereus/src/core/database.ts                   # _buildProbeContext (~2286) — seed the memo
  - packages/quereus/src/planner/building/with.ts            # buildCommonTableExpr mints the identity; isDataModifyingCte
  - packages/quereus/src/planner/building/block.ts           # buildBlock — attach the prelude (the ONE safe site)
  - packages/quereus/src/planner/nodes/plan-node-type.ts     # new node type
  - packages/quereus/src/planner/nodes/sink-node.ts          # existing side-effect consumer, reused as-is
  - packages/quereus/src/runtime/emit/view-mutation.ts       # the sequencing precedent to copy (emitCallFromPlan)
  - packages/quereus/src/runtime/register.ts                 # emitter registration
  - packages/quereus/src/planner/analysis/change-scope.ts    # isDmlWithoutReturning must learn the new node
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic   # the zero-reference guard flips here
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts    # descriptor-sharing invariants
  - docs/runtime-caching.md                                  # § Shared CTE materialization
difficulty: hard
repro: verified
---

# An unreferenced data-modifying `with` block must still run

## What happens today

```sql
create table t (k integer primary key);
with c as (insert into t (k) values (1) returning k) select 42 as x;
```

Returns `x = 42` and leaves `t` **empty**. Verified on `main` at `ff645bee`: the optimized plan
for that statement contains no CTE node at all. Same for an outer `insert` / `update` / `delete`
that never names the block.

SQLite and PostgreSQL both perform the write regardless of whether anything reads the block — it
is a stated effect of the statement, not an optimization the engine may skip. Quereus should
match.

## Why it happens

A `with` block only enters the plan when something reads it. `buildWithClause` builds each member
and returns a name→node map; `buildFrom` (and the DML-target resolver) pull a member out of that
map when a query names it. A member nobody names is never attached to anything, so it is never
planned and never executed. For a `select`-bodied member that is exactly right. For a member that
writes rows, the write is the point.

## Expected behaviour

Executing a top-level statement whose `with` clause contains an `insert`, `update` or `delete`
member performs that member's write **exactly once**, whether or not the rest of the statement
names it. When it *is* named, nothing about today's behaviour changes.

Out of scope: a `with` clause on a *nested* statement (a sub-select's own clause, a stored view
body). PostgreSQL rejects a data-modifying `with` block anywhere but a statement's top level, so
matching top-level behaviour is the whole obligation here. Leave nested alone.

---

## Design

Two arms. The second depends on the first; do them in order.

### Arm A — one runtime identity per source `with` member

`CTENode.tableDescriptor` is the key `emitCTE` buffers a materialized CTE's rows under (see
`docs/runtime-caching.md` § Shared CTE materialization). It is minted fresh in
`buildCommonTableExpr`, so two `CTENode`s built from the *same* source member in two *separate*
builds get two descriptors and therefore two buffers — i.e. two writes.

That already happens today, and only luck keeps it invisible: `buildInsertStmt` /
`buildUpdateStmt` build the statement's `with` clause once above the view dispatch and then
`buildViewMutation` re-plans the same statement through the same builder, building it a *second*
time (the `NOTE:` at `building/insert.ts` ~line 668 spells this out). It is safe today only
because exactly one of the two node sets ends up referenced. Arm B removes that guarantee — it
deliberately builds a member a second time in order to sink it — so the identity has to become
structural first.

**Change:** memoize the descriptor per source AST member for the duration of one statement build.
Add to `PlanningContext`:

```ts
/**
 * Per-statement memo of CTE runtime identities, keyed by the source `with` member.
 * Every `CTENode` built from one member — however many times the builders re-plan
 * that member — shares one descriptor and therefore one per-execution row buffer,
 * so a data-modifying body writes once per statement execution by construction
 * rather than by nothing having re-planned it.
 */
readonly cteDescriptors?: Map<AST.CommonTableExpr, TableDescriptor>;
```

seeded (`new Map()`) alongside `cteReferenceCache` in `Database._buildProbeContext`, and read/
filled in `buildCommonTableExpr` where the descriptor is currently defaulted inside the `CTENode`
constructor. The context is spread-copied (`{...ctx}`) everywhere, so the one `Map` object reaches
every nested build, including the view re-plan and every member of a multi-source decomposition.

Keyed on the AST member **object**, not its name, so a nested statement's same-named member keeps
its own identity.

*Verified:* this arm alone is green — full `yarn test` (`9217 passing`, 0 failing) with it applied
and nothing else.

### Arm B — sink the unreferenced data-modifying members ahead of the statement

**Where.** `buildBlock` (`planner/building/block.ts`), per top-level statement, and **only**
there. Every other candidate site is wrong:

- inside `buildWithContext` / the four statement builders — they are re-entered by the view
  write-through path and once *per base member* by a multi-source view decomposition, so a
  per-builder attachment fans the sink out N times;
- after `buildViewMutation` returns inside `buildInsertStmt` — same re-entry problem, one level up.

`buildBlock` is the single entry for user statements (`Database._buildPlan` is its only caller)
and it sees both the statement AST and the finished plan.

**What.** For each `insert`/`update`/`delete` member of `stmt.withClause`:

1. Walk the built plan collecting the `tableDescriptor` of every `CTENode` in it.
2. A member whose memoized descriptor (Arm A) is absent from that set is unreferenced.
3. If any are, rebuild the clause with `buildWithClause(ctx, stmt.withClause)` — Arm A makes this
   safe: a member that *was* referenced gets a second `CTENode` sharing the referenced one's
   descriptor, hence its buffer, hence no second write — and wrap each unreferenced member's node
   in a `SinkNode` (`planner/nodes/sink-node.ts`, unchanged; it exists for exactly this).
4. Sequence those sinks **ahead** of the statement plan.

The rebuild is needed rather than reusing the original nodes because a data-modifying member may
read an earlier sibling member (`with a as (select …), b as (insert … from a …) …`), so the whole
clause has to be built in order to build one member of it.

Transitivity falls out: `with c as (insert …), d as (select … from c) select 42` leaves *both*
unreferenced, `c`'s descriptor is absent from the plan, `c` gets sunk, `d` does not — one write.

**How to sequence — not `BlockNode`.** The obvious wrapper is `BlockNode([...sinks, plan])`. It
does not work; both failures were observed on a prototype:

- **Column names are erased.** `BlockNode.getType()` returns `{typeClass: 'void'}` and it has no
  attributes, so a nested block loses the result relation's shape: `select 42 as x` came back as
  `{"col_0": 42}` instead of `{"x": 42}`.
- **The statements run concurrently.** `emitBlock` passes statements as ordinary instruction
  params, and the scheduler does not await one before starting the next (`Scheduler.runAsyncLoop`
  parks promise outputs and resolves them at the *destination*). With an outer `insert` as the
  main statement, the prelude sink's write and the main write interleaved and the run died with
  `QuereusError: No such savepoint: __stmt_atomic_2` from
  `runWithStatementSavepoints` (`runtime/emit/dml-executor.ts`).

So add a small **sequencing node** — proposed `SequenceNode` (`PlanNodeType.Sequence`) — holding
an ordered list of side-effect children plus one main child:

- `getType()` / `getAttributes()` / `estimatedRows` delegate to the main child, so a relational
  main keeps its columns and a void-DML main keeps its scalar affected-row shape;
- `getChildren()` returns `[...effects, main]`; `withChildren` rebuilds in the same order;
- its emitter follows the pattern `runtime/emit/view-mutation.ts` already documents at length:
  emit each child through `emitCallFromPlan` (a sub-program) and invoke them **sequentially** in
  `run`, awaiting each effect to completion before the next, then delegating to the main child's
  sub-program — returning its async iterable un-drained so a streaming main still streams.

`emitViewMutation`'s header comment explains why bare params cannot be used for ordering; cite it
rather than restating the argument.

**Ordering.** Effects first, statement second. The alternative (write after the statement) cannot
guarantee the write at all — a main statement abandoned early (`limit 0`) would never reach it,
and `13.6` already pins that `limit 0` must not skip a data-modifying member's write.

## Consequences to accept and write down

**The outer statement can see the write.** With the write sequenced first,
`with c as (insert into t values (1) returning k) select count(*) from t` counts the new row
(verified on the prototype: 1 → 2). PostgreSQL says sub-statements of one statement do not see one
another's effects and would answer 1. Quereus already lets the outer query observe a *referenced*
member's write (recorded in the `bug-dml-cte-executes-once-per-reference` review), so this is
consistent with the engine's existing behaviour rather than a new divergence — but it is a
divergence from PostgreSQL and belongs in `docs/runtime-caching.md`.

**`change-scope.ts` must learn the node.** `isDmlWithoutReturning` (~line 304) walks down through
single-child nodes to find the DML root and special-cases `PlanNodeType.Block`. A `SequenceNode`
has two-plus children, so the walk stops and a `with c as (insert … returning …) insert into u …`
statement would be misclassified for reactive watches. Recurse into the **main** child.

**13.6's zero-reference guard flips.** `test/logic/13.6-cte-dml-runs-once.sqllogic` § "Control:
referenced ZERO times" (the `t11` block) currently pins the *broken* behaviour — `cnt = 0` — with
a comment pointing at this ticket. It becomes `cnt = 1`, and the comment should be rewritten to
say the write is guaranteed rather than tracked-as-a-deviation.

## TODO

### Phase 1 — one runtime identity per source member

- Add `cteDescriptors?: Map<AST.CommonTableExpr, TableDescriptor>` to `PlanningContext`, documented
  as above.
- Seed it in `Database._buildProbeContext` next to `cteReferenceCache`.
- Read/fill it in `buildCommonTableExpr` and pass the result as `CTENode`'s `tableDescriptor`
  argument. Leave the constructor's `?? {}` default in place for direct construction in tests.
- Extend `test/plan/cte-dml-plan-shape.spec.ts`: two builds of the same statement AST within one
  planning context (e.g. the view write-through form, which really does build the clause twice)
  agree on the descriptor.

### Phase 2 — the sequencing node

- Add `PlanNodeType.Sequence` and `planner/nodes/sequence-node.ts` per the design above; delegate
  type/attributes/rows to the main child.
- Add `runtime/emit/sequence.ts` driving effects then main through `emitCallFromPlan`, and register
  it in `runtime/register.ts`.
- Teach `change-scope.ts`'s `isDmlWithoutReturning` to descend into the main child.
- Check whether anything else pattern-matches on plan roots or single-child chains
  (`grep -rn "PlanNodeType.Block" packages/quereus/src`) and extend it the same way.

### Phase 3 — attach it

- Export `isDataModifyingCte` from `planner/building/with.ts`.
- In `buildBlock`, per statement: collect data-modifying members, walk the built plan for reachable
  `CTENode` descriptors, and wrap in a `SequenceNode` when any member is unreferenced. Mind that
  the current `.map(...).filter(p => p !== undefined)` drops entries, so index-align against the
  statement list before filtering, not after.

### Phase 4 — tests and docs

- Flip the `t11` section of `test/logic/13.6-cte-dml-runs-once.sqllogic` to expect the write, and
  rewrite its comment.
- Add coverage for: all three writing forms unreferenced; an unreferenced member under an outer
  `insert`/`update`/`delete` (the case that crashed the `BlockNode` prototype); two unreferenced
  members in one clause; one referenced + one unreferenced member in one clause (exactly one write
  each); an unreferenced member reachable only from another unreferenced member; an unreferenced
  member alongside a *view*-targeted outer write (the `t16`/`t18` shapes, which build the clause
  two-plus times); rollback undoing a sunk write; a prepared statement re-executed 3× writing 3×.
- Confirm the result column names of a wrapped statement survive (`select 42 as x` → `x`) — that is
  the regression the `BlockNode` prototype produced.
- `docs/runtime-caching.md` § Shared CTE materialization: the identity memo, the prelude, the
  ordering choice, and the PostgreSQL divergence on outer visibility.
- `yarn lint`, `yarn build`, `yarn test`. `docs:check` is red at HEAD on `docs/schema.md`'s
  word-count ratchet — already tracked, do not re-report.
