description: Added unit tests for two recovery behaviors of maintained-table constraint validators (degrade-to-poisoned-validator, self-heal) that SQL can no longer trigger now that the relevant DROP TABLE is refused, plus a doc sentence explaining why. Reviewed and corrected an inaccurate claim about which internal code paths actually reach those behaviors.
files:
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts
  - docs/mv-constraints.md
difficulty: easy
---

# What shipped

Five tests covering the two recovery arms of `rebuildConstraintValidatorsFor` for a
dropped subquery-CHECK target, in
`packages/quereus/test/maintained-table-declared-constraints.spec.ts` under
`constraint-dependency DDL invalidation`:

- **`subquery-CHECK target dropped out of band (poisoned validator)`** (4 tests) — a
  healthy baseline (one deferred enqueue per written image); the out-of-band drop
  resolving without the schema-change listener leaking its rebuild failure into an
  unrelated statement; a *conforming* source write rejected with the sited
  `Table 'quota' not found in schema path: main` error, zero deferred enqueues, and
  neither source nor maintained table changed; a `delete` after poisoning still
  succeeding (no row image → no CHECK), pinning the poison's blast radius.
- **`self-heal on dependency re-create`** — restored CHECK-target arm: after the
  out-of-band drop and re-create, a conforming write flows and auto-defers again, and a
  violating write is rejected with the `main.mq` attribution.

Both drive the drop through `db.schemaManager.dropTable` rather than `drop table`,
because the SQL-level drop is refused. `docs/mv-constraints.md` § Constraint-dependency
invalidation records why that coverage is unit-level rather than `.sqllogic`.

# Review findings

**Checked:** the implement diff read before the handoff summary; the code under test
(`rebuildConstraintValidatorsFor`, `makePoisonedDerivedRowValidator`,
`SchemaManager.dropTable`, `expression-drop-guard.ts`); the complete caller set of
`SchemaManager.dropTable`; the discriminating power of each new assertion; DRY against
the rest of the spec file; file size (491 lines, comfortably fine); documentation in
`docs/mv-constraints.md` and the spec's own header docblock; `yarn workspace
@quereus/quereus run lint` and `yarn test` from the repo root.

**Major — one, fixed inline rather than filed** (the fix was a wording correction, not a
code change, so there was nothing for a ticket to carry):

- *The stated justification for the tests was factually wrong.* Both the new test
  comment and the new sentence in `docs/mv-constraints.md` asserted that **transaction
  rollback** is one of the internal paths that drops a table while bypassing the
  emitter-level drop guard. It is not. `SchemaManager.dropTable` has exactly six callers
  in `packages/quereus/src`: the DROP TABLE emitter (guarded), three best-effort cleanup
  drops when a maintained table's create/import fails partway
  (`materialized-view-helpers.ts:534,561,1511`), `dropMaintainedTable`
  (`materialized-view.ts:255`), and the catalog-import collision drop
  (`manager.ts:3381`). No transaction-rollback path removes a table from the catalog at
  all — `schema.removeTable` is reached only from `dropTable` and from ALTER TABLE
  RENAME. This mattered because the whole ticket's premise is "these arms are not dead
  code", and a reader checking that premise against the named path would have found
  nothing and reasonably concluded the tests were theater. Replaced in both places with
  the two callers that genuinely can drop a table another maintained table's CHECK
  reads: catalog import on store reopen dropping a pre-existing colliding backing before
  re-materializing it under the same name (which exercises poison *and* self-heal in
  sequence), and the cleanup drop on a partway-failed create/import.

**Minor — fixed inline:**

- *DRY.* The implementer added a `withDeferredCount` helper for the new tests but left
  the three pre-existing `zero-overhead gate` tests hand-rolling the identical
  spy/restore block. Converted all three; the one that also counts `db.prepare` calls
  keeps its own prepare spy wrapped around the helper. Net −30 lines, no behavior change.
- *Stale docblock.* The spec file's header comment enumerates what the file covers and
  still listed only the original three areas — it predates the entire
  `constraint-dependency DDL invalidation` block (drift inherited from an earlier
  ticket, widened by this one). Added a bullet for it that also points at the
  out-of-band arms.
- *Comment strength.* Extended the new describe's comment with an explicit "do not fix
  this back to `drop table`" instruction, since silently losing this coverage is the
  exact failure mode that created the ticket.

**Verified and left alone:**

- The zero-deferred-enqueue assertion genuinely does discriminate. A poisoned validator
  holds a single `needsDeferred: false` check whose evaluator rejects, so it throws
  inline before the deferred queue; a healthy subquery-bearing CHECK auto-defers and
  enqueues one. Combined with a *conforming* value and the sited error substring, the
  three together pin `rebuildConstraintValidatorsFor`'s catch →
  `makePoisonedDerivedRowValidator` and nothing else. The handoff's reasoning holds.
- The self-heal test does discriminate: without the `table_added` rebuild the validator
  would still be poisoned and the conforming write would throw, so the passing assertion
  is not vacuous.
- The `expect.fail`-inside-`try`/`catch` idiom in the new poisoned-validator test lets
  an assertion failure be captured into `message`, which makes a hypothetical failure
  read a little indirectly. Left as-is: the test still *fails* correctly, and the
  identical idiom is already established two blocks up in `FK parent drop` — changing
  only the new copy would make the file inconsistent for no correctness gain.

**Tripwire — recorded, not filed:** these tests only work because the drop refusal lives
at the emitter layer, not in `SchemaManager.dropTable`. If `assertNoExpressionDependsOn`
is ever moved down into the manager, both arms become genuinely unreachable and should be
retired together with the test block rather than kept green by reaching past the guard.
Parked as a `NOTE:` on the describe block in
`test/maintained-table-declared-constraints.spec.ts`.

**Empty categories:** no new tickets filed — the one major finding was a documentation
inaccuracy fully resolved in this pass, and no finding pointed at a code site that needed
changing. No accepted-tradeoff `NOTE:` existed at any site touched. No blocked items: no
decision required a human and no dependency sat outside this repo.

# Validation

- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc` pass) — clean,
  exit 0, run again after the final comment edit.
- `yarn test` from the repo root, after every code edit — exit 0, all workspaces green.
  `packages/quereus` 9513 passing / 25 pending; no failures anywhere in the monorepo.
  No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
