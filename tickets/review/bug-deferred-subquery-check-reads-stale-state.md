description: A table rule that checks a value against another table was being applied too early (against pre-transaction data), so it could wrongly reject or wrongly accept a row; the one-line engine fix landed, and this pass adds regression tests, closes an error-message inconsistency the fix introduced, and confirms the fix left docs and a neighboring test's stale comment in sync.
files:
  - packages/quereus/src/planner/building/constraint-builder.ts        # containsSubquery — the fix (already landed before this pass)
  - packages/quereus/src/runtime/emit/constraint-check.ts               # deferred-evaluator wrapper added this pass (see below)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts          # commit-time evaluation (unchanged)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # new section 8: 3 new discriminating cases
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic # case 10 rewritten to be a real guard
  - docs/architecture.md                                               # confirmed accurate, untouched
difficulty: easy
----

# What landed this pass

The engine fix (`containsSubquery` in `constraint-builder.ts` now detects a
subquery structurally — via `isRelationalNode` on any descendant of the
scalar CHECK expression — instead of matching a fixed list of scalar node
types that missed `InNode`) was already in the working tree at the start of
this pass. This pass is the test-coverage and cleanup half described in the
ticket body.

## 1. Regression tests — `test/logic/40.2-check-extras.sqllogic`, new section 8

Three cases, using two independent table pairs so each is isolated:

- **`zt`/`zl`** — read-your-own-writes: `insert into zt` (row needs `zl` to
  contain `'a'`) happens *before* `insert into zl values ('a')`, both inside
  one `begin; … commit;`. Immediate (pre-fix) evaluation would reject this at
  the `zt` insert; the deferred check correctly waits for commit and passes.
- **`zt2`/`zl2`** — the reverse: the row that satisfies the check is deleted
  *after* the check-bearing insert, same transaction. Immediate evaluation
  would pass at insert time and never re-check; the fix catches it at
  `commit` (`-- error: CHECK`).
- **`zt3`** negative control — a plain `check (code in ('a','b'))` value list
  has no relational child and must stay immediate: it fails *inside* the open
  transaction, at the `insert` itself (not deferred to `commit`), followed by
  an explicit `rollback;` per the idiom `10.1.2-ddl-in-transaction.sqllogic`
  uses for a statement that errors mid-transaction (the harness does not
  auto-rollback an explicit transaction on error — only the implicit-tx path
  does that; see `Database.exec` / `TransactionManager.isImplicitTransaction`).

All three ran individually (`yarn test:single … --grep 40.2`) and inside the
full suite.

## 2. Case 10 of `41.11-deferred-fk-with-rename.sqllogic` — rewritten, now discriminates

The old case inserted the value `zl`-equivalent (`'a'`) into `dr_lookup`
*before* the transaction, then renamed the table — so it would have passed
even against the pre-fix immediate evaluation (nothing in the transaction
needed the deferred re-read). Its `NOTE` said as much and pointed here.

New shape: the value the check needs (`'z'`) is inserted into the table
**after** the rename, before commit — `insert into dr_lookup2 values ('z')`
following `alter table dr_lookup rename to dr_lookup2`. This now requires
*both* halves to work correctly together: the check must actually be
deferred to commit (this ticket's fix), AND the rename remap
(`DeferredConstraintQueue.notifyTableRename`, from ticket
`deferred-foreign-key-breaks-when-table-renamed-in-same-transaction`) must
correctly redirect the frozen evaluator to the table's post-rename name/data.
A regression in either would make this case fail.

The second half of case 10 (violation still reported correctly across a
rename) was left as-is — it already discriminated nothing new, no change
needed there beyond the rewritten `NOTE`.

## 3. Error-message parity between immediate and deferred CHECK — closed, not just decided

The ticket flagged that moving a CHECK from immediate to deferred evaluation
silently dropped the expression-text hint from the violation message
(immediate: `CHECK constraint failed: zt_ck (code in (select code from
zl))`; deferred, pre-pass: `CHECK constraint failed: zt_ck` — name only).

Fix: in `constraint-check.ts`, the evaluator handed to
`_queueDeferredConstraintRow` is now wrapped so it throws the SAME attributed
message (name + `(expr)` hint, when the expr is ≤60 chars) itself, at commit
time, before ever returning a falsy value to the queue's own generic
fallback in `DeferredConstraintQueue.evaluateEntry`. This mirrors the
existing pattern in `derived-row-validator.ts`'s `compileDerivedRowCheck`,
which already self-throws its own attributed message for maintained-table
constraints for the same reason.

`DeferredConstraintQueue` itself, its `DeferredConstraintRow` interface, and
`_queueDeferredConstraintRow`'s signature are all untouched — the fix is
entirely local to the wrapper closure in `constraint-check.ts`, so no
call site elsewhere (`derived-row-validator.ts`'s own queue call already
self-attributes and was not touched) needed updating.

Verified directly (ad hoc script, not a committed test — see gap below): a
deferred `zt2_ck`-shaped violation now throws exactly
`CHECK constraint failed: zt2_ck (code in (select code from zl2))`,
matching the immediate-path shape.

## 4. Docs — `docs/architecture.md` — confirmed correct, untouched

Line 136 ("Row-level CHECKs that reference other tables … are automatically
deferred and enforced at COMMIT") already describes the now-real behavior.
Read the surrounding Constraints section (lines 133–152, including the
conflict-resolution/action-semantics table) end to end; nothing else in that
section references the old broken behavior. No edit made.

## Verification

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep "40.2"` — 1 passing
- `yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep "41.11"` — 1 passing
- `yarn workspace @quereus/quereus run test` (full suite) — 7416 passing, 13 pending, 0 failing
- `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck) — clean

## Known gaps for the reviewer

- The error-message parity fix (#3) is exercised only informally (a throwaway
  script, since deleted) — the two new `.sqllogic` cases that hit the
  deferred path (`zt2_ck`, `41.11` case 10) assert only a substring
  (`-- error: CHECK` / `-- error: constraint`), not the exact message text,
  so neither pins the expression-hint text in CI. If message-shape parity
  matters enough to guard permanently, consider a assertion that checks the
  full message (the sqllogic harness's `-- error:` is substring-only, so this
  would need a `.spec.ts`-level test or a longer, more distinctive expression
  used specifically to make the substring unambiguous).
- The wrapper in `constraint-check.ts` applies uniformly to every deferred
  entry `checkCheckConstraints` queues — CHECK, `fk-child`, and `fk-parent`
  kinds all share this loop — so FK existence-check messages also gained
  their expression hint (when short enough) as a side effect. This was not
  separately tested; existing FK deferred tests (e.g. `41.11`) only assert
  the `"constraint"` substring and did not need updating, but nobody has
  pinned the exact new FK message text either.
- `yarn test:store` (LevelDB-backed logic-test run) was not run for this
  pass — the ticket's file list and TODO didn't call for it, and the changed
  files are engine-side (planner/runtime), not store-specific.
