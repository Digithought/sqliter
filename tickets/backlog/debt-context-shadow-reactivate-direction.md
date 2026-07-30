----
description: The new debug-mode wrong-row detector catches most cases but is blind to one specific mistake pattern; closing that gap needs the query planner to tell the runtime which operator each column read is supposed to come from, which is a bigger, unresolved piece of work.
files: packages/quereus/src/runtime/context-helpers.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/src/planner/nodes/reference.ts, docs/runtime.md
----

## Context

The `QUEREUS_CONTEXT_STRICT` debug assertion (ticket `runtime-context-shadow-strict`)
detects wrong-row bugs by a *recency* rule: the winner of the runtime's attribute index
must be the live row-context whose row was updated most recently for that attribute.
That catches the common failure — a streaming operator that forgets to release its stale
row before pulling its child, so the stale row keeps winning ("operator-shadows-child").

It is deliberately **blind to the mirror failure**: "child-shadows-operator." Here an
operator matches a row, sets its context, but a still-running child cursor then does a
*look-ahead* read and updates the same attribute IDs with a genuinely newer row. The
operator is supposed to call `reactivate()` (re-assert its context) before yielding so
downstream reads see the matched row, not the child cursor's look-ahead position (see
`emit/asof-scan.ts`, which does this correctly). If an emitter forgets that
`reactivate()`, the child cursor's look-ahead row is the *newest* write — so the recency
rule considers the state consistent and stays silent, even though downstream now reads
the wrong row.

## Why this is parked, not in the implement ticket

Recency cannot distinguish "correct newest write" from "wrong-but-newest look-ahead
write" — the two are structurally identical. Catching it requires knowing the *intended*
provider for a read, i.e. threading provenance from the planner to the runtime: for each
column reference, which relational operator's output it is expected to resolve against,
compared to which operator actually installed the winning context.

That threading is not yet resolved and is non-trivial:

- The "intended provider" is **scope-dependent, not global.** A base column's attribute
  ID is installed by a leaf scan *and* re-installed by operators above it (e.g. a join
  over the same IDs). Which one should win depends on where in the tree the read sits —
  the very resolution logic the check would be validating, so a single global
  attribute-ID → producer map is insufficient.
- `ColumnReferenceNode` (`planner/nodes/reference.ts`) carries only `attributeId` +
  `columnIndex` today — no handle to the producing node/relation, and `Attribute.sourceRelation`
  is not a reliable installer identity (pass-through projections overwrite it).
- So the design must decide *what* provenance to capture per reference (resolved at build
  time against its scope), *how* to tag each installed runtime context with an installer
  identity that the read's expectation can be compared against, and *how* to keep that
  cheap and zero-cost when the flag is off.

## What "done" looks like

A debug-mode check (extending or complementing `QUEREUS_CONTEXT_STRICT`) that also flags
the forgot-`reactivate()` / child-shadows-operator direction, with the same gating and
diagnostic-quality bar as the recency check: name the attribute, the reading operator,
the operator whose context won, and the operator that should have. Validated by running
the full logic suite under the flag with zero false positives.

This is a design-first item: the first pass should settle the provenance-threading
approach (what the planner emits, how the runtime compares) before any implementation,
and may split into a plan ticket.
