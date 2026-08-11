---
description: A write into a table column used to trust the type label the engine had inferred for the value, so a value of the wrong kind (a number into a text column) could reach storage unchanged. Writes now also check the value itself before deciding whether to convert it.
files:
  - packages/quereus/src/types/representation.ts            # conformsToType / buildConformanceCheck (moved down a layer from runtime/)
  - packages/quereus/src/types/validation.ts                # buildCellCoercion; buildRowCoercion built on it
  - packages/quereus/src/runtime/strict-representation.ts   # imports the predicate instead of defining it
  - packages/quereus/src/planner/building/alter-table.ts    # ADD COLUMN backfill takes the shared decision
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # AddColumnBackfill.coerce (a closure)
  - packages/quereus/src/runtime/emit/alter-table.ts        # applies backfill.coerce
  - packages/quereus/src/runtime/emit/constraint-check.ts   # OR REPLACE NOT NULL DEFAULT substitution
  - packages/quereus/src/runtime/emit/dml-executor.ts       # ON CONFLICT DO UPDATE assignments + upsert NOT NULL defaults
  - packages/quereus/src/runtime/row-constraints.ts         # NotNullDefaultRuntime.coerce
  - packages/quereus/src/runtime/emit/insert.ts             # (review) comment now states the guarded rule
  - packages/quereus/src/runtime/emit/update.ts             # (review) same
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts # (review) rationale restated under the guard
  - packages/quereus/src/func/builtins/datetime.ts          # (review) accepted-tradeoff NOTE replaces a dangling ticket slug
  - packages/quereus/test/types/representation.spec.ts      # (review) NEW — enumerates every conformance arm
  - packages/quereus/test/types/row-coercion.spec.ts        # unit tests (16 after review)
  - packages/quereus/test/dml-write-representation.spec.ts  # engine-level regressions (20 after review)
  - docs/types.md                                           # § Where coercion happens, § Enforcement, ALTER backfill bullets
---

# What shipped

Every DML write converts each cell to its target column's declared logical type once, at
the top of the pipeline, then tells storage `preCoerced` so no layer converts again. The
decision about which cells to convert was purely static: compare the producing
expression's announced `LogicalType` against the column's declared type by object
identity, and skip on a match. The skip had a real reason (re-converting is destructive
for JSON — `parse` reads a plain JS string as JSON *source*), but an announced type is an
inference the engine does not enforce, so a wrong announcement let a non-conforming value
reach storage: `sum()` announces REAL and can return a `bigint`; an untyped positional `?`
announces TEXT and can be bound to anything.

The skip is now a **conjunction**: convert unless the announced type IS the column's type
**and** the value in hand already inhabits that type. "Inhabits" is `conformsToType`, rule
R2 of `docs/types.md` § Physical representation, moved from `runtime/strict-representation.ts`
down into a new `src/types/representation.ts` so the `QUEREUS_REPR_STRICT` checker and the
write path share one definition and cannot drift. `buildCellCoercion` in `types/validation.ts`
returns the per-cell closure (or `undefined` when there is provably nothing to do), and
every write seam that used to open-code the identity comparison now calls it: `buildRowCoercion`
(INSERT and both UPDATE phases), the ADD COLUMN per-row backfill, the `OR REPLACE` NOT NULL
DEFAULT substitution, the `ON CONFLICT … DO UPDATE` assignments, and the upsert arm's own
NOT NULL defaults.

# Review findings

Reviewed the implement diff (`659f2093`) before its handoff summary, then the surrounding
call sites, the docs the change touches and the ones it should have touched, and the
existing regression net in `test/logic/06.9.1-json-coerce-once.sqllogic`.

## Fixed in this pass (minor)

