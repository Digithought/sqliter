---
description: The short text label the engine uses to name each place a query reads a table used to be spelled by hand in about a dozen places; it now has one owner module, and everything else calls into it.
files:
  - packages/quereus/src/planner/analysis/relation-key.ts                     # the owner module
  - packages/quereus/test/planner/relation-key.spec.ts                        # unit + cross-subsystem agreement tests
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/planner/analysis/key-filter.ts
  - packages/quereus/src/core/database-materialized-views-analysis.ts
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/src/runtime/delta-executor.ts                            # review: synthetic watch key now composed through the owner
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/schema/assertion.ts
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/test/plan/correlated-predicate-scope.spec.ts
  - packages/quereus/test/optimizer/row-specific-fd.spec.ts                   # review: hand-parsed the key
  - packages/quereus/test/assertion-rename-propagation.spec.ts                # review: '#'-in-name rename round-trip
  - docs/optimizer-assertions.md
  - docs/incremental-maintenance.md                                           # review: source list
difficulty: medium
---

# One owner for the table-reference key

## What the label is (for a reader with no context)

When the engine plans a query it builds a tree, and each place the query reads a table
becomes a node in that tree. Several features need to name *one particular read* of a
table rather than the table itself — a self-join reads the same table twice and the two
reads must be told apart. They do that with a short text label,
`<schema>.<table>#<node id>`, all lowercase, e.g. `main.orders#42`. The codebase calls
it the **relation key**.

It used to be spelled by hand at about a dozen sites. The recipe had already drifted
three times, and each drift failed *silently*: two sites compute labels for the same
read, the strings differ, every lookup finds nothing, and the feature quietly degrades
(one incident silently turned every single-key equality select into a whole-table scan).

## What landed

`packages/quereus/src/planner/analysis/relation-key.ts` (148 lines) owns the label end
to end and is a leaf module — its only imports are `planner/nodes/`. Exports:

| export | what it does |
|---|---|
| `type RelationKey = string` | documents intent at signature sites; branding tracked by `debt-relation-key-branded-type` |
| `PlanTableReference` | `{ node: TableReferenceNode; base: string }` |
| `relationBaseName(schema)` | lowercased qualified `schema.table` |
| `relationKeyFrom(base, nodeId)` | compose; `null`/`undefined` id → `#unknown` |
| `relationKeyOf(ref)` | THE entry point for a `TableReferenceNode` |
| `relationKeyOfRelation(node, displayName?)` | general case; a `TableReferenceNode` canonicalizes regardless of the name passed |
| `relationKeyBase(key)` | parse; splits at the **last** `#` |
| `relationKeyWithBase(key, newBase)` | re-base (ALTER TABLE … RENAME propagation) |
| `relationKeyHasNodeId(key, nodeId)` | exact id-segment compare |
| `collectTableReferences(plan)` | the shared plan walk |

Deleted: `database-materialized-views-analysis.ts`'s duplicate `collectTableRefs` walk.
Kept with their own bodies but adopting the shared label: `change-scope.ts`'s
`collectTableRefs` (also walks `getRelations()`, has a cycle guard) and
`constraint-extractor.ts`'s `createTableInfosFromPlan`.
`planner/mutation/backward-body.ts`'s same-named walk keys by node id, not relation key
— untouched by design.

Docs: `docs/optimizer-assertions.md` had documented a `schema.table@alias#<nodeId>`
format no builder has ever produced; corrected to the single real format with the
lowercase rule spelled out. `packages/quereus/src/planner/analysis/README.md` is stale
across the board and is deliberately left to `debt-planner-analysis-readme-stale`.

## Review findings

Reviewed the implement diff (`e78f7c60`) before the handoff summary, then re-derived the
sweep independently rather than trusting the implementer's greps.

### Fixed in this pass (minor)

