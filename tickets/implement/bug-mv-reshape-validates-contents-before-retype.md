---
description: When a maintained table is rebuilt after one of its source columns changed type or text-sorting rule, the engine checks the rebuilt rows against the table's OLD column definition, so a row that breaks its own rule under the NEW definition gets accepted and stored. Make the check use the final column definition instead.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # validateDeclaredConstraintsOverContents (~927), rebuildBacking (~1538), attachMaintainedDerivation (~1273), graftReshapedRecord (~2391), reshapeBackingInPlace (~2474)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # 2 describe blocks pin the OLD behaviour; 4 tests must be rewritten
  - docs/materialized-views.md                                       # § REFRESH MATERIALIZED VIEW, lines ~208 and ~210 — two "Known limitation" paragraphs to replace
  - package.json                                                     # root; `//check-repr` note (line 17) + `check` chain (line 18)
repro: verified
difficulty: medium
---

# Summary

A **maintained table** derives its contents from a query over other tables. When a source
column changes its declared type (or its text-sorting rule, its *collation*), the maintained
table is **reshaped**: its own column takes the new attribute and its contents are rebuilt.

The reshape validates the rebuilt contents against the table's declared `check (…)` and
foreign-key constraints — but it does so while the table's catalog entry still carries the
**old** column attributes. So the constraints are evaluated under the wrong rules, and a row
that violates its own constraint under the final attributes is committed and survives.

The fix is **not** to reorder the reshape's steps. It is to make that one validation scan
resolve against the column attributes the reshape is about to land, rather than the ones it
is about to replace. Verified working (see *Verification* below).

# Root cause — one site

`reshapeBackingInPlace` (materialized-view-helpers.ts ~2474) runs three phases:

1. **pre-reconcile** structural column ops (rename / add / loosen-NOT-NULL / drop);
2. `rebuildBacking` — re-run the body, land the rows, **validate**, commit;
3. **post-reconcile** data-validating column ops (`retype` / `recollate` / tighten-NOT-NULL).

Phase 3 is deliberately last, and must stay last: those module ops scan and convert *stored*
rows, so running them in phase 1 would validate the about-to-be-discarded old contents and
throw spuriously. That ordering is correct and this ticket does not change it.

The defect is narrower. Inside phase 2, `validateDeclaredConstraintsOverContents`
(~927) registers a constraint-stripped clone of the live catalog record and runs the CHECK /
FK scans against it. That clone's `columns` still carry the **pre-phase-3** logical types and
collations. Two consequences fall out of that single fact:

- **Wrong comparison semantics.** A SQL comparison resolves its type affinity and its
  collation from the column's *declared* attributes. `check (v < '9')` on a column moving
  TEXT → INTEGER is evaluated as a text comparison (`'10' < '9'` is true — text compares
  character by character) and never as the numeric comparison it becomes (`10 < 9` is false).
  Same for `check (v <> 'abc')` on a column moving BINARY → NOCASE over a row `'ABC'`.

- **The scan sees rows that contradict their declared type.** The rebuilt rows already carry
  the new type's JavaScript values (integers), while the clone declares TEXT. With
  `QUEREUS_REPR_STRICT=1` the engine's physical-representation checker catches this at the
  scan and aborts the refresh outright:

  ```
  repr-strict: representation mismatch at module 'memory' query() row for main.mt column 1 (v):
  declared type TEXT admits a string, but the value is a JS number (10) (rule R2).
  ```

Both symptoms resolve at the same site, so this is one fix with two arms.

The same phase-2 scan is reached from a **second caller**: `attachMaintainedDerivation`
(~1273) calls `validateDeclaredConstraintsOverContents(db, live)` on its own reshape arm,
with the identical ordering. Both call sites must pass the previewed columns or the two paths
diverge — which is one of the two reasons `docs/materialized-views.md` currently gives for
leaving the limitation open.

## Why the documented blockers do not apply

`docs/materialized-views.md` cites two blockers for closing this:

- **Commit-first ordering** — "re-validating *after* the retype would throw with the rows
  already committed". True, and this fix does not re-validate after. It validates at exactly
  the same point as today, still before the commit, still with the pre-refresh contents
  recoverable on rejection. Only the *declared shape the scan resolves against* changes.
- **Attach-path parity** — addressed by changing both call sites together.

# Design

Add an optional `validationColumns` parameter threaded from the two reshape call sites down
to the stripped-clone construction:

