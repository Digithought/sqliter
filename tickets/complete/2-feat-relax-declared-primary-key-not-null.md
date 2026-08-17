---
description: A table that names its identity columns out loud is no longer forced to fill them in — declaring a primary key now means exactly what leaving it undeclared meant, so the two spellings accept the same values.
files:
  - packages/quereus/src/schema/manager.ts, table.ts, schema-differ.ts, lens-prover.ts
  - packages/quereus/src/runtime/emit/alter-table.ts, materialized-view-helpers.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts, alter-column.ts
  - packages/quereus-store/src/common/store-module-alter-column.ts
  - docs/schema.md, sql-constraints.md, sql-txn.md, sql-alter.md, materialized-views.md, module-authoring.md, view-updateability.md
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic (new)
  - packages/quereus/test/nullable-primary-key-round-trip.spec.ts (new)
  - packages/quereus-store/test/nullable-primary-key-persistence.spec.ts (new)
---

# Complete: `PRIMARY KEY` no longer implies `NOT NULL`

## What shipped

`primary key` names the row identity and nothing else. A key column keeps the nullability it
declared (`x integer null primary key`) or the one `pragma default_column_nullability` gave
it — the rule that already governed the all-columns key Quereus synthesizes for a table with
no `PRIMARY KEY`. Declared and synthesized spellings of one key now produce identical
schemas. Under the shipped `not_null` default nothing observable moves, because every column
is NOT NULL unless it says otherwise.

Five refusals were removed across three rules: `ALTER PRIMARY KEY (<nullable column>)` (engine
emitter + memory manager) and `ALTER COLUMN <key col> DROP NOT NULL` (engine emitter + memory
layer + store module). `Cannot SET DATA TYPE on PRIMARY KEY column` was kept deliberately — a
retype moves the key's comparator, a different rule, out of scope. The materialized-view
backing still keeps its ordering-seeded physical-key columns NOT NULL; that is now a policy of
the backing (enforced by the refresh reshape's mask) rather than an engine constraint.

Behaviour is pinned by `test/logic/43.3-nullable-primary-key.sqllogic` (12 sections, memory and
store backends), a DDL round-trip / `apply schema` spec, and a store persistence spec that
reopens through `rehydrateCatalog`. Existing databases do not retroactively loosen: their
persisted DDL text spells the tightening out, so the re-parse keeps it.

## Review findings

### Major — filed

- **Writing through a join view misidentifies rows whose key holds NULL.**
  `tickets/fix/1-bug-multi-source-view-write-misreads-null-keys.md` (`repro: verified`, both
  arms reproduced on the tree at review time). Multi-source (join) view writes identify rows
  through a pre-mutation key capture whose readers correlate with plain `=`, and whose
  outer-join branches read "all of a side's captured key columns are NULL" as "that side had
  no join partner". Both were sound only while every key column was NOT NULL; this ticket made
  a nullable key column reachable, so a real row keyed NULL is now unaddressable by the
  correlation and indistinguishable from a null-extension. Symptoms observed: an inner-join
  view `update` of a NULL-keyed side reports success and changes nothing; a left-join
  non-preserved-side `update` of a *matched* NULL-keyed partner mints a duplicate partner row
  (or fails with a spurious `UNIQUE constraint failed` when the key has no DEFAULT to mint
  from). Filed at the invariant, not the two symptoms: one NULL-safe correlation helper the
  four capture readers share, plus an explicit match marker so "had no partner" stops being
  inferred from NULLness. No open ticket claimed `multi-source.ts`. A `KNOWN HOLE:` note at
  `MS_UPDATE_KEYS_CTE` and a caveat in `docs/view-updateability.md` § `returning` point at it,
  because both stated the now-false assumption as the contract.

### Minor — fixed in this pass

- `docs/module-authoring.md` told module authors that `runAlterPrimaryKey` validates "every
  member NOT NULL" before dispatch. It no longer does; a module keeping its own such pre-check
  would refuse statements the engine accepts. Rewritten, and the `alterColumn.setNotNull` row
  now states the obligation that matters for a *key* column: the null → DEFAULT backfill moves
  key values, so it must be treated as a re-key (collision pre-check + physical re-key), while
  loosening must be accepted as metadata-only.
- The same stale claim in the `rekeySchemaPrimaryKey` doc comment (`schema/table.ts`) — the
  source of that documentation — rewritten.
- `multi-source.ts`'s at-most-one partner proof justified its NULL handling with "(PK columns
  are NOT NULL regardless)". The proof still holds (key equality is NULL-self-equal, so
  uniqueness over pinned non-null values is if anything stronger), but the stated reason was
  false; corrected in place.