- **A second key composer survived the sweep.** `runtime/delta-executor.ts` builds a
  synthetic key for the i-th watch in a change scope as `` `${base}#watch_${i}` ``. The
  implementer's verification grep was `'#\$\{'`, which cannot match `#watch_${i}` — so the
  handoff's "exactly one relation-key builder remains" claim was wrong. It now composes
  through `relationKeyFrom`. Behaviour identical; the point is that the one owner is now
  actually the only composer.
- **A test hand-parsed the key.** `test/optimizer/row-specific-fd.spec.ts` split on the
  *first* `#` to recover the base — the exact bug `relationKeyBase` exists to prevent,
  living in the test that guards the classifier. Now calls `relationKeyBase`.
- **`relationKeyOfRelation` used `??` where the code it replaced used `||`.** An empty
  `displayName` would have produced a base-less key (`#42`) instead of falling back to
  `node.toString()`. Unreachable from the single in-tree caller (which resolves the name
  with `||` first), but the owner module should not be the loose link. Switched to `||`
  and pinned by a test.
- **`import { PlanNode, … }` in the owner was a value import for a type-only use.**
  Made type-only, so the "deliberately a leaf" claim in its header holds at the module-
  graph level too.
- **Docs.** `docs/incremental-maintenance.md`'s source list named `binding-extractor.ts`
  and `key-filter.ts` but not the module that now owns the key every map in that
  pipeline is keyed by. Added.

### Tests added (the handoff's three named gaps, all closed)

The implementer flagged three untested areas and called them "the floor, not the finish
line". All three are now covered; quereus goes 9,393 → 9,396 passing.

- **The `readCommitted` behaviour change** — the handoff's own highest-value gap.
  `TableReferenceNode.toString()` prefixes `committed.`, so the two callers that pass no
  display name to `createTableInfoFromNode` (`nodes/filter.ts`, `rules/access/rule-monotonic-range-access.ts`)
  previously keyed on base `committed.main.t` and now key on `main.t`. New test plans
  `select id from committed.Orders where id = 7`, asserts the ref really is a committed
  read and really does print the prefix, then asserts `createTableInfoFromNode(ref)`
  agrees with `relationKeyOf(ref)`. The same query is now also one of the shapes in the
  cross-subsystem agreement test, so the walk, the classifier, and the binding extractor
  are pinned to agree on it.
- **`relationKeyOfRelation`'s non-table fallback** — new test takes a real non-table
  relational node from a plan and asserts the `toString()`-lowercased form, that an
  explicit display name *is* honoured for a non-table node, and that an empty display
  name falls back.
- **The `#`-in-name rename round-trip end to end** — new test in
  `test/assertion-rename-propagation.spec.ts` creates an assertion over
  `create table "we#ird"`, renames the table, and asserts the recorded `relationKey`
  becomes `main.tame#<same id>`. This one is a genuine regression guard, not a
  restatement: the deleted `indexOf('#')` code would have produced `main.tame#ird#<id>`.

### Verified, nothing wrong found

- **Plan-shape inertness of the three unqualified callers** (`rule-grow-retrieve` ×2,
  `rule-predicate-pushdown`): each looks its key up only against an extraction built from
  its own `TableInfo`, so canonicalization is self-consistent. Whole suite green with no
  plan diffs. Not pinned by a targeted before/after plan dump — see *not done* below.
- **`relationKeyHasNodeId` strictness** vs the `endsWith('#'+id)` it replaced: both
  old and new reject a base whose text ends in `#<id>`; the new one additionally cannot
  confuse `42` with `142`. Already pinned by unit tests.
- **No import cycle.** `relation-key.ts` imports only `planner/nodes/`; none of the three
  `planner/analysis/` modules `reference.ts` pulls in imports it back. Clean `yarn build`.
- **Re-ran the sweep independently.** A regex over `#${`, `'#'`, `split('#`, `indexOf('#`,
  `lastIndexOf('#`, `endsWith('#` across `packages/quereus/src` now returns only
  `relation-key.ts`'s three `lastIndexOf` calls plus unrelated `#<index>` display
  formatting (column placeholders, node labels in trace output).
