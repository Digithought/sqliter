---
description: Queries that join a sub-select against a table can return wrong answers or fail outright, because the planner matches up columns by their position in the sub-select's result instead of their position in the underlying table, and so mistakes one column for another.
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts        # tryEliminate — untranslated indices (wrong rows)
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts      # recognizeBranch — untranslated indices (runtime error)
  - packages/quereus/src/planner/rules/join/rule-join-key-inference.ts      # third caller, log-only
  - packages/quereus/src/planner/util/key-utils.ts                          # checkFkPkAlignment — contract needs stating
  - packages/quereus/src/planner/util/ind-utils.ts                          # resolveTableColumnMapping / mapColumnsToTable / isRowPreservingPathToTable
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts # reference implementation of the pattern to copy
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts
  - packages/quereus/test/optimizer/parallel-fanout.spec.ts
  - docs/optimizer-joins.md
difficulty: medium
---

# Foreign-key alignment must compare base-table column positions

## Background

A declared foreign key lets the planner assume each child row matches at most
one parent row. Two rules exploit that: `rule-join-elimination` drops a join it
can prove is redundant, and `rule-fanout-lookup-join` marks a lookup branch
"at-most-one".

Both decide "is this join on the foreign key?" by comparing the columns the
join equates against the columns the foreign key declares. The foreign key is
declared in **the base table's own column positions** (`p.id` is column 0). The
join condition is expressed in the join input's **output positions** — and a
sub-select renames, reorders, and drops columns freely. The two numbers are
compared without translation, so they collide and the wrong column is accepted
as the foreign-key column.

`planner/util/ind-utils.ts` already grew the translation for the semi/anti-join
foreign-key folds, and `rule-semi-join-fk-trivial.ts` (lines ~55-80) is the
exact pattern to copy:

- `resolveTableColumnMapping(node)` — resolves a subtree to the single base
  table it reads plus a per-output-column map back to that table's columns,
  built by attribute identity (a computed column maps to nothing).
- `mapColumnsToTable(cols, mapping)` — translates output positions, returning
  `undefined` when any column has no base-table origin.

## Confirmed failures

All four verified on `main` at `e0320591` (2026-07-30), and all four verified
fixed by the patches below.

### 1. Outer join loses a row (the originally-reported symptom)

```sql
create table p (id integer primary key, other integer) using memory;
create table c (id integer primary key, p_id integer not null references p(id)) using memory;
insert into p values (7, 7), (2, 7);
insert into c values (10, 7);

select c.id from c left join (select other from p) q on c.p_id = q.other;
-- actual:   [{"id":10}]
-- expected: [{"id":10},{"id":10}]
```

`q.other` is output position 0 of the sub-select but column 1 of `p`; position
0 in `p` is `id`, the column the foreign key references. The check reports
alignment, `rule-join-elimination` drops the join, and the plan is a bare scan
of `c`.

### 2. Inner join invents a row — the *preserved* side is also untranslated

Not in the original report and strictly worse than case 1: the same untranslated
comparison happens on the foreign-key (preserved) side, where an INNER join
emits a row that has no parent at all.

```sql
create table p (id integer primary key) using memory;
create table c3 (id integer primary key, x integer, p_id integer not null references p(id), y integer) using memory;
insert into p values (1), (2);
insert into c3 values (10, 0, 1, 99);   -- y = 99 has NO parent row

select q.id from (select id, x, y from c3) q join p on q.y = p.id;
-- actual:   [{"id":10}]
-- expected: []
```

`q.y` is output position 2, which collides with `c3.p_id` (table column 2), the
real foreign-key column. Alignment is reported, the foreign key is NOT NULL, the
parent side is a bare table, so every INNER guard passes and the join is
dropped. The LEFT variant of the same query is result-equivalent by luck (the
parent's primary key is unique, so a left join emits exactly one row either
way), but the join is still eliminated for an unsound reason.

### 3. Fan-out lookup join fails at runtime

The original ticket left this as an open question. It is reachable, and it is a
hard failure rather than a silent one. With three lookup tables on a module
declaring non-zero `expectedLatencyMs` and `tuning.parallel.concurrency = 2`:

```sql
select o.order_id from orders o
  left join (select other from cust)   c on o.customer_id = c.other
  left join (select other from prod)   p on o.product_id  = p.other
  left join (select other from region) r on o.region_id   = r.other
```

Each branch is wrongly classified `atMostOne-left`, a `FanOutLookupJoinNode`
forms, and execution throws:

```
QuereusError: FanOutLookupJoin: branch 0 produced more than one row for outer row (got 2)
```

(`assertAtMostOne` in `runtime/emit/fanout-lookup-join.ts`.) Without the
sub-selects the same query correctly declines to cluster.

### 4. Genuinely-covered sub-selects are refused (missed optimization)

The mirror image: when a sub-select reorders columns but the join *is* on the
foreign key, the collision fails to match and a valid rewrite is skipped.

