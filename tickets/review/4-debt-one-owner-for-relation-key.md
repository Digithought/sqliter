---
description: The short text label the engine uses to name each place a query reads a table used to be spelled by hand in about a dozen places; it now has one owner module, and everything else calls into it.
files:
  - packages/quereus/src/planner/analysis/relation-key.ts                     # NEW — the owner module
  - packages/quereus/test/planner/relation-key.spec.ts                        # NEW — unit + cross-subsystem agreement tests
  - packages/quereus/src/planner/analysis/binding-extractor.ts                # collectTableReferences + PlanTableReference moved out
  - packages/quereus/src/planner/analysis/constraint-extractor.ts             # ~1087 matcher, ~1365 walk, ~1602 createTableInfoFromNode
  - packages/quereus/src/planner/analysis/change-scope.ts                     # relKeyFor deleted; own walk kept
  - packages/quereus/src/planner/analysis/key-filter.ts                       # ~73
  - packages/quereus/src/core/database-materialized-views-analysis.ts         # collectTableRefs deleted
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts    # ~294, ~609, ~1113, ~1122, ~1211, ~1289, ~1538
  - packages/quereus/src/func/builtins/explain.ts                             # ~1029
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts             # ~143
  - packages/quereus/src/runtime/emit/create-assertion.ts                     # import repointed
  - packages/quereus/src/schema/assertion.ts                                  # comment repointed
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts         # ~638 comment only
  - packages/quereus/test/plan/correlated-predicate-scope.spec.ts             # uses relationKeyOf
  - docs/optimizer-assertions.md                                             # ~22 key-format definition corrected
difficulty: medium
---

# Review: one owner for the table-reference key

## What the label is (for a reader with no context)

When the engine plans a query it builds a tree, and each place the query reads a
table becomes a node in that tree. Several features need to name *one particular
read* of a table rather than the table itself — a self-join reads the same table
twice and the two reads must be told apart. They do that with a short text label,
`<schema>.<table>#<node id>`, all lowercase, e.g. `main.orders#42`. The codebase
calls it the **relation key**.

It used to be spelled by hand at about a dozen sites. The recipe had already
drifted three times, and each drift failed *silently*: two sites compute labels for
the same read, the strings differ, every lookup finds nothing, and the feature
quietly degrades (one incident silently turned every single-key equality select into
a whole-table scan). This work gives the label one owner module.

## What landed

`packages/quereus/src/planner/analysis/relation-key.ts` is new and owns the label
end to end. Its exports:

| export | what it does |
|---|---|
| `type RelationKey = string` | documents intent at signature sites; still a plain alias (branding is `debt-relation-key-branded-type` in backlog) |
| `PlanTableReference` | `{ node: TableReferenceNode; base: string }` — moved verbatim out of `binding-extractor.ts` |
| `relationBaseName(schema)` | lowercased qualified `schema.table` |
| `relationKeyFrom(base, nodeId)` | compose; `null`/`undefined` id → `#unknown` suffix, preserved exactly |
| `relationKeyOf(ref)` | THE entry point for a `TableReferenceNode` |
| `relationKeyOfRelation(node, displayName?)` | general case; a `TableReferenceNode` canonicalizes regardless of the name passed, anything else falls back to `displayName ?? node.toString()`, lowercased |
| `relationKeyBase(key)` | parse; splits at the **last** `#` |
| `relationKeyWithBase(key, newBase)` | re-base (ALTER TABLE … RENAME propagation) |
| `relationKeyHasNodeId(key, nodeId)` | exact id-segment compare, replacing `endsWith('#' + id)` |
| `collectTableReferences(plan)` | the shared plan walk, moved verbatim out of `binding-extractor.ts` (doc comments included) |

It is a leaf module: only imports are `planner/nodes/plan-node.js` and
`planner/nodes/reference.js`. `planner/nodes/reference.ts` does import three other
`planner/analysis/` modules (`check-extraction`, `partial-unique-extraction`,
`assertion-hoist-cache`) — none of them imports `relation-key.ts`, so there is no
cycle. Verified by a clean `yarn build`.

After the change, `grep -rn '#\${' packages/quereus/src --include=*.ts` finds exactly
one relation-key builder (inside `relation-key.ts`), and
`grep -rn "split('#')\|indexOf('#')\|lastIndexOf('#')\|endsWith('#"` finds only the
three `lastIndexOf` calls inside `relation-key.ts`.

Deleted: `database-materialized-views-analysis.ts`'s `collectTableRefs` (a duplicate
walk); its three callers in `database-materialized-views-plan-builders.ts` now use the
shared walk, and the site that rebuilt a base name inline to compare against
`lookupBase` reads `ref.base` instead.

Kept with their own bodies, adopting only the shared label: `change-scope.ts`'s
`collectTableRefs` (walks `getRelations()` too, has a cycle guard) and
`constraint-extractor.ts`'s `createTableInfosFromPlan`. `planner/mutation/backward-body.ts`'s
same-named walk keys by node id, not relation key — untouched, as specified.

## Behaviour changes a reviewer should check

These are the parts most worth an adversarial eye. All are believed inert; each was
reasoned through rather than measured, except where a test pins it.

1. **The three unqualified callers are now canonical.** `rule-grow-retrieve` (~143,
   ~378) and `rule-predicate-pushdown` (~88) passed a bare table name and got keys
   like `orders#42`. Those files were **not edited** — they route through
   `createTableInfoFromNode`, which now canonicalizes any `TableReferenceNode`
   through `relationKeyOfRelation`, so their keys became `main.orders#42` for free.
   Each looks the key up only against an extraction built from that same `TableInfo`,
   so this should be inert. The check is plan shape: `yarn test` (which includes
   `test/plan/` and `test/optimizer/`) is green with no plan diffs.
