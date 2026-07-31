---
description: Joining two tables with the short `using (col)` syntax returned no rows in cases where writing the join out longhand returned rows, whenever the two columns held different kinds of data. The short form now builds the exact same comparison the longhand form builds, so the two always agree.
files:
  - packages/quereus/src/planner/building/select.ts                          # buildUsingCondition + buildUsingColumnEquality + buildUsingOperand
  - packages/quereus/src/planner/building/expression.ts                      # buildComparison — the shared comparison-construction helper
  - packages/quereus/src/planner/nodes/join-node.ts                          # toString prefers USING; withChildren drops the label on a rewritten condition
  - packages/quereus/src/runtime/emit/join.ts                                # usingResolved + evaluateUsingCondition deleted
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts           # extractEquiPairsFromUsing + UsingAttr deleted
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # USING branch dropped
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts     # USING branch dropped
  - packages/quereus/src/planner/analysis/comparison-collation.ts            # isValueDiscriminatingTypePair + TypeSlice deleted
  - packages/quereus/test/logic/11.1-join-using.sqllogic
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts
  - packages/quereus/test/plan/join-selection.spec.ts
  - packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts
  - docs/types.md, docs/sql-select.md, docs/optimizer-joins.md, docs/optimizer-parallel.md, docs/optimizer-fd.md
---

# `using (c)` desugars to `on l.c = r.c`

## What shipped

`buildJoin` used to store a USING join's column names on the `JoinNode` and build **no**
condition. Three separate consumers then re-derived the comparison from those bare
names, and cross-type coercion — the step that makes `=` compare a JSON document
against a text document structurally, and an integer against a numeric string
numerically — was mirrored into none of them, so `using (k)` over a JSON/TEXT or
INTEGER/TEXT pair matched nothing where the spelled-out `on l.k = r.k` matched.

`buildJoin` now calls `buildUsingCondition`, which synthesizes one `l.c = r.c` conjunct
per USING column and AND-combines them into `JoinNode.condition`. Each conjunct is
built through `buildComparison` (`planner/building/expression.ts`) — the *same* helper
the `binary` case of `buildExpression` uses — so cross-type coercion and the
collation-lattice validation apply to both spellings by construction.

Operand references are built from the two sides' attributes (first match per side by
name), not resolved through the join scope: a USING column can legitimately be
ambiguous by name within one side (`a join b using (k) join c using (k)`).

Three parallel implementations were deleted rather than left dead: the emitter's
`evaluateUsingCondition` / `usingResolved`, `extractEquiPairsFromUsing` plus the USING
branches in both physical-selection rules, and `validateUsingCollations`. With the last
of these gone, `isValueDiscriminatingTypePair` / `TypeSlice` in
`planner/analysis/comparison-collation.ts` lost their only caller and went too.

`JoinNode.usingColumns` survives (part of the `JoinCapable` interface) and `toString()`
prefers the `USING(...)` spelling so EXPLAIN stays faithful to what was written.

## User-visible behavior changes

- **Cross-type USING pairs now match**, identically to the ON spelling.
- **A USING column absent from a side now raises** (`USING column not found on <side>
  side of join: <name>`, `StatusCode.ERROR`) where it previously returned zero rows in
  silence. Reviewed and kept: SQLite errors here too, and a silent empty result is the
  worse failure mode.
- **`full outer join … using (k)` now folds** into the parallel async-gather
  zip-by-key plan, because the chain walk reads `JoinNode.condition` and there now is
  one.
- **Multi-column USING with one unsound column improved**: the sound column still keys
  the join and only the unsound conjunct demotes to residual (the old extractor sank
  the whole extraction for want of a residual).
- **Cross-type USING pairs run as nested loop** — the coerced operand is a `CastNode`
  and `extractEquiPairs` only recognizes `ColumnReference = ColumnReference`. Intended:
  the ON spelling already did exactly this for the same pair.

## Review findings

Read the implement diff (`c1335025`) before the handoff summary. Checked: the desugar
against how `buildExpression` builds a comparison; `ColumnReferenceNode`'s
`columnIndex` semantics at runtime (resolution is by `attributeId`, so side-relative
indices match what the ON path produces); every remaining `usingColumns` reader and
every `new JoinNode(` site; `extractEquiPairs`'s handling of an undefined condition;
parser reachability of the guards; NULL semantics against the deleted emitter guard;
and every doc that mentions USING or the deleted symbols.

**Fixed in this pass (minor):**

- *Duplicated comparison-construction recipe.* `buildUsingCondition` re-implemented the
  exact three steps `buildExpression`'s `binary` case performs (coerce operands →
  construct `BinaryOpNode` → force `getType()` for the collation lattice). Since the
  whole point of the ticket is that USING must not re-implement `=`, that recipe is now
  one exported helper, `buildComparison` (`planner/building/expression.ts`), and both
  sites call it. `buildExpression`'s branch also lost its two `let`s and its
  double `COMPARISON_OPS` test.
