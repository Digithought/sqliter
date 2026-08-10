description: A 565-line method that handled every kind of ALTER TABLE in the persistent store was split into small single-purpose helpers; the refactor was confirmed behavior-preserving.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts   # alterTable dispatcher + alter* helpers + AlterColumnAttrChange
  - packages/quereus-store/test/alter-table-conformance.spec.ts   # per-arm honored/reject regression matrix
  - packages/quereus-store/test/mv-store-backing.spec.ts          # alterColumn setDataType arm
difficulty: medium
----

# Complete: decompose the 565-line store `alterTable`

Behavior-preserving refactor. `StoreModule.alterTable` was one ~565-line
`switch (change.type)` with eight arms; it is now a thin dispatcher plus one
private method per arm, with the `alterColumn` arm further split into
per-attribute sub-helpers. No SQL-visible behavior, error message, event, or
persistence side effect changed.

## Review findings

### What was checked

- **Full implement diff** (`95ece346`, 1348 lines touched in `store-module.ts`),
  read hunk-by-hunk against its pre-refactor form. Every one of the eight
  extracted arm bodies (`alterAddColumn`, `alterDropColumn`, `alterRenameColumn`,
  `alterPrimaryKeyChange`, `alterAddConstraint`, `alterDropConstraint`,
  `alterRenameConstraint`, `alterColumnChange`) is byte-identical to the original
  arm — statements and load-bearing comments preserved.
- **`alterColumn` sub-helpers** (`alterColumnSetNotNull`,
  `alterColumnSetDataType`, `alterColumnSetCollation`, plus the inline
  `setDefault` case). Confirmed the `null` sentinel exactly reproduces the two
  pre-refactor `return oldSchema` no-ops (SET NOT NULL already-in-state, SET
  COLLATE already-explicit); the dispatcher turns `null` back into
  `return oldSchema`. Confirmed each attribute path still yields the correct
  `newCol`/`collationChanged`. `alterColumnSetNotNull`'s `let newCol: ColumnSchema`
  (uninitialized) is definite-assignment-safe: the two assigning branches assign,
  the `else` returns `null`.
- **The two `!` non-null assertions** (`change.setDataType!`,
  `change.setCollation!`). Verified via `find_references` that both sub-helpers
  have a **single** call site — the `alterColumnChange` dispatcher, which gates
  each behind `change.setDataType !== undefined` / `change.setCollation !== undefined`.
  No other caller reaches them, so the assertions restore the original runtime
  narrowing without risk.
- **Ordering invariants**: throw-only validation before `ddlCommitPendingOps()`
  before any physical rewrite; non-PK UNIQUE re-validation before the PK re-key in
  `alterColumnChange`; the `renameColumn` in-place AST rewrite inside its
  `try`/reverse-on-throw `catch`. All intact — the relocated bodies carry the
  ordering and its explaining comments unchanged.
- **`rows` (`EffectiveRowSource`) threading**: reaches `alterAddConstraint` and
  `alterColumnChange` unchanged; the per-constraint single-shot `rows()`
  re-invocation in the UNIQUE re-validation loop is intact.
- **Dispatcher exhaustiveness / dropped-statement check**: the `switch` has no
  `default` and relies on union exhaustiveness (`noImplicitReturns` +
  `SchemaChangeInfo`'s eight-member union). Same shape as before; nothing trailing
  the original switch was dropped.

### What was found

- **Correctness — none.** The extraction is mechanical and faithful; no behavior
  drift found in any arm or sub-branch.
- **Minor (not fixed, cosmetic):** the relocated docstring on
  `alterColumnSetCollation` says the re-key runs in "the `isPkColumn` block
  below". That block now lives in the *parent* `alterColumnChange`, not "below" in
  the same method, and `isPkColumn` is a descriptive name, not a real variable.
  This comment is pre-existing (relocated verbatim, not introduced here) and the
  wording is harmless — left as-is to avoid churning a byte-identical relocation.
- **Tests:** unchanged, as expected for a pure refactor. The existing suites are
  the regression net. `alter-table-conformance.spec.ts` directly exercises the
  store `alterTable` across every arm and sub-branch (ADD/DROP/RENAME COLUMN,
  ALTER PRIMARY KEY, ADD/DROP/RENAME CONSTRAINT, SET NOT NULL both directions +
  existing-NULL reject, SET DATA TYPE lossy reject, SET DEFAULT, SET COLLATE
  non-PK / PK re-key / third-collation / collision reject / no-op) — a strong
  behavior floor. No new tests warranted; there is no new code path to cover.

### Tripwires

- **None filed by this pass.** The one pre-existing `NOTE:` in the SET COLLATE
  PK-member block (the `rekeyRows` PK-dedupe-vs-wrapper-`rows` gap) was relocated
  verbatim into `alterColumnChange`; still an accurate, still-conditional note.

### Validation run (all green on this branch)

- `yarn workspace @quereus/store run typecheck` — exit 0.
- `yarn workspace @quereus/store run test` — **910 passing** (includes the ALTER
  conformance matrix). Log noise (`[StoreModule] Failed to rehydrate…`, savepoint
  out-of-range) is intentional test-driven error-path logging, not failures.
- `yarn test:store` (LevelDB store-path logic tests — the plan's named primary
  net) — **6891 passing, 18 pending**.
- `yarn workspace @quereus/store run lint` — exit 0 (store ships the intentional
  `No lint configured` no-op; no `packages/quereus` source changed, so its
  eslint+tsc pass is unaffected).

## Outcome

Refactor accepted as behavior-preserving. No follow-up tickets. The
`alterTable` doc comment was refreshed to describe the dispatcher; the later
`store-stream-large-rewrites` (plan) work can change `rekeyRows` /
`mapRowsAtIndex` / `buildIndexEntries` callees without re-touching these arms, as
intended.

## End