2. **`filter.ts` (~182) and `rule-monotonic-range-access` (~233) pass no name.** They
   previously keyed on `node.toString().toLowerCase()`. For a `TableReferenceNode`
   with `readCommitted` set, `toString()` prefixes `committed.`, so their key base was
   `committed.main.t` and is now `main.t`. Same self-consistency argument (single
   `TableInfo`, lookup against its own `relationKey`) — but this one is worth a second
   look, because it is the only case where the *shape* of the base string changed
   rather than just its case.
3. **`relationKeyHasNodeId` is stricter than the `endsWith` it replaced.** It compares
   the segment after the last `#` exactly. Old behaviour matched `main.orders#142` for
   id `42`? No — `endsWith('#42')` was already safe there. The strictness only matters
   for a base whose own text ends in `#<id>`; both old and new reject that. Pinned by
   unit tests.
4. **`TableInfo.relationName` is unchanged**, deliberately. `extractConstraints`
   matches `t.relationKey === rel || t.relationName === rel` (~168); only the key was
   canonicalized. `createTableInfosFromPlan` still passes the **non**-lowercased
   `schema.table` as the display name.
5. **A quoted table name containing `#` is real and now handled.**
   `create table "we#ird"` parses (verified — the lexer gives `#` no special meaning),
   and both former parse sites split at the first `#`, which truncated the base. The
   owner splits at the last `#`. There is an end-to-end test that plans
   `select id from "we#ird"` and round-trips the key.

## Tests

New `packages/quereus/test/planner/relation-key.spec.ts` — 12 tests, all passing:

- **Spelling unit tests** (no database): base lowercasing; `#unknown` for a null /
  undefined node id; `relationKeyBase` ↔ `relationKeyWithBase` round-trip, including a
  base containing `#`; `relationKeyHasNodeId` does not confuse `42` with `142`, and
  rejects `main.x#42#7` for id `42`; no-`#` inputs degrade sanely.
- **Over a real plan** (mixed-case `Orders` / `Items` declared in schema `main`):
  base lowercases regardless of declared identifier case; a self-join yields two
  distinct keys over one base; a table read under a scalar subquery
  (`not exists (select 1 from Items i …)`) is found by the walk.
- **The cross-subsystem agreement test** — the generalized guard this ticket exists
  to install. Over four query shapes (self-join, scalar subquery, aggregate,
  single-key equality), it asserts the key *sets* from `collectTableReferences(plan)`,
  `analyzeRowSpecific(plan).classifications`, and `extractBindings(plan).perRelation`
  are equal. A future site that re-spells the label differently breaks this test
  instead of degrading silently.
- **`"we#ird"` end to end**: the plan's key parses back to base `main.we#ird` and
  `relationKeyOf(ref.node)` reproduces the map key.

Existing regression coverage still green: `test/optimizer/change-scope-analyzer.spec.ts`
(~100, the lowercase-incident guard), `test/plan/correlated-predicate-scope.spec.ts`
(now calls `relationKeyOf` directly instead of building a `TableInfo`).

### Validation run

From repo root:

- `yarn build` — clean.
- `yarn test` — **0 failing** across all workspaces (`packages/quereus`: 9393 passing).
- `yarn lint` — clean, no new warnings.
- `yarn test:store` — **not run**, per the ticket: nothing here touches the store path.
  A reviewer wanting extra confidence on the MV/assertion arms could run it, since the
  MV plan builders were edited.

## Known gaps — treat these as the floor, not the finish line

- **The `readCommitted` case in item 2 above has no direct test.** I reasoned that
  `filter.ts`'s key is only ever compared against its own `TableInfo`, but no test
  plans a `readCommitted` table reference through a Filter and asserts the covered-key
  outcome is unchanged. If a reviewer can construct that shape cheaply, it is the
  highest-value missing test in this change.
- **`relationKeyOfRelation`'s non-`TableReferenceNode` fallback is untested directly.**
  It is exercised indirectly through `filter.ts` / `rule-monotonic-range-access` in the
  wider suite, but there is no unit test that hands it a non-table relational node and
  asserts the `node.toString()` fallback.
- **The rename path's `#`-in-name round-trip is unit-level only.** The
  `relationKeyWithBase` round-trip through a base containing `#` is a pure-string test;
  there is no `alter table "we#ird" rename to …` test asserting
  `assertion_info().dependent_tables` re-keys correctly.
- **Plan-shape inertness (item 1) rests on the whole suite being green**, not on a
  targeted before/after plan dump. If a reviewer wants that pinned harder, dumping a
  plan for a predicate-pushdown query before and after would be the direct check.

## Observation parked for the reviewer, not filed

`extractConstraints` (`constraint-extractor.ts` ~168) matches
`t.relationKey === rel || t.relationName === rel`. Every producer of `targetRelation`
sets it to `tableInfo.relationKey` (~411, ~492, ~501, ~539, ~580), and `relationKey`
is always populated, so the `relationName` arm looks unreachable. I left it alone —
removing it is a behaviour question, not part of this ticket, and it is dead code
rather than a latent defect. Noting it here rather than filing a ticket; if a reviewer
confirms it is genuinely unreachable, deleting the arm (and possibly
`TableInfo.relationName`'s role in matching entirely) is a small follow-up.

## Docs

`docs/optimizer-assertions.md` (~22) documented the format as
`schema.table#<nodeId>` **or** `schema.table@alias#<nodeId>` — no builder has ever
produced the `@alias` form. Corrected to the single real format, with the lowercase
rule spelled out and a pointer to `planner/analysis/relation-key.ts` as the owner.

`packages/quereus/src/planner/analysis/README.md` was deliberately **not** updated —
that per-file inventory is stale and its rot is tracked by
`debt-planner-analysis-readme-stale`, per the source ticket.
