description: Running ANALYZE with no table name only collects statistics for tables in the main schema, even when the session has been told to look in other schemas too, so those tables silently keep stale or missing statistics.
files:
  - packages/quereus/src/runtime/emit/analyze.ts       # line 67: `plan.targetSchemaName ?? 'main'` — the hardcoded default
  - packages/quereus/src/planner/building/analyze.ts   # named form resolves through the session search path
  - packages/quereus/src/schema/manager.ts             # getCurrentSchemaName(), findTable(..., schemaPath)
  - docs/sql-txn.md                                    # § 9.5 ANALYZE — "all tables in the default schema"
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: "Bare ANALYZE covers the default schema" is a defensible definition on its own, and changing which tables it touches makes it slower and changes what statistics exist for anyone relying on today's behavior.
difficulty: easy

---

# Bare `ANALYZE` ignores the session's schema search path

A session can tell the engine which schemas to look in, and in what order, with
`pragma schema_path = '...'`. Every statement that names a table follows that
setting. Bare `ANALYZE` does not — it always collects statistics for the tables in
`main` and nothing else.

## Observed

Against a fresh in-memory database with `main.t` (2 rows) and `temp.tt` (1 row):

```
pragma schema_path = 'temp,main';

analyze tt;   -- one row: tt, 1     (the named form follows the path)
analyze;      -- one row: t,  2     (temp.tt is never analyzed)
```

So within one session two `ANALYZE` forms disagree about which schemas exist. A
user who put `temp` on the path and ran a bare `ANALYZE` to "collect everything"
gets no statistics for their temp tables, with no error and no indication that a
schema was skipped. The consequence is only plan quality — the optimizer keeps
using default heuristics for those tables — never a wrong result.

## Where it comes from

The bare and schema-only forms are resolved in the emitter, which computes its
target as `plan.targetSchemaName ?? 'main'` and then walks that one schema. The
`'main'` is a literal, not the session's current schema and not its search path.
The named form (`analyze x`) was moved to build-time resolution and does follow
the path, which is what makes the disagreement visible.

## What the behavior should be

Bare `ANALYZE` should cover the same set of schemas an unqualified table name
would resolve against — the session search path, in order — so that "analyze
everything I can see" is true. `ANALYZE <schema>.*` keeps naming one schema
explicitly and is unaffected.

Two alternatives a maintainer may prefer instead, both narrower:

- Only the session's current schema (`getCurrentSchemaName()`), which is `main`
  unless something switched it — a one-word fix that closes nothing in practice.
- Every attached schema, regardless of path, which is what SQLite's argument-less
  `ANALYZE` does.

Whichever is chosen, `docs/sql-txn.md` § 9.5 currently says "all tables in the
default schema" and needs to say the same thing as the code.
