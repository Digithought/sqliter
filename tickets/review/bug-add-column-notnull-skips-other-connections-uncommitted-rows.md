description: When several connections share a table, adding a column that forbids blanks only checked the rows the connection running the change could see, so another connection's in-progress rows could end up blank in that column and get saved that way; fixed so the other connection now fails instead of silently saving a blank.
files:
  - packages/quereus-isolation/src/alter-migration.ts                 # computeAddColumnValue ~line 587 — the fix
  - packages/quereus-isolation/test/isolation-layer.spec.ts           # ~line 3235 — new white-box poison test
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # ~line 431 — new SQL-driven cross-connection test
  - docs/design-isolation-layer.md                                    # ~line 858-859 — widened "ALTER: migrate, or poison" wording
---

# What was wrong

`alter table t add column c integer` (or the explicit `... not null` spelling) issued by
connection A, while connection B holds an open transaction with a staged row and the
**committed** table is empty, used to let a NULL land in the new NOT NULL column of B's
staged row and then commit it. Three separate checks existed to catch a NOT NULL ADD COLUMN
against non-empty data, and all three missed this specific shape because they only ever see
the *issuing* connection's rows (committed + its own overlay), never a foreign connection's:
the engine's `validateNotNullBackfill` pre-mutation probe, the underlying memory module's own
"non-empty table" check, and the isolation layer's own dry-run (`validateOverlayMigration` →
`computeAddColumnValue`) — whose per-row NOT NULL enforcement only ran on the per-row-evaluator
branch, leaving the folded-literal-default branch (used when there's no evaluator, i.e. no
DEFAULT, i.e. the value would be NULL) to append that NULL unchecked.

Only reachable while the committed table is empty — any committed row makes the underlying's
own check reject the ALTER before the overlay layer is ever reached.

# The fix

`computeAddColumnValue` in `packages/quereus-isolation/src/alter-migration.ts` now also throws
`CONSTRAINT` on the folded-default branch when the new column is NOT NULL and there is no
usable DEFAULT (`ctx.foldedDefault === null`). This single function backs both the pre-mutation
dry-run (`validateOverlayMigration`) and the real forward migration
(`migrateOverlayForward`/`applyInPlaceOverlayChange`), so the throw is picked up by the existing
routing with no changes needed elsewhere:

- For the **issuing** connection's own overlay, the throw fires in tier 2 (before
  `underlying.alterTable`), aborting the ALTER atomically — belt-and-braces, since the engine's
  own probe already covers this case for the issuer.
- For a **foreign** connection's overlay, the throw fires in tier 3
  (`applyInPlaceOverlayChange`), which maps `CONSTRAINT` to **poison**: that connection's next
  read, write, or commit throws instead of silently persisting the NULL. This is the documented
  design answer (`docs/design-isolation-layer.md`, *ALTER: migrate, or poison*) — a foreign
  connection's invisible rows must never abort another connection's ALTER, but must also never
  silently lose data.

Doc comments on `computeAddColumnValue`, `AddColumnBackfillContext.newColNotNull`, and
`validateOverlayMigration`'s addColumn bullet were updated (they previously stated the literal
branch's nullability was "gated up-front by the engine" — that was the bug). The design doc's
*ALTER: migrate, or poison* section was widened to name both rejection sources (an evaluator
producing NULL, and a mandatory column with no usable DEFAULT) and to note that the engine's own
probe covers only the issuing connection.

# Tests added

**`packages/quereus-isolation/test/alter-table-conformance.spec.ts`** (SQL-driven, two real
`Database` connections sharing one `IsolationModule`, `dbB`'s catalog manually mirrors `dbA`'s
table schema per the harness note in the original ticket): one test per spelling (explicit
`not null`, and the bare `add column c integer` that is mandatory under the shipped
`default_column_nullability = 'not_null'`). Each asserts: A's ALTER succeeds and sees no rows;
B's next **read** throws `CONSTRAINT` (via `rows()`/`db.eval` fully drained — `db.exec` on a
bare top-level SELECT does **not** drain the cursor, so it will NOT observe the poison; this
tripped up the first draft of this test, worth knowing if you touch it); B's **commit** throws
`CONSTRAINT`; and the committed table holds no row afterward.

**`packages/quereus-isolation/test/isolation-layer.spec.ts`** (white-box, direct
`iso.alterTable(...)` calls, same style as the existing poison suite): a NOT NULL column with
no DEFAULT and no `backfillEvaluator` poisons a foreign overlay. Needed its own fresh empty
table (`te`) because this describe block's shared `beforeEach` seeds the default table `t` with
one committed row, which would make the underlying reject the ALTER before the overlay layer is
reached — defeating the point of the test. Also be aware the block's `reader()` helper is
hardcoded to table `'t'`; a direct `iso.connect(...)` call is needed to read `'te'`.

The **negative** case — a mandatory column WITH a usable literal DEFAULT still migrates a
foreign overlay forward without poisoning it — was not duplicated; the pre-existing `ADD COLUMN
forwards a foreign overlay IN PLACE` test already covers that shape and still passes.

# What the reviewer should re-check

- The throw condition is `ctx.newColNotNull && ctx.foldedDefault === null`. `foldedDefault` is
  `null` both when there's no DEFAULT at all and when the DEFAULT expression folds to a literal
  `NULL` — both are "nothing to fill an appended row with," so both should reject. Worth
  double-checking that a literal DEFAULT that folds to a non-null value still passes through
  untouched (covered by the untouched `ADD COLUMN forwards a foreign overlay IN PLACE` test, but
  worth a second look given it wasn't rewritten for this ticket).
- I did not re-derive whether there's a symmetric hole in the `set not null` (retrofit) or
  `set data type` paths — the ticket scoped this to `addColumn` specifically, and the
  ticket's "scoped-out neighbour" section argues the issuer's-own-overlay and
  issuer-hides-committed-rows-via-DELETE cases are already handled correctly. I did not
  independently re-verify those two claims beyond re-running the existing test suite green.
- No pre-existing test failures encountered this run (`tickets/.pre-existing-known.md` is empty
  and I didn't add anything to `.pre-existing-error.md`). The ticket's own "Known pre-existing
  failure" section (an `alter-table-conformance.spec.ts` NULL-in-new-column assertion) was
  already fixed by an earlier triage pass (commit `6c24371f`) before this ticket started —
  confirmed by inspecting that commit and by the full `yarn test` run below being clean.

# Validation run

`yarn build && yarn test` (full workspace, all packages) — all green, no failures.
`yarn lint` and `yarn typecheck` — both clean (no output, exit 0) across every package.