- **Every remaining `relationKey` consumer** (`database-assertions.ts`,
  `database-watchers.ts`, `delta-executor.ts`, `lens-enforcement.ts`) passes keys through
  opaquely and never composes or splits one. `lens-enforcement.ts`'s `relationKeyColumn`
  is an unrelated concept (a *column* name in a lens basis) that merely shares a prefix.

### Filed as new tickets

- `backlog/debt-qualified-base-name-spelled-by-hand` — one level below this ticket, the
  same shape of problem. The *base* half of the key (`main.orders`) is composed by hand
  at **22 sites** under `packages/quereus/src` (measured; command in the ticket), and
  three of them have each wrapped it in a private one-liner under a different name
  (`mvKey`, `baseKeyFor`, and this ticket's own `relationBaseName`). The parse half
  already has a shared owner (`util/qualified-name.ts`'s `splitBaseKey`); the compose half
  has none. Nothing is broken today, hence `backlog/` and not `fix/`.

### Appended to an existing ticket

- `backlog/debt-oversized-source-files` — `planner/analysis/constraint-extractor.ts` is
  1,647 lines (`wc -l`, 2026-08-11), over that ticket's ~1,000-line threshold and not
  previously listed. Added as an arm with the four separable concerns named. Not a new
  ticket: the theme ticket already exists and its deliverable is the ratchet, not this
  instance.

### Recorded as tripwires, not tickets

- `collectTableReferences` re-walks the whole plan on every call and several consumers
  call it over the same plan. Correctness is unaffected and plan trees are small.
  Parked as a `NOTE:` on the function in `relation-key.ts`, with the shape a fix would
  take (WeakMap on the root, not a key-keyed cache).

### Considered and left alone, with the reasoning parked at the site

- The implementer's parked observation about `extractConstraints`'s
  `t.relationName === rel` arm: confirmed unreachable in tree (every producer of
  `targetRelation` sets it to `tableInfo.relationKey`, which is always populated). But
  `TableInfo` is an exported type and `extractConstraints` an exported function, so an
  out-of-tree caller keying on the display name would break — removal is a behaviour
  change, not a cleanup. Left in place with a `NOTE:` at
  `constraint-extractor.ts:169` recording the finding and its revisit condition, so the
  next reviewer does not re-derive it. No ticket.

### Empty categories, explicitly

- **No major findings.** Nothing in the diff needed an architectural ticket of its own —
  the change *is* the invariant that retires its class, and the one architectural gap
  found (the base-name compose) is a sibling problem, not a flaw in this work.
- **No blocked items.** Nothing here needs a human decision or an out-of-repo dependency.
- **No pre-existing test failures.** `tickets/.pre-existing-error.md` was not written.

## Validation

From repo root, after the review edits:

- `yarn build` — clean.
- `yarn test` — **0 failing** across all workspaces; `packages/quereus` 9,396 passing
  (was 9,393 at implement; +3 from this pass).
- `yarn lint` — clean, no new warnings (re-run for `packages/quereus` after the final
  comment-only edit).
- `yarn test:store` — **not run**, as at implement. The MV plan builders were edited, so
  a reviewer wanting extra confidence on the MV/assertion arms could run it; the change
  is string-identity-only and every store-path test consumes these keys opaquely.

## Not done, deliberately

- **Plan-shape inertness is still argued, not dumped.** No before/after plan dump pins
  the three unqualified callers; the evidence remains "the whole suite, including
  `test/plan/` and `test/optimizer/`, is green". Left as-is: a dump would pin one query
  shape, whereas the cross-subsystem agreement test now pins the property across four.
- **`planner/analysis/README.md` still describes only constant folding** and never
  mentions the relation key. Owned by `debt-planner-analysis-readme-stale`; touching one
  section of a wholly stale inventory would make it look maintained.