- `alterColumnSetNotNull` in `quereus-store` kept a now-unused `_oldSchema` parameter after its
  refusal was deleted. Removed, with the call site.
- Test coverage added for the gap the implementer named honestly in the handoff: `apply schema`
  over a **populated** nullable key holding NULL (the empty-table case proves the differ
  computes no phantom `SET NOT NULL`; it cannot prove what one would *do*). The new case would
  fail loudly — by rejection or by a backfilled key — if `extractDeclaredNotNull` ever
  re-learns the promotion.
- `43.3` § 2 gained two pins the corpus was missing: `where x = null` matches nothing even
  though key equality is NULL-self-equal (the two rules coexist, and this exercises the
  point-seek arm that short-circuits a literal-NULL key equality), and an equi-join never
  reaches a NULL-keyed row — the same three-valued rule the join-view bug above trips over.

### Checked and clear

- **Planner inference of non-nullability from key membership** — the class this change could
  most plausibly have broken. `planner/analysis/key-filter.ts` builds its NULL-safe residual
  off the column's declared nullability, not off key membership, so nullable key columns now
  correctly take the NULL-safe form. `rule-select-access-path.ts`'s literal-NULL point-seek
  short-circuit is SQL comparison semantics, unaffected by key semantics. FK join elimination
  still requires the *child* FK columns NOT NULL and is unaffected by a nullable parent key (an
  equi-join cannot match one). The MV plan builders gate on the `notNull` flag directly. No
  site was found deriving `notNull` from `primaryKey`.
- **The MV reshape mask** — the implementer's own top concern. `loosenNotNull` has exactly one
  producer (`classifyBackingReshape`, where the physical-PK mask sits) and one consumer, both
  in `materialized-view-helpers.ts`, so no second path reaches a backing `drop not null` on a
  physical-PK column now that the manager's throw is gone. The mask is computed independently
  of the memory manager; both reshape specs pass.
- **The lens prover's blunt NOT NULL gate** — the tripwire the implementer parked there is
  accurate: rejecting a nullable PK column costs a missed shortcut, never soundness. Left as
  recorded.
- **Non-retroactive loosening** — re-confirmed: the tightening is baked into persisted DDL
  text, so a reopen re-parses it as NOT NULL. Pinned in-process and through a real store
  close/reopen.
- **Source hygiene** — the diff removes code paths and adds none; every remaining comment at a
  touched site was re-read against the new reality (the ones that still stated the old rule are
  in the fixed list above). No file grew.

### Tripwires

No new ones. The three the implementer parked (`lens-prover.ts` blunt gate,
`materialized-view-helpers.ts` backing policy, `table.ts` partial conflict-action guard) were
re-read and are accurately stated. The join-view finding was deliberately **not** demoted to a
tripwire: it is wrong today on a path a user can reach, not conditional on a future change.

### Validation

- `yarn build` — clean
- `yarn test` — exit 0, 13m34s; `packages/quereus` 9638 passing / 25 pending / 0 failing, plus
  every other workspace green (`quereus-store` 1804 passing)
- `yarn lint` — clean (64s)
- `yarn typecheck` — clean (55s)
- `43.3-nullable-primary-key.sqllogic` re-run under the LevelDB store backend
  (`node test-runner.mjs --store --grep 43.3`) — passing, so the two new assertions hold on both
  backends
- A full `yarn test:store` sweep was **not** re-run: this pass changed one store source line (a
  dead parameter, covered by typecheck and the store's own 1804 cases) and otherwise touched
  docs, comments, and tests. The implementer ran the full store sweep on the same logic.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
