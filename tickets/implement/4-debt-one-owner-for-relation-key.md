---
description: The engine labels each place a query reads a table with a short text string, and about a dozen spots build or take apart that string by hand with the same recipe. Give the string one owner module so the recipe cannot drift apart again.
files:
  - packages/quereus/src/planner/analysis/relation-key.ts                     # NEW — the owner module
  - packages/quereus/src/planner/analysis/binding-extractor.ts                # collectTableReferences (~164) moves out; imports the owner
  - packages/quereus/src/planner/analysis/constraint-extractor.ts             # ~1086 endsWith, ~1367, ~1612 (the drift-incident comment)
  - packages/quereus/src/planner/analysis/change-scope.ts                     # relKeyFor (~345) — keeps its own walk, adopts the shared label
  - packages/quereus/src/planner/analysis/key-filter.ts                       # ~73
  - packages/quereus/src/core/database-materialized-views-analysis.ts         # collectTableRefs (~274) — delete, callers use the shared walk
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts    # ~295, ~610, ~1114, ~1123, ~1212, ~1290, ~1540
  - packages/quereus/src/func/builtins/explain.ts                             # ~1028 — splits the key on '#' by hand
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts             # ~142 — splits + rebuilds the key by hand
  - packages/quereus/src/runtime/emit/create-assertion.ts                     # imports collectTableReferences
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts      # createTableInfoFromNode caller (qualified name)
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts         # ~143, ~378 (unqualified), ~642 (qualified, with a comment about the hazard)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts   # ~88 (unqualified)
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts              # ~314
  - packages/quereus/src/planner/nodes/filter.ts                              # ~182 — no name passed; falls back to node.toString()
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts  # ~233 — same fallback
  - packages/quereus/test/plan/correlated-predicate-scope.spec.ts             # builds a key via createTableInfoFromNode
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts             # ~100 — existing regression test for the lowercase incident
  - docs/optimizer-assertions.md                                              # ~22 documents the key format
difficulty: medium
---

# One owner for the table-reference key

## What the label is

When the engine plans a query it builds a tree, and each place the query reads a
table becomes a node in that tree. Several features need to name *one particular
read* of a table rather than the table itself — a self-join reads the same table
twice and the two reads must be told apart. They do that with a short text label,
`<schema>.<table>#<node id>`, all lowercase, e.g. `main.orders#42`. The codebase
calls it the **relation key**.

Today about a dozen sites spell that label by hand (`grep -rn '#\${'
packages/quereus/src --include=*.ts`, discarding the debug/logging hits): ten build
it, two take it apart, and one matches its `#<id>` tail with `endsWith`. Two
near-identical tree walks collect every label in a plan.

## Why it drifts

Nothing is broken today — but the recipe has drifted three separate times, and each
time the failure was silent rather than loud: two sites compute labels for the same
read, the strings differ, each lookup finds nothing, and the feature quietly
degrades. The scars are still in the source:

- `constraint-extractor.ts` (~1603) records the lowercase incident — one site did
  not lowercase, so a table named `Entity` produced a label no other site matched,
  and every single-key equality select silently widened to a whole-table scan.
- `rule-grow-retrieve.ts` (~638) carries a comment warning that the key built there
  "must match what `createTableInfosFromPlan` emits — schema-qualified name plus the
  id", because it is easy to get wrong.
- The assertion bug this work came out of
  (`bug-assertion-info-dependent-tables-always-empty`) was the same shape one level
  up: two copies of "find the tables this query reads", one of which walked the tree
  differently and found nothing. Fixed by deleting a copy.

There is also a live inconsistency in the base half of the label right now, which
this ticket resolves. `createTableInfoFromNode(node, relationName?)` builds the key
from whatever display name the caller passes:

| caller | passes | key base |
|---|---|---|
| `createTableInfosFromPlan` (~1552), `rule-select-access-path` (~250), `index-nested-loop` (~314), `rule-grow-retrieve` (~642) | `schema.table` | `main.orders` |
| `rule-grow-retrieve` (~143, ~378), `rule-predicate-pushdown` (~88) | `table` | `orders` |
| `filter.ts` (~182), `rule-monotonic-range-access` (~233) | nothing | `node.toString()` |

Each of those sites is *self*-consistent today — it builds a `TableInfo` and looks
the key up only against an extraction computed from that same `TableInfo` — so no
bug is currently reachable through them. But any new cross-call comparison against a
key from one of the unqualified sites would silently find nothing. Canonicalizing on
the qualified form removes that whole hazard.

## What "done" looks like

A new module `packages/quereus/src/planner/analysis/relation-key.ts` owns the label
end to end — building it, taking it apart, and the plan walk that collects every one
of them. Nothing outside it spells `${base}#${id}` or splits on `'#'`.

Proposed surface (names are a suggestion; shape is not):

```ts
/** Instance-unique identity of one table read within a plan: `<schema>.<table>#<nodeId>`. */
export type RelationKey = string;