- **Per-row allocation regression on same-typed bulk copies.** Making every constrained
  column carry a guard meant `buildRowCoercion` returned a closure where it used to return
  `undefined`, so `insert into b select * from a` between same-typed tables went from zero
  per-row work to one `row.slice()` (an N-element array) plus the guards, on every row.
  The implementation's own `NOTE` counted only "one `typeof`/`instanceof` per row" and
  missed the copy. The closure now copies **lazily** — it allocates the first time a cell
  actually changes and otherwise returns the caller's row — so the all-conforming path is
  allocation-free again. Both callers were checked for the aliasing this permits:
  `emitInsert` only reads cells out of the result, `emitUpdate` hands in a row it just
  copied itself. Two unit tests pin it (no copy when everything conforms; copy when a
  later cell converts), and the doc comment states the contract callers must respect.
- **Docs left describing the old rule in the ALTER section.** `docs/types.md` § Where
  coercion happens was updated for the DML seams but its ALTER TABLE bullets further down
  still said the ADD COLUMN backfill "converts only when the default expression's static
  type is not already the new column's type" and still named the removed field `coerceTo`.
  Both corrected; the same section now also records that the guard converts where the skip
  used to store, so a contradicted announcement can surface as a `Type conversion failed`
  error instead of silently landing a bad value — intended, and worth stating because it
  is a new user-visible failure mode.
- **"Only as sound as the static types it reads" paragraph overstated the remaining
  hole.** Reworded to say what the guard does and does not narrow: it sees only the JS
  storage class, so it catches an announcement contradicted by representation (a number
  announced TEXT) and misses one contradicted only by content (serialized JSON text, a
  date spelled the wrong way). The listed known cases stand unchanged.
- **Stale rationale comment in `set-op-type-merge.ts`.** It justified merging mixed
  numerics to `NUMERIC` by "advertising REAL makes `buildRowCoercion` skip conversion,
  landing a bigint unconverted in a `real` column" — a consequence the guard now prevents.
  The conclusion is unchanged but the reason had to be restated: under the guard, claiming
  REAL would *convert* the INTEGER branch's bigints to doubles, trading a representation
  violation for silent precision loss. Comments at the two primary call sites
  (`emit/insert.ts`, `emit/update.ts`) still said an identity-matched cell "is left alone"
  and now say it is left alone only when the value conforms.
