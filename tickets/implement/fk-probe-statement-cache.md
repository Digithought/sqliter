description: Foreign-key checks and cascade actions that run row-by-row re-parse and re-plan the same tiny internal query for every affected row; cache these internal prepared statements so each shape is compiled once per database.
prereq: fk-restrict-statement-batch
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts
difficulty: medium
----

## Problem

The FK runtime issues small internal SQL statements — probes and cascade DML — via a fresh `db.prepare(sql)` per affected row, paying full parse + plan + optimize + emit each time (there is no plan or statement cache in the engine). After `fk-restrict-statement-batch` lands, the batched path avoids this entirely, but every path *outside* the batch gate still compiles per row:

- the per-row RESTRICT probe fallback (`assertNoRestrictedChildrenForParentMutation`, `runtime/foreign-key-actions.ts:403`) — self-referential FKs, mixed-action parents, FAIL/IGNORE modes, lens-routed writes;
- the transitive cascade pre-walk child scan (`assertTransitiveRestrictsForParentMutation`, `:262` — `select * from child where fk = ?` per parent row per cascading FK);
- cascade actions themselves (`executeSingleFKAction` — one `DELETE`/`UPDATE ... WHERE fk = ?` compile per parent row);
- the lens RESTRICT probe (`assertNoLensChildReferences`);
- the drop-table referencing check (`schema/manager.ts` `assertNoReferencingChildrenForDrop` — once per drop, low value but same shape).

The memory-module repro for the sibling ticket measured ~0.2–0.35 ms per deleted row with FK on vs ~0.01 ms with FK off; the bulk of that gap is these per-row compiles. A cascade deleting 1000 children of 1000 parents compiles 2000+ statements.

## Design

A small per-`Database` cache of internal prepared statements, keyed by exact SQL text:

- **API**: something like `db._internalStatementCache.run(sql, params)` / `.probe(sql, params)` (probe = iterate first row only), used by the call sites above in place of `prepare → bind → iterate → finalize`.
- **Reuse semantics**: `Statement` already subscribes to schema-change notifications and recompiles lazily (`needsCompile`), so a cached statement stays correct across DDL — no bespoke invalidation needed. Verify this holds for statements held long-term (the subscription must not leak or detach).
- **Busy re-entrancy guard**: cascade recursion can re-enter while an outer cached statement of the same SQL text is mid-iteration (the transitive pre-walk iterates one statement and recurses inside the loop). If the cached statement is busy, fall back to a fresh one-shot `prepare`/`finalize` — never block, never share a busy statement.
- **Bound size**: LRU with a modest cap (e.g. 64 entries — the working set is one or two shapes per FK edge). Evicted and close-time entries are finalized; `Database.close` drains the cache.
- **Scope discipline**: only the internal FK/DDL call sites listed above adopt the cache in this ticket. It is deliberately an internal helper, not a public statement-cache feature — keep the surface `@internal`.

## Edge cases & interactions

- **DDL between executions** — create/drop an index or alter the child table between two cascading deletes; cached statement must recompile (existing Statement schema-subscription) and produce correct results. Pin with a test.
- **Recursion on the same SQL text** — a self-referential cascade chain or diamond FK graph re-entering while the outer iteration is live: busy-guard must route to a fresh statement; no deadlock, no shared cursor state.
- **Transaction boundaries** — cached statements execute inside whatever transaction/savepoint context the caller holds (same as today's fresh statements); verify a cascade inside a savepoint that rolls back leaves no stale statement state.
- **Database close with populated cache** — all cached statements finalized; no open-statement warnings/leaks.
- **Concurrent statements** — the Database exec mutex serializes top-level statements today; the cache adds no new concurrency surface, but the busy-guard is the safety net if that ever changes (leave a `NOTE:` tripwire, matching the existing one on `withFkCascadeReentry`).
- **Parameter type drift** — same SQL text bound with differently-typed values across calls (e.g. integer vs text keys from different FK edges is impossible per-key but text vs null is not): parameter re-binding must not be constrained by types inferred on first use for these internal probes.

## Validation

- Extend `test/runtime/fk-restrict-runtime.spec.ts`: repeated cascade/probe executions hit the cache (observable via a counter on the cache, or at minimum unchanged behavior across DDL + rollback edge cases above).
- Micro-check: the sibling ticket's repro script shape (bulk delete with cascading children) shows per-row cost drop on the memory module; optionally extend the performance sentinel added there to a cascade shape.
- `yarn test`, `yarn test:store`, `yarn lint` green.

## TODO

- [ ] Internal statement cache on Database (LRU, busy-guard fallback, finalize on evict/close, `@internal`)
- [ ] Adopt in assertNoRestrictedChildrenForParentMutation, transitive pre-walk scan, executeSingleFKAction, assertNoLensChildReferences, assertNoReferencingChildrenForDrop
- [ ] Tests: DDL-between-executions recompile, recursive re-entry busy-guard, savepoint rollback, close-time finalization
- [ ] `yarn test`, `yarn test:store`, `yarn lint` green