/** One TableReferenceNode found in a plan, paired with the base table it reads. */
export interface PlanTableReference {
	node: TableReferenceNode;
	/** Qualified base table name, lowercased `schema.table`. */
	base: string;
}

/** Lowercased qualified base name for a table schema. */
export function relationBaseName(schema: { schemaName: string; name: string }): string;

/** Compose from an already-canonical base and a node id. */
export function relationKeyFrom(base: string, nodeId: number | null | undefined): RelationKey;

/** The key of a table reference. THE canonical entry point. */
export function relationKeyOf(ref: TableReferenceNode): RelationKey;

/**
 * The key of an arbitrary relational node — the general case
 * `createTableInfoFromNode` needs. A TableReferenceNode always canonicalizes to
 * `relationKeyOf`; anything else falls back to `displayName ?? node.toString()`,
 * lowercased, preserving today's behaviour for non-table relational nodes.
 */
export function relationKeyOfRelation(node: RelationalPlanNode, displayName?: string): RelationKey;

/** Take one apart. Splits at the LAST '#' — see "Edge cases" below. */
export function relationKeyBase(key: RelationKey): string;
export function relationKeyWithBase(key: RelationKey, newBase: string): RelationKey;
/** True when `key` names the read at `nodeId` (replaces the `endsWith('#'+id)` match). */
export function relationKeyHasNodeId(key: RelationKey, nodeId: number | null | undefined): boolean;

/**
 * Every TableReferenceNode reachable from `plan`, keyed by relation key.
 * Moved here verbatim from binding-extractor.ts — including its doc note that the
 * walk descends getChildren() (NOT getRelations()), so a table read under a scalar
 * subquery is found, and its note that callers who care about reference identity
 * must pass an analysis-optimized plan.
 */
export function collectTableReferences(plan: PlanNode): Map<RelationKey, PlanTableReference>;
```

`RelationKey` stays a plain `string` alias in this pass — it documents intent without
rippling into every map type. Making it a distinct type the compiler enforces is
filed separately as `debt-relation-key-branded-type`, which is where the ripple gets
measured.

### Why the module is separate from `binding-extractor.ts`

`constraint-extractor.ts` must import the key builder, and `binding-extractor.ts`
already imports `constraint-extractor.ts`. Keeping the label in its own leaf module —
whose only imports are `planner/nodes/plan-node.js` and `planner/nodes/reference.js` —
avoids a cycle and lets `core/`, `runtime/`, and `func/` import it without dragging
in the analysis machinery. `core/` already imports from `planner/analysis/` in six
places, so this crosses no new boundary.

### The two walks

`binding-extractor.ts`'s `collectTableReferences` and
`database-materialized-views-analysis.ts`'s `collectTableRefs` are the same walk;
they differ only in map value (`{node, base}` vs bare `node`). The MV copy goes away
and its three callers use the shared walk. Site ~1212 currently rebuilds the base
name inline to compare against `lookupBase` — it can read `ref.base` instead.

Two other walks keep their own bodies and adopt only the shared *label*:

- `change-scope.ts` `collectTableRefs` — walks `getChildren()` **and**
  `getRelations()` with a visited-set cycle guard, returns an array. Its keys are
  compared against `extractBindings`'s keys (~258), so the label must stay identical;
  the walk must not.
- `constraint-extractor.ts` `createTableInfosFromPlan` — same both-edges walk with a
  by-node-id seen guard, returns `TableInfo[]`.

`planner/mutation/backward-body.ts`'s `collectTableRefs` keys by node id, not by
relation key. Out of scope — do not touch it.

## Edge cases & interactions

- **Mixed-case identifiers.** `create table Entity(...)` in schema `MAIN` must produce
  `main.entity#<id>` from every entry point. This is the incident that already
  happened; the existing regression test is
  `test/optimizer/change-scope-analyzer.spec.ts` (~100).
- **A `#` inside a quoted table name.** `create table "we#ird"` is legal. Both
  existing parse sites assume otherwise: `explain.ts` (~1028) does
  `key.split('#')[0]` and `assertion-rename-helpers.ts` (~142) does `indexOf('#')`
  under a comment asserting "a base never contains '#'". A node id never contains
  `#`, so splitting at the **last** `#` is strictly correct and equally cheap — the
  owner's parse functions must use `lastIndexOf`. Confirm a quoted `#` name actually
  parses before writing the test; if it does not, keep `lastIndexOf` anyway (still
  strictly safer) and say so in the handoff.
- **Self-join.** Two reads of one table must yield two distinct keys and two map
  entries. Any dedup added to the shared walk would break assertions over self-joins.
- **Missing node id.** Today every builder emits `#unknown` when `node.id` is
  null/undefined. Preserve that exactly — do not throw, do not omit the suffix.