```sql
select c.id from c left join (select other, id from p) q on c.p_id = q.id;
```
must still eliminate the join. Post-fix it does — proving the fix translates
rather than merely refusing sub-selects. The fan-out equivalent (case 3's query
with `(select other, id from cust) c on o.customer_id = c.id`) likewise starts
forming a `FanOutLookupJoin` only after the fix.

## The fix

Both patches below were applied, verified against all four cases above, and run
against the full `packages/quereus` suite — **8056 passing, 0 failing**, no
golden-plan churn. Reverted before handoff; apply them verbatim.

### `rule-join-elimination.ts`

```diff
-import { checkFkPkAlignment, extractTableSchema } from '../../util/key-utils.js';
-import { lookupCoveringFK, isRowPreservingPathToTable } from '../../util/ind-utils.js';
+import { checkFkPkAlignment } from '../../util/key-utils.js';
+import { lookupCoveringFK, isRowPreservingPathToTable, mapColumnsToTable, resolveTableColumnMapping } from '../../util/ind-utils.js';
```

in `tryEliminate`:

```diff
-	const leftSchema = extractTableSchema(join.left as RelationalPlanNode);
-	const rightSchema = extractTableSchema(join.right as RelationalPlanNode);
-	if (!leftSchema || !rightSchema) return null;
+	const leftMap = resolveTableColumnMapping(join.left as RelationalPlanNode);
+	const rightMap = resolveTableColumnMapping(join.right as RelationalPlanNode);
+	if (!leftMap || !rightMap) return null;

 	// FK side is the preserved side; PK side is the side being removed.
-	const fkSchema = sideToRemove === 'right' ? leftSchema : rightSchema;
-	const pkSchema = sideToRemove === 'right' ? rightSchema : leftSchema;
-	const fkEquiCols = pairs.map(p => sideToRemove === 'right' ? p.left : p.right);
-	const pkEquiCols = pairs.map(p => sideToRemove === 'right' ? p.right : p.left);
+	const fkMap = sideToRemove === 'right' ? leftMap : rightMap;
+	const pkMap = sideToRemove === 'right' ? rightMap : leftMap;
+	const fkSchema = fkMap.schema;
+	const pkSchema = pkMap.schema;
+	const fkEquiCols = mapColumnsToTable(pairs.map(p => sideToRemove === 'right' ? p.left : p.right), fkMap);
+	const pkEquiCols = mapColumnsToTable(pairs.map(p => sideToRemove === 'right' ? p.right : p.left), pkMap);
+	if (!fkEquiCols || !pkEquiCols) return null;
```

and in the INNER-only block:

```diff
-		if (!isRowPreservingPathToTable(eliminableSide as RelationalPlanNode)) return null;
+		if (!isRowPreservingPathToTable(eliminableSide as RelationalPlanNode, { throughProject: true })) return null;
```

`throughProject: true` is what unlocks case 4's INNER variant. It is safe
*because* of the translation: the option exists solely to stop callers pairing
raw output positions against a table schema (see the option's doc comment in
`ind-utils.ts`), and a projection never removes rows. Without it the fix is
still sound but leaves the INNER sub-select rewrite on the table.

### `rule-fanout-lookup-join.ts`

```diff
-import { checkFkPkAlignment, extractTableSchema } from '../../util/key-utils.js';
-import { lookupCoveringFK, isRowPreservingPathToTable } from '../../util/ind-utils.js';
+import { checkFkPkAlignment } from '../../util/key-utils.js';
+import { lookupCoveringFK, isRowPreservingPathToTable, mapColumnsToTable, resolveTableColumnMapping, type TableColumnMapping } from '../../util/ind-utils.js';
-import type { TableSchema } from '../../../schema/table.js';
```

in `ruleFanOutLookupJoin`:

```diff
-		const outerSchema = extractTableSchema(outerSubtree);
-		if (!outerSchema) return null;
+		const outerMapping = resolveTableColumnMapping(outerSubtree);
+		if (!outerMapping) return null;
 		for (let i = joins.length - 1; i >= 0; i--) {
-			const recognized = recognizeBranch(joins[i], outerSchema, outerAttrs);
+			const recognized = recognizeBranch(joins[i], outerMapping, outerAttrs);
```

in `recognizeBranch`:

```diff
 function recognizeBranch(
 	join: JoinNode,
-	outerSchema: TableSchema,
+	outerMapping: TableColumnMapping,
 	outerAttrs: readonly Attribute[],
 ): RecognizedBranch | null {
```

