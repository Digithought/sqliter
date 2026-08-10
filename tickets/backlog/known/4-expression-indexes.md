---
description: Support for indexes on computed expressions in MemoryTable
difficulty: hard
prereq: none
---

## Problem

MemoryTable only supports indexes on plain column references. Expression-based indexes (e.g., `CREATE INDEX idx ON t (lower(name))`) are not implemented. This limits optimization of queries that filter or sort by computed expressions.

Documented in `docs/memory-table.md` under "Current Limitations".

## TODO

### Phase 1: Planning
- [ ] Design expression index storage (expression AST + result type in index definition)
- [ ] Design expression evaluation during index maintenance (INSERT/UPDATE/DELETE)
- [ ] Design query planner matching of expressions to expression indexes

### Phase 2: Implementation
- [ ] Parse and store expression index definitions
- [ ] Evaluate index expressions during DML to maintain index entries
- [ ] Match query expressions against expression indexes in access path selection

### Phase 3: Review & Test
- [ ] Test creation and use of expression indexes
- [ ] Test index maintenance during DML
- [ ] Test query planner selects expression index when appropriate