- **Canonicalizing the three unqualified callers** (`rule-grow-retrieve` ~143/~378,
  `rule-predicate-pushdown` ~88) changes their keys from `orders#42` to
  `main.orders#42`. Each looks the key up only against an extraction built from the
  same `TableInfo`, so this should be inert — but it touches the access-path and
  predicate-pushdown rules, so plan-shape tests are the check. Watch
  `test/plan/` and `test/optimizer/` closely; an unexplained plan diff here means the
  self-consistency assumption was wrong somewhere and must be understood, not
  papered over.
- **`TableInfo.relationName` stays a display string.** `constraint-extractor.ts`
  (~168) matches `t.relationKey === rel || t.relationName === rel`. Only the *key*
  becomes canonical; leave `relationName` as whatever the caller passed, or that
  second arm changes meaning.
- **Non-`TableReferenceNode` relational nodes.** `filter.ts` (~182) and
  `rule-monotonic-range-access` (~233) pass a source node that may not be a table
  reference and pass no name. `relationKeyOfRelation` must keep the `node.toString()`
  fallback for them, not assume `tableSchema` exists.
- **Rename rewriting.** `assertion-rename-helpers.ts` rebuilds a key with a new base
  after `alter table … rename`. That is `relationKeyWithBase`; it must round-trip
  with `relationKeyBase` including the `#`-in-name case.
- **`endsWith` matcher.** `constraint-extractor.ts` (~1086) tests whether a target key
  names a given node with `targetKey.endsWith('#' + id)`. Route through
  `relationKeyHasNodeId` and keep the `'#'` in the comparison — a bare `endsWith(id)`
  would match `main.orders#142` for id `42`.
- **Import direction.** Verify `planner/nodes/reference.ts` does not import from
  `planner/analysis/` before adding the new leaf module; if it does, the type import
  must be `import type` to stay erasable.

## TODO

### Phase 1 — the owner module

- Add `packages/quereus/src/planner/analysis/relation-key.ts` with the surface above.
  Move `collectTableReferences` and `PlanTableReference` out of
  `binding-extractor.ts` verbatim, doc comments included; update
  `binding-extractor.ts`'s header, which currently advertises itself as their home.
- Update `binding-extractor.ts` and `runtime/emit/create-assertion.ts` to import the
  walk from the new module. `schema/assertion.ts` (~38) mentions
  `collectTableReferences` in a comment — repoint it.

### Phase 2 — replace every hand-spelled site

- Builders: `binding-extractor.ts` (now via the module), `change-scope.ts`
  `relKeyFor`, `key-filter.ts` (~73), `constraint-extractor.ts` (~1367, ~1612),
  `database-materialized-views-plan-builders.ts` (~610, ~1114, ~1123, ~1540).
- `constraint-extractor.ts` (~1612): route `createTableInfoFromNode` through
  `relationKeyOfRelation` so a `TableReferenceNode` canonicalizes regardless of the
  `relationName` the caller passed. Replace the incident comment (~1603) with a one-
  line pointer to `relation-key.ts` — the history belongs in this ticket, and the
  code no longer has a way to reproduce it.
- Parsers: `explain.ts` (~1028), `assertion-rename-helpers.ts` (~142), and the
  `endsWith` matcher at `constraint-extractor.ts` (~1086).
- Delete `collectTableRefs` from `database-materialized-views-analysis.ts`; point its
  three callers in `database-materialized-views-plan-builders.ts` (~295, ~1212,
  ~1290) at the shared walk and use `ref.base` at ~1212.
- `test/plan/correlated-predicate-scope.spec.ts` (~91) builds a key via
  `createTableInfoFromNode` — use `relationKeyOf` directly.

### Phase 3 — tests

- New `packages/quereus/test/planner/relation-key.spec.ts` unit coverage: mixed-case
  schema/table lowercases; `null` node id yields the `#unknown` suffix;
  `relationKeyBase` / `relationKeyWithBase` round-trip, including a base containing
  `#`; `relationKeyHasNodeId` does not confuse id `42` with id `142`.
- A cross-subsystem agreement test — the generalized guard that makes this class of
  drift fail loudly instead of silently. Over one plan (mixed-case table names, and a
  self-join so there are two reads of one table), assert the key *sets* are equal
  across `collectTableReferences(plan)`, `analyzeRowSpecific(plan).classifications`,
  and `extractBindings(plan).perRelation`. Any future site that re-spells the label
  differently breaks this test rather than degrading in silence.
- Coverage for the walk itself: a table read under a scalar subquery
  (`not exists (select … from t …)`, the shape almost every assertion body has) is
  found — that is why the walk descends `getChildren()`.
- Run `yarn build`, `yarn test`, `yarn lint` (repo root). `yarn test:store` is not
  needed — nothing here touches the store path.

### Phase 4 — docs

- `docs/optimizer-assertions.md` (~22) documents the key format and mentions a
  `schema.table@alias#<nodeId>` variant no builder produces. Correct it and point at
  `planner/analysis/relation-key.ts` as the owner.
- Do **not** add the new module to `packages/quereus/src/planner/analysis/README.md`
  — that per-file inventory is stale and its rot is tracked by
  `debt-planner-analysis-readme-stale`.