```diff
-	const rightSchema = extractTableSchema(join.right);
-	if (!rightSchema) return null;
+	const rightMapping = resolveTableColumnMapping(join.right);
+	if (!rightMapping) return null;
+
+	// Translate both sides' *output* column indices to base-table column indices
+	// before pairing them against the FK/PK declarations.
+	const outerTableCols = mapColumnsToTable(outerCols, outerMapping);
+	const rightTableCols = mapColumnsToTable(rightCols, rightMapping);
+	const outerSchema = outerMapping.schema;
+	const rightSchema = rightMapping.schema;

 	// At-most-one path: FK→PK alignment guarantees ≤1 match per outer row.
-	if (checkFkPkAlignment(outerSchema, rightSchema, outerCols, rightCols)) {
+	if (outerTableCols && rightTableCols
+		&& checkFkPkAlignment(outerSchema, rightSchema, outerTableCols, rightTableCols)) {
 		if (join.joinType === 'left') {
 			return { lookup: join.right, mode: 'atMostOne-left', condition: join.condition };
 		}
 		if (join.joinType === 'inner') {
-			const match = lookupCoveringFK(outerSchema, rightSchema, outerCols, rightCols);
+			const match = lookupCoveringFK(outerSchema, rightSchema, outerTableCols, rightTableCols);
 			if (!match || match.nullable) return null;
-			if (!isRowPreservingPathToTable(join.right)) return null;
+			if (!isRowPreservingPathToTable(join.right, { throughProject: true })) return null;
 			return { lookup: join.right, mode: 'atMostOne-inner', condition: join.condition };
 		}
```

Note the deliberate asymmetry with the join-elimination patch: when translation
fails here the code falls **through to the cross path** rather than returning
null. A `cross` / `cross-left` branch is always sound (it is the data-driven
1:n treatment, gated by the row/product guards), so declining to *prove*
at-most-one should degrade the branch, not kill the whole cluster.

`outerSubtree` is never a `JoinNode` — the walker descends `.left` until it
stops being one — so a single `resolveTableColumnMapping` on it is correct. The
original ticket's worry that the outer "may span several joins" does not apply.

## Remaining work not covered by the patches

**`rule-join-key-inference.ts`** is a third caller with the same untranslated
comparison (`extractTableSchema` + raw `p.left` / `p.right`). It only emits a
`log(...)` and always returns null, so there is no correctness impact — but the
diagnostic currently lies about which joins are foreign-key joins. Translate it
the same way, or drop the log; don't leave it as the one caller still comparing
apples to oranges.

**`checkFkPkAlignment`'s contract is unstated.** Its doc comment explains the
positional-pairing rule but never says the indices must be *base-table* column
indices. Say so, and rename the parameters (`fkEquiIndices` / `pkEquiIndices` →
`fkTableCols` / `pkTableCols`) so the next caller can't repeat this.

**`isRowPreservingPathToTable`'s `throughProject` option becomes vacuous.**
After this fix all four callers (`rule-join-elimination`,
`rule-fanout-lookup-join`, `rule-semi-join-fk-trivial`, `rule-anti-join-fk-empty`)
pass `throughProject: true`. Either make it the default and delete the option,
or keep it and rewrite the doc comment — it currently justifies the default by
"callers who pass raw output indices to the FK→PK alignment check", and no such
caller will remain.

## TODO

Phase 1 — fix the two rules

- Apply the `rule-join-elimination.ts` patch above.
- Apply the `rule-fanout-lookup-join.ts` patch above.
- Update both rules' header doc comments: the FK→PK alignment step now speaks
  base-table column indices, and derived/computed join columns decline.

Phase 2 — close out the shared surface

- Translate (or remove) the alignment check in `rule-join-key-inference.ts`.
- State the base-table-index contract on `checkFkPkAlignment` and rename its
  index parameters.
- Resolve `isRowPreservingPathToTable`'s now-vacuous `throughProject` option —
  default it and drop the parameter, or fix its doc comment.

Phase 3 — tests

- `test/optimizer/rule-join-elimination.spec.ts` — add: case 1 (outer join onto
  a sub-select returns two rows AND the plan still contains a join); case 2's
  INNER variant (returns zero rows, join retained); case 4 (reordering
  sub-select that *is* foreign-key-covered still eliminates — this is the test
  that distinguishes "translates" from "refuses sub-selects"). Reuse the
  file's existing `planRows` / `joinCount` helpers.
- `test/optimizer/parallel-fanout.spec.ts` — add case 3: three sub-select
  lookup branches over `HighLatencyMemoryModule` with
  `tuning.parallel.concurrency = 2` must not form a fan-out and must return
  the right rows; the column-reordering variant must still form one. The
  file's `beforeEach` already registers the module and sets the cap.

Phase 4 — docs

- `docs/optimizer-joins.md` § "Fan-out lookup join (FK→PK + 1:n cross)"
  (line ~128) describes the alignment check — add that equi-pair indices are
  translated to base-table columns first, and that an untranslatable (computed)
  join column degrades the branch to `cross` rather than bailing the cluster.
  Check whether the join-elimination passage needs the same sentence.
- `docs/optimizer.md` is currently modified in the working tree by an unrelated
  in-flight ticket — edit around those changes, don't revert them.

Phase 5 — validate

- `yarn workspace @quereus/quereus run test` (baseline with both patches:
  8056 passing, 13 pending, 0 failing).
- `yarn lint` and `yarn typecheck`.
