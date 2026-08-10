description: A table rule that checks a value against another table was being applied too early, against data as it looked before the transaction started, so it could wrongly reject or wrongly accept a row. Fixed, covered by regression tests, and the violation message is now identical whether the rule runs immediately or at commit.
files:
  - packages/quereus/src/planner/analysis/scalar-subqueries.ts          # hasRelationalDescendant — now the single subquery-detection helper
  - packages/quereus/src/planner/building/constraint-builder.ts         # CHECK auto-deferral decision
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts      # MV-rewrite residual gate (de-duplicated onto the helper)
  - packages/quereus/src/runtime/emit/binary.ts                         # AND/OR short-circuit gate (de-duplicated onto the helper)
  - packages/quereus/src/runtime/emit/constraint-check.ts               # constraintViolationMessage — shared by immediate + deferred paths
  - packages/quereus/src/runtime/deferred-constraint-queue.ts           # commit-time evaluation (comment only)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic              # section 8 regression cases
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic  # case 10 — rename × deferred-CHECK interaction
----

# What the bug was

A `CHECK` constraint that reads another table (`check (code in (select code
from lookup))`) must be evaluated at `COMMIT`, not when the row is written —
otherwise it sees the database as it looked before the transaction started and
can reject a row that will be legal by commit, or accept one that will not be.

The engine decided "does this CHECK read another table?" by matching the
expression against a fixed list of expression node types. That list did not
include `IN (subquery)` — it parses to a node the list did not name — so
membership checks silently ran at write time against pre-transaction data.

# What landed

**Engine fix** (`constraint-builder.ts`, landed in the fix stage): detect the
subquery *structurally* — is there a relational node anywhere under the scalar
expression — instead of enumerating node types. New subquery shapes are covered
for free; `in (<value list>)` has no relational child and correctly stays
immediate.

**Message parity** (`constraint-check.ts`, landed in the implement stage): a
deferred violation used to lose the expression-text hint, so the same broken row
reported differently depending on when the check happened to run. The evaluator
handed to the deferred queue now throws its own fully attributed message.

**Regression tests** (`40.2-check-extras.sqllogic` section 8, implement stage):
read-your-own-writes (value arrives later in the transaction), the reverse
(value deleted later in the transaction), and a value-list negative control that
must stay immediate. `41.11` case 10 rewritten so the value the check needs is
inserted *after* an `ALTER TABLE … RENAME`, making it a real joint guard on both
deferral and the deferred-queue rename remap.

## Review findings

### Checked and clean — no action

- **Docs.** `docs/architecture.md` lines 133–152 (the Constraints section, incl.
  the conflict-resolution table) read end to end. Line 136 already describes the
  now-real behavior; line 143's row-time-under-non-default-conflict carve-out is
  still accurate. `docs/lens.md` 280/289 describe lens-routed deferred checks
  and are unaffected. No doc names the changed helpers. Nothing to edit.
- **Blast radius of widening `needsDeferred`.** Traced every consumer of the
  deferral flags. `check-extraction.ts:isRowInvariantCheck` reads
  `RowConstraintSchema.deferrable` (the *schema* object, which SQL cannot set —
  the parser rejects `DEFERRABLE` on CHECK), not the plan-level flag this fix
  changes, so optimizer check-extraction is untouched.
  `database-materialized-views-apply.ts:164` correctly starts pinning a backing
  connection for maintained tables whose subquery CHECK now defers — that is the
  intended consequence, not a regression.
- **FK-kind entries sharing the deferred wrapper.** The implement handoff logged
  this as an untested side effect. It is not one: the immediate path has always
  emitted the same `CHECK constraint failed: <name>` prefix for synthesized FK
  existence checks (documented at the throw site), so the wrapper preserves
  parity rather than inventing a new FK message.
- **Test discrimination.** Each of the four cases was re-derived against
  pre-fix behavior to confirm it actually fails without the fix. The value-list
  negative control discriminates too: were it wrongly deferred, the `insert`
  would succeed and the harness would fail with "expected error … but SQL block
  executed successfully".
- **Full suite + lint.** `yarn test` across all workspaces: green.
  `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck):
  clean. No pre-existing failures surfaced, so no
  `tickets/.pre-existing-error.md` was written.

### Minor — fixed in this pass

- **The implement handoff's own stated gap: nothing pinned the message-parity
  fix in CI.** The handoff called this untestable via `.sqllogic` because
  `-- error:` is substring-only. That reasoning is wrong — a substring can be
  the *whole* message. `40.2` now asserts the exact text on both sides of the
  parity claim: `CHECK constraint failed: zt2_ck (code in (select code from
  zl2))` on the deferred path, and the matching immediate-path message on the
  value-list control (which gained a constraint name so it has one to assert).
- **The message was built twice, in two places, from the same fields** — once
  in the deferred wrapper, once at the immediate throw site — which is exactly
  how the parity being fixed was lost in the first place. Extracted
  `constraintViolationMessage(metadata)` in `constraint-check.ts`; both paths
  call it, so they cannot drift again.
- **Four copies of the same relational-descendant walk.** `constraint-builder`,
  `query-rewrite-matcher`, `runtime/emit/binary`, and a partially-written
  extraction left behind by an interrupted earlier run of this ticket. Since
  this ticket's entire root cause was one such copy being subtly wrong,
  consolidated all three live call sites onto
  `hasRelationalDescendant` in `planner/analysis/scalar-subqueries.ts`, which
  carries the rationale and lists its callers. `binary.ts`'s stale
  "mirrors `conjunctHasSubquery` in query-rewrite-matcher" comment went with it.
  (`database-materialized-views-analysis.ts:isSingleRowEvaluable` deliberately
  left alone — it fuses the relational test with a column-provenance test in one
  walk, so it is not a duplicate.)

### Major — none

No finding warranted a new ticket. The fix is one predicate, its consumers were
traced exhaustively (above), and the behavior change is in the intended
direction everywhere it lands.

### Tripwires — recorded in code, not filed as tickets

- `DeferredConstraintQueue.evaluateEntry`'s generic name-only violation message
  is now unreachable: both enqueue sites self-attribute. Left in place as a
  safety net with a `NOTE:` at the site saying so, and saying that a future
  caller should be taught to self-attribute rather than this generic message
  being enriched.
- Two pre-existing `NOTE:` tripwires in `deferred-constraint-queue.ts`
  (rename stamping is not layer-scoped, and `notifyTableRename` is O(entries)
  per rename) were re-read and still hold; not re-recorded.

### Not done, deliberately

- `yarn test:store` (LevelDB-backed re-run of the logic tests) was not run. The
  change is planner/runtime-side with no store-specific surface, and per
  `AGENTS.md` the store run is for store-specific diagnosis or release prep.