```ts
// materialized-view-helpers.ts
function previewReshapedColumns(
	live: TableSchema, shape: BackingShape,
): readonly ColumnSchema[] | undefined;

export async function rebuildBacking(
	db: Database, mv: MaintainedTableSchema,
	validationColumns?: readonly ColumnSchema[],
): Promise<void>;

async function validateDeclaredConstraintsOverContents(
	db: Database, mt: MaintainedTableSchema,
	validationColumns?: readonly ColumnSchema[],
): Promise<void>;
```

`previewReshapedColumns` maps the live (post-phase-1) columns onto the target `shape`
columns **by name** — names and order already agree at that point, because phase 1 has
applied every rename / add / drop — and overrides only `logicalType` and `collation`.
It returns `undefined` when neither attribute shifts, so the non-reshape fast path and
reshapes with no `retype`/`recollate` are byte-identical to today.

`validateDeclaredConstraintsOverContents` then builds its stripped clone with
`columns: validationColumns ?? mt.columns`. The clone is already registered and restored by
an existing `try/finally`, so this introduces **no new failure window and no new catalog
state to unwind** — that is what makes the change small.

Three deliberate scoping decisions, each worth a code comment:

- **`notNull` is NOT previewed.** The tighten-NOT-NULL op stays a phase-3 module op and
  keeps validating there. Declaring `notNull` early would let the optimizer fold a
  nullability-sensitive CHECK into a vacuous pass, which is the same class of bug the
  existing constraint-stripping swap exists to avoid.
- **`defaultValue` / generated-column attributes are NOT previewed** — the reshape does not
  move them.
- **Physical primary-key columns are never affected.** `describePhysicalPkChange` already
  refuses a reshape whose key column changes type or collation, so previewing attributes can
  never desynchronize the key encoding used by `assertRefreshRowsAreSet` or by the host's
  keyed diff.

## Verified patch

This exact patch was applied, tested, and reverted during the fix stage. Reproduce it
verbatim (plus the doc-comment work below):

```diff
-async function validateDeclaredConstraintsOverContents(db: Database, mt: MaintainedTableSchema): Promise<void> {
+async function validateDeclaredConstraintsOverContents(
+	db: Database,
+	mt: MaintainedTableSchema,
+	validationColumns?: readonly ColumnSchema[],
+): Promise<void> {
 	...
-	const stripped: MaintainedTableSchema = { ...mt, checkConstraints: Object.freeze([]), foreignKeys: undefined };
+	const stripped: MaintainedTableSchema = {
+		...mt,
+		columns: validationColumns ?? mt.columns,
+		checkConstraints: Object.freeze([]),
+		foreignKeys: undefined,
+	};

-export async function rebuildBacking(db: Database, mv: MaintainedTableSchema): Promise<void> {
+export async function rebuildBacking(
+	db: Database,
+	mv: MaintainedTableSchema,
+	validationColumns?: readonly ColumnSchema[],
+): Promise<void> {
 	...
-	await validateDeclaredConstraintsOverContents(db, backing);
+	await validateDeclaredConstraintsOverContents(db, backing, validationColumns);

 // attachMaintainedDerivation
-		await validateDeclaredConstraintsOverContents(db, live);
+		await validateDeclaredConstraintsOverContents(db, live,
+			reshapePlan ? previewReshapedColumns(live, shape) : undefined);

 // reshapeBackingInPlace
-	await rebuildBacking(db, live);
+	await rebuildBacking(db, live, previewReshapedColumns(live, shape));

+function previewReshapedColumns(live: TableSchema, shape: BackingShape): readonly ColumnSchema[] | undefined {
+	const byName = new Map(shape.columns.map(c => [c.name.toLowerCase(), c]));
+	let shifted = false;
+	const preview = live.columns.map(col => {
+		const target = byName.get(col.name.toLowerCase());
+		if (!target) return col;
+		if (backingTypeMatches(col, target) && backingCollationMatches(col, target)) return col;
+		shifted = true;
+		return { ...col, logicalType: target.logicalType, collation: target.collation };
+	});
+	return shifted ? Object.freeze(preview) : undefined;
+}
```

# Verification already performed (fix stage)

With the patch applied:

- `packages/quereus/test/maintained-table-refresh-revalidation.spec.ts` under
  `QUEREUS_REPR_STRICT=1`: 19 passing, 4 failing — and **all four failures are the
  limitation-pinning tests now getting the correct rejection**, e.g.
  `CHECK constraint failed: _check_0 (v < '9') — row derived into maintained table 'main.mt'
  violates its declared constraint`. The three repr-strict representation mismatches are gone.