- **Code and docs pointed at a ticket that no longer exists.** Three sites
  (`func/builtins/datetime.ts`, the new `NOTE:` on `buildCellCoercion`, and
  `docs/types.md` § Special Types) said the variadic `date`/`time`/`datetime` functions'
  TEXT return type was "tracked by `debt-variadic-datetime-functions-not-temporally-typed`".
  That ticket is on no stage of the board: a human deleted it in the backlog triage pass
  `449c4be2` without consolidating it anywhere. The concern itself is real and unchanged
  (those functions emit SQLite's display spelling, which is not the canonical stored
  spelling, so declaring the temporal type would let a display-spelled string reach a
  DATETIME column — and the new conformance guard does not catch it, since a string does
  inhabit DATETIME's TEXT physical form). It was NOT re-filed: a human already weighed and
  closed it, and re-filing would invite the same round trip. Instead the three pointers now
  state the decision, with its revisit condition, at the site — the accepted-tradeoff
  `NOTE:` on `dateFunc` is the record.
- **Test coverage was text/real/JSON only.** Added an engine-level case for a same-typed
  bulk copy of `blob`, `boolean` and `integer` columns — the BLOB arm is the one
  conformance check that is an `instanceof` rather than a `typeof`, and a bigint past 2^53
  in an INTEGER column pins that the guard does not narrow it. Added
  `test/types/representation.spec.ts`, which enumerates the shared predicate's whole state
  space — every `physicalType` arm plus the NUMERIC-by-name arm, each with its admitted and
  rejected JS forms, and a case asserting the pre-selected and one-shot forms answer
  identically. That table is now the thing the strict checker and the write path are both
  pinned to. 33 → 49 assertions across three spec files.

## Recorded as tripwires, not tickets

- **Rule R1 (canonical numeric form) is deliberately outside the guard**, though the
  strict checker asserts R1 *and* R2 at the same seam. A safe-range `bigint` from a source
  announcing INTEGER/NUMERIC therefore still passes the guard. Repairing it here would
  silently paper over a missing canonicalization at a *birth* site (literal lexing,
  parameter bind, bigint arithmetic), which is where `docs/types.md` puts that obligation
  and where `QUEREUS_REPR_STRICT` reports it. Parked as a `NOTE:` on `buildCellCoercion`
  with the revisit condition: an in-tree path actually observed landing such a value.
- **The ADD COLUMN backfill's coercion decision is made at plan-build time, before
  optimizer rewrites, and is carried across `withChildren` unchanged.** No rule rewrites a
  backfill expression into one announcing a different logical type today, and a stale
  *guard* decision cannot corrupt anything (it re-checks the value); only a stale "always
  convert" could double-convert a JSON backfill. `NOTE:` at the `withChildren` site in
  `planner/nodes/alter-table-node.ts`.

## Checked and clean

- **No missed seam.** Searched for every remaining open-coded `logicalType` identity
  comparison in the engine and for other `validateAndParse` / `coerceRowToSchema` callers;
  the four surviving identity comparisons are unrelated (scalar invertibility, set-op merge,
  async-gather column matching, scalar type check), and `quereus-store` /
  `quereus-isolation` carry no copy of the write-path rule. Generated columns on INSERT are
  projected into the source relation, so `emitInsert`'s pass already covers them.
- **The predicate move is behavior-preserving.** The pre-selected arms reproduce the old
  switch exactly, including NUMERIC's bigint admission (matched by type NAME under the REAL
  physical arm) and the "no constraint" default for `ANY`/NULL and unrecognized plugin
  physical codes.
- **The JSON no-re-parse invariant.** Held by the existing sqllogic file
  (`06.9.1-json-coerce-once.sqllogic`, which covers UPDATE-of-a-sibling, INSERT … SELECT,
  self-assignment, upsert, OR REPLACE DEFAULT substitution, ALTER paths, transactions and
  savepoints) plus the new spec's JS-level assertions; the two overlap somewhat, which is
  acceptable because sqllogic cannot assert a stored value's JS `typeof`.
- **Nothing declined.** No accepted-tradeoff `NOTE:` was found at any site this change
  touches, so no finding was suppressed on that basis.
- **No major findings, so no new tickets were filed.** Two of the gaps the implementer
  flagged (announced types still inaccurate in places) are owned by
  `implement/binary-op-result-types-match-runtime` and
  `implement/remaining-scalar-result-types-and-repr-net`, which are already open; the third
  (the guard being R2-level rather than `validate`-level) resolves to the closed datetime
  tradeoff above. The implementer's remaining self-declared gap — no property/generator
  test over "every announced type × every bound JS value" — was weighed and left unfiled:
  the guard's behavior is fully determined by the `physicalType` arms, which
  `test/types/representation.spec.ts` now enumerates directly, so a generator would
  re-derive the same table without covering a state the table does not already name.

# Validation

All from the repo root, after the review edits:

- `yarn test` — every workspace, no failures; quereus core 9445 passing
- `yarn test:store` — 9437 passing, 33 pending, no failures
- `yarn workspace @quereus/quereus run test:repr-strict` — 9454 passing, 16 pending
- `yarn lint` — clean (eslint + the `tsconfig.test.json` type pass)
- `yarn build`, then `yarn typecheck` — clean across all packages

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

# Out-of-repo follow-up (not actionable here)

lamina excludes `packages/lamina-quereus-test/src/retype-insert-equivalence.test.ts` from
its `QUEREUS_REPR_STRICT=1` lane over the positional-`?` case. That exclusion can lift once
this lands; lamina is a separate repository, so nothing here touches it.