- *`buildUsingCondition` was one 35-line function doing three jobs.* Split into
  `buildUsingCondition` (conjunct assembly) → `buildUsingColumnEquality` (one pair) →
  `buildUsingOperand` (one side's reference, including the not-found error). Error
  precedence (left reported before right) is unchanged.
- *One shared `AST.ColumnExpr` object was handed to both sides' `ColumnReferenceNode`s
  and carried no relation qualifier.* Each side now gets its own expression, qualified
  with `attr.relationName` — matching how `rule-predicate-inference-equivalence`
  synthesizes an equality.
- *ON and USING were sequential `if`s, so a `JoinClause` carrying both would have had
  its ON condition silently overwritten.* Now `else if`, mirroring the parser, which
  accepts one or the other.
- *`toString()` preferring `USING(...)` can misreport a rewritten predicate.* No rule
  changes a USING join's condition today, but `JoinNode.withChildren` is a generic
  framework path that permits `newCondition !== this.condition`, and it threaded
  `usingColumns` through regardless. It now drops the label when the condition changed,
  so EXPLAIN cannot claim `USING(k)` over a different predicate.
- *`as unknown as any` on the test scope*, against the project's no-`any` rule, in the
  block this ticket added (and in the pre-existing sibling block it was copied from).
  Both are now `const scope: Scope = EmptyScope.instance` — no cast was ever needed.
- *Stale path in `docs/types.md`*: `insertCrossTypeCoercion` was cited as living in
  `planner/building/expression.ts`; it is in `planner/building/coercion.ts`.

**Test gaps closed:**

- `11.1-join-using.sqllogic` — cross-type USING under a LEFT join (null-extension over
  a coerced condition, which the added coverage did not exercise), and a multi-column
  USING where only one column is cross-type (the sound column keys the join while the
  coerced conjunct must still filter). Each paired with the ON spelling.
- `equi-pair-semantic-gate.spec.ts` — the empty-column-list guard (flagged as untested
  in the handoff) and a multi-column USING extracting both pairs.
- `join-selection.spec.ts` — the `USING(...)` vs `ON condition` EXPLAIN label was a new
  behavior with nothing pinning it, and it now interacts with the `withChildren`
  change. Two cases pin both spellings over a cross-type pair (which keeps the generic
  `JoinNode`, so the label is the only difference left).
- The new sqllogic assertions were negative-controlled: perturbing one expected row set
  fails the file, so the added blocks are genuinely executed.

**Docs:** `docs/sql-select.md`'s one-line `using (...)` entry now states that USING is
shorthand for the equivalent ON predicate and identical to it, that Quereus does not
merge the shared column (so the bare name is ambiguous), and that an absent column is
an error — none of which was written down anywhere user-facing. `docs/types.md` names
`buildComparison` as the shared construction point.

**No findings** in: resource cleanup (the change removes emit-time state rather than
adding any), error handling (the one new throw is a `QuereusError` at plan time, and no
exception is swallowed), type safety in `src/` (no `any` introduced; the deleted
`UsingAttr` structural type was itself a weakening), or source-file size (`select.ts`
grew by ~30 net lines and the new functions are 8–20 lines each).

**Deliberately not filed as tickets:**

- `getLogicalAttributes()` reports `hasCondition: true` for a USING join, which is now
  always true and therefore no longer discriminating. Accurate, just uninformative —
  not worth a ticket.
- `ColumnReferenceNode.toString()` qualifies with `expression.schema` but ignores
  `expression.table`, so every column reference in an EXPLAIN condition prints bare
  (`k = k`). Pre-existing, affects ON and USING equally, and changing it would move
  golden plan output — out of scope here.

## Tripwire (recorded, not a ticket)

The nested-loop USING path used to resolve one comparator per column at emit time; it
now evaluates a condition sub-program per row pair, like every ON join. Only USING
joins that fall back to nested loop (cross-type pairs, existence-flag joins) pay this.
**Not measured**, before or after. If a USING-heavy workload ever profiles slower, the
fix belongs in the shared ON-condition evaluation path, not in a restored USING special
case. Recorded as a `NOTE:` in the `buildUsingCondition` doc comment
(`planner/building/select.ts`).

## Validation

`yarn build`, `yarn lint`, `yarn test` — all clean. Quereus: 8193 passing, 13 pending,
0 failing; lint clean across every package. No pre-existing failures surfaced.

`yarn test:store` (LevelDB path) was **not** run — it re-runs the same logic corpus
including `11.1-join-using.sqllogic`, so it is the one untried surface, though nothing
in the diff is store-specific.
