---
description: Asking for "no limit" by passing a null or negative row count returns zero rows instead of every row, and which answer you get depends on which internal operator the planner picked, so the same query can legitimately return nothing or everything.
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts             # null limit → Infinity → the isFinite guard rewrites it to 0
  - packages/quereus/src/runtime/emit/ordinal-slice.ts            # same query, null limit → Infinity → every row
  - packages/quereus/src/runtime/emit/recursive-cte.ts            # same again → Infinity → every row
  - packages/quereus/src/planner/nodes/limit-offset.ts            # constantLimit() doc-comment states null means "no limit", contradicting the emitter
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic  # pins today's answer (0 rows) for null and negative limits
  - packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic # pins negative limit → 0 rows
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Two sqllogic files deliberately pin the current answers with comments explaining them, so this is a documented behaviour rather than an oversight, and an application that binds a null row-count is arguably as well served by an error as by a silent "no limit" — changing it means picking a semantics and rewriting those pins, which a maintainer may not want to spend a compatibility break on.
---

# `limit null` (and `limit -1`) return no rows instead of all rows

## What happens

```sql
select k from t limit null;   -- returns []      (t has 4 rows)
select k from t limit -1;     -- returns []
```

Verified on the memory backend. SQLite answers "every row" for both: a negative row count
means there is no upper bound, and a null one is not an upper bound either. Confirm the
null case against `sqlite3` before acting — the negative case is stated outright in the
SQLite documentation, the null case is believed but not verified here.

This is reachable without writing a literal `null`: an application that binds the row count
as a parameter and passes null to mean "everything" gets an empty result set, silently.

## Why it happens

`runtime/emit/limit-offset.ts` starts from `Infinity` when there is no limit value, and
then runs a validation step that rejects anything non-finite:

```ts
let limit = limitValue !== null ? Number(limitValue) : Infinity;
if (limit < 0 || !Number.isFinite(limit)) {
    limit = 0;                 // <- Infinity lands here too
}
```

So the sentinel for "no limit" is destroyed by the guard meant to catch garbage.

## The part that makes it more than a quirk

Three emitters implement the same SQL construct and two of them disagree with the third:

| operator | `limit null` | `limit -1` |
|---|---|---|
| `limit-offset.ts` (the usual path) | 0 rows | 0 rows |
| `ordinal-slice.ts` (substituted by the optimizer when a storage module can seek by position) | every row | 0 rows |
| `recursive-cte.ts` (a limit inside a recursive CTE) | every row | 0 rows |

The planner also documents the opposite of what the runtime does: the doc-comment on
`constantLimit()` in `planner/nodes/limit-offset.ts` says a literal NULL means "no limit
(the emitter treats it as `Infinity`)".

The `ordinal-slice` divergence is dormant today — no shipped storage module advertises the
positional-seek capability that lets the optimizer substitute that operator
(`vtab/memory/module.ts` defers it, see the TODO near line 574). It stops being dormant the
day one does, and then the answer to `limit null` depends on which storage backend the
table lives in.

## What settling this involves

Pick one answer for null and one for negative, apply it in all three emitters (a shared
helper is the obvious shape — `ordinal-slice.ts` already has a local `coerceCount`), and
rewrite the sqllogic cases that pin today's behaviour, whose comments currently explain the
current answer as intended:

- `104-emit-mutation-kills.sqllogic` — "NULL limit → Infinity → caught by isFinite check →
  0 rows", plus two negative-limit cases.
- `94.1-limit-offset-edge-cases.sqllogic` — "Negative LIMIT → treated as 0 (no rows)".

Matching SQLite (null and negative both mean "no upper bound") is the option that needs no
new documentation. Rejecting a null row count with an error is also defensible and is the
only option that surfaces the application bug rather than guessing at intent; it is the
larger compatibility break.

Found while fixing `bug-limit-reads-one-row-too-many`, which touches the same emitter but
deliberately leaves these cases alone.
