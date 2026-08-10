---
description: A query that combined whole numbers and decimals with UNION used to write the whole numbers into a decimal column without converting them, storing them in the wrong internal form (and failing outright if that column was the table's key); the combined column now advertises a type that honestly covers both forms, so the conversion happens.
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts     # rule 3 — the behavioral fix
  - packages/quereus/src/planner/nodes/set-operation-node.ts       # resolveDataColumns doc comment
  - packages/quereus/src/types/builtin-types.ts                    # NUMERIC physicalType tripwire NOTE widened
  - packages/quereus/test/planner/set-op-type-merge.spec.ts        # 4 assertions re-pinned to NUMERIC
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic  # SQL regression block (end of file)
  - docs/types.md                                                  # § "A set operation is a conversion site", rule 3
difficulty: medium
---

# Set-op numeric merge advertises NUMERIC, not REAL — complete

## What shipped

One behavioral edit, in `mergeSetOpColumnType` rule 3
(`src/planner/analysis/set-op-type-merge.ts`): a set operation whose two branches
have *differing* builtin numeric types now advertises `NUMERIC` for that output
column instead of promoting `INTEGER ∪ REAL` to `REAL`.

The merge converts neither branch, so a mixed stream genuinely carries both
JavaScript forms (`bigint` from the whole-number arm, `number` from the decimal
arm). `REAL`'s value space is `number` only, so the old claim was false, and
`buildRowCoercion` (`src/types/validation.ts`) believed it: seeing the producing
expression's type identical to a `real`-declared column's, it skipped conversion
as redundant and the `bigint` was stored raw (and a `real`-declared *key* threw
out of `REAL_TYPE.compare`). `NUMERIC`'s value space is `number | bigint`, so the
claim is now true, `NUMERIC !== REAL` at the DML, and the cell converts like any
other.

Read side is untouched: nothing casts, so
`select <big whole number> union all select 2.5` still returns each row in its own
storage class, matching SQLite.

## Review findings

### Checked

- **Full implement diff read first**, before the handoff summary.
- **Every consumer of the changed functions.** Two: `SetOperationNode.resolveDataColumns`
  and `AsyncGatherNode.getType` (the `unionAll` fold, `async-gather-node.ts:417`).
  The implement ticket never mentions the second; its doc comment defers to the
  set-op merge and so needed no edit, but it *is* a second live path and had no
  test. Covered now — see below.
- **Blast radius of the type swap.** `NUMERIC_TYPE.physicalType` and
  `REAL_TYPE.physicalType` are both `PhysicalType.REAL`, so nothing keyed on
  physical type changes behavior; only logical-type *identity* comparisons shift,
  which is precisely the DML skip rule this ticket targets.
- **Non-DML consumers** of the advertised type: dedup comparator for `union` /
  `intersect` / `except`, and predicate coercion. Probed directly against a built
  engine, old rule vs new — identical results in every case (details below).
- **Docs.** `docs/types.md` § "A set operation is a conversion site" rule 3 matches
  the code. `set-operation-node.ts` resolveDataColumns comment matches. Grepped for
  other stale `INTEGER + REAL → REAL` claims: the remaining hits
  (`func/builtins/scalar.ts`, `planner/nodes/scalar.ts`, `docs/types.md:995`) are
  all about *arithmetic* promotion, which is unchanged and correct.
- **Lint** (`yarn lint`, all workspaces): clean.
- **`yarn test`** (all workspaces): **0 failing**, quereus 7458 passing.
- **`yarn test:store`** (LevelDB backend — the implementer's flagged gap):
  **0 failing**, 7451 passing / 20 pending. Confirmed `28.2-set-op-branch-types`
  is not among the pending by re-running it alone under `QUEREUS_TEST_STORE=1`
  with the spec reporter — it passes on the store path.

### Found and fixed in this pass (minor)

- **Two of the new assertions were never shown to be load-bearing** (the implementer
  flagged this honestly: the 28.2 file bails on first mismatch, so only the first
  discriminator had been observed failing). Resolved by patching the *built* rule 3
  back to the old expression and probing each case directly:
  - `real primary key` fed by the mixed pair → old code throws
    `Execution error: Cannot convert a BigInt value to a number`; new code stores and
    reads back. **Load-bearing, confirmed.**
  - reversed arm order (decimal arm first) → old code stores `9007199254740993`
    raw; new code stores the rounded `9007199254740992`. **Load-bearing, confirmed.**
  - `numeric primary key` → **identical on old and new code.** That assertion does
    *not* discriminate this fix; it is a regression guard for the prereq ticket
    `numeric-comparator-rejects-bigint`. Its inline comment already attributes it
    correctly, so it was left in place rather than removed — but the implement
    ticket's framing of it as a discriminator was wrong.
- **Missing coverage: the `AsyncGatherNode` path.** Three-or-more `union all` arms
  collapse into a gather that folds the same merge, and nothing exercised it. Added
  a three-arm `real primary key` case to 28.2.
- **Missing coverage: deduplicating set operations.** `union` (distinct),
  `intersect` and `except` compare across branches under the merged type; none were
  exercised with a mixed numeric pair. Added three assertions. (Behavior is the same
  before and after the fix — they are guards, not discriminators, and are labelled
  as such.)
- **Comment bloat.** The rule-3 rationale was stated three times at full length: the
  file header, a 16-line inline block, and `docs/types.md`. Trimmed the inline block
  to 10 lines, keeping the load-bearing part — the explicit "do NOT restore
  consistency with the arithmetic promotion rules" warning must live at the code
  site, since a future cleanup that unifies them silently reintroduces this bug.
- **Stale helper doc.** `isBuiltinNumeric`'s comment said "the three builtin numeric
  types rule 3 knows how to promote among" — rule 3 no longer promotes among them,
  it collapses them. Reworded.

### Filed as new tickets (major)

None. Nothing found in this pass rose above minor; the one behavioral edit is
narrow, its two consumers both want the same semantics, and both test paths
(memory and store) are green.

### Tripwires recorded (conditional — deliberately not tickets)

- `NUMERIC_TYPE.physicalType` is `PhysicalType.REAL` even though its value space
  includes `bigint`. Harmless today — nothing encodes or rounds by `physicalType`
  (the store keys off the JS value type) — but this change makes plain
  `select 1 union all select 2.5` reach it, so the mislabel is no longer niche.
  Parked by extending the existing `NOTE:` at
  `packages/quereus/src/types/builtin-types.ts:249` with that reachability note.

### Noticed, not actioned

- `builtin-types.ts:175` uses the deprecated `String.prototype.substr`. Pre-existing,
  outside this diff, editor-diagnostic only (lint is clean). Not worth a ticket on
  its own; a passing cleanup will pick it up.
- No `test/plan/` assertion pins the advertised column type of a mixed set op
  end-to-end. The unit spec (`test/planner/set-op-type-merge.spec.ts`) asserts
  `SetOperationNode`'s `outputType` against mock operands, which covers the same
  claim one layer down, and the SQL-level effects are covered in 28.2. Judged
  redundant rather than missing.