- Full quereus suite, no bail: **9074 passing, 4 failing** — the same four. Zero collateral.
- Full quereus suite under `QUEREUS_REPR_STRICT=1`, no bail: **9083 passing, 4 failing** —
  the same four. So once the four pins are rewritten, `yarn test:repr-strict` is clean.
- `tsc -p packages/quereus/tsconfig.json --noEmit`: clean.

Commands used (the packaged runner passes `--bail`, which hides all but the first failure —
use the direct mocha invocation to enumerate):

```bash
QUEREUS_REPR_STRICT=1 node --import "file:///C:/projects/quereus/packages/quereus/register.mjs" \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" \
  --timeout 20000 --reporter min --no-bail
```

# New expected behaviour (what the rewritten tests must pin)

For **both** the retype and the recollate reshape arms:

- A refresh whose recomputed set contains a row violating a declared CHECK **under the final
  column attributes** throws the maintained-table-attributed diagnostic
  (`row derived into maintained table 'main.mt'`) and commits nothing.
- The pre-refresh committed contents survive, and the table stays stale — same guarantee the
  non-reshape arm already gives.
- Because phase 3 never runs on a rejected refresh, the catalog column keeps its **old**
  type / collation after the rejection. The existing `vType` / `vCollation` helpers were used
  as proof the reshape arm ran; on the reject path they now prove the opposite. Get the
  "reshape arm was taken" evidence from a *successful* refresh instead — e.g. correct the
  offending source row, refresh again, and assert the attribute flipped.
- The two "next maintenance re-validates under the NEW …, but the already-committed row is
  frozen" tests describe a state that is no longer reachable through this path (nothing gets
  frozen, because nothing gets committed). Their real subject — that the row-time derived-row
  validator enforces the new attribute on ordinary writes — is still worth keeping; re-reach
  it from a clean successful refresh rather than from the limitation state.
- Keep both type-**insensitive** / collation-**insensitive** control tests as-is; they must
  still pass unchanged.

# Residual gaps to record as `NOTE:` tripwires, not tickets

- The CHECK is evaluated against the rebuilt values in their **pre-conversion** physical
  form, but under the **post-conversion** declared type. In practice these agree: the target
  attribute is derived *from* the body's own output type, so the body already produces
  values in the new type. A retype whose conversion genuinely rewrites the value (text → date
  canonicalization, `'2024-06-05T00:00:00Z'` → `'2024-06-05'`) would have the CHECK see the
  un-normalized spelling. Park a `NOTE:` at `previewReshapedColumns`; do not chase it.
- With the preview in place, a body that emits a value not conforming to its own declared
  output type will now trip `QUEREUS_REPR_STRICT` at this scan. That is a genuine defect
  surfacing, not a regression — say so in the `NOTE:`.

# TODO

- Add `previewReshapedColumns` and thread `validationColumns` through `rebuildBacking` and
  `validateDeclaredConstraintsOverContents`, per the verified patch above.
- Wire both reshape call sites: `reshapeBackingInPlace` and `attachMaintainedDerivation`.
- Add the three scoping comments (notNull not previewed and why; defaults untouched; PK
  columns unreachable) plus the two `NOTE:` tripwires above.
- Rewrite the stale limitation prose in `materialized-view-helpers.ts`: the block inside
  `rebuildBacking` (~1592-1607) and the `NOTE:` inside `reshapeBackingInPlace` (~2527-2534).
  Both currently assert the corner is open. Leave `classifyBackingReshape`'s post-reconcile
  rationale (~2190-2196, ~2212-2225) intact — it is still true of the module ops.
- Rewrite the two `describe` blocks in `maintained-table-refresh-revalidation.spec.ts`
  (`reshape arm: collation-sensitive CHECK` and `reshape arm: type-sensitive CHECK`) and the
  spec's header comment, per *New expected behaviour* above.
- Replace the two `**Known limitation —**` paragraphs in `docs/materialized-views.md`
  (§ REFRESH MATERIALIZED VIEW, ~lines 208 and 210) with a description of the enforced
  behaviour and how it is achieved. Note explicitly that commit-first ordering is preserved
  and that both refresh and attach reshape arms behave identically.
- Root `package.json`: delete the `//check-repr` note (line 17) and append
  `&& yarn test:repr-strict` to the `check` chain (line 18).
- Validate: `yarn lint`, `yarn build`, `yarn typecheck`, `yarn test`, `yarn test:repr-strict`
  — all must be clean. `yarn test:store` is worth one run too: the store backend has its own
  retype leg (`packages/quereus-store/src/common/store-module-alter-column.ts`), though this
  change touches only engine-side catalog records and should not reach it.
