----
description: The in-memory backend now re-checks uniqueness when a column's type change (or a blank-filling change) could make two rows identical, and rejects the change instead of letting a duplicate through.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn validate block (~2222-2264); validateUniqueOverEffectiveRows (~3040); validateRekeyedUniqueStructures (~3083); convertBaseRows (~3018)
  - packages/quereus/src/vtab/memory/layer/row-convert.ts    # NEW — convertRowAtIndex + mapRows/mapRowsAsync
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # convertColumn (~388) now calls the shared helper
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # NEW fixture, 10 sections
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES (~46)
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # 3 tests added in review — the only coverage of the async row-stream arm
  - packages/quereus-isolation/src/isolation-module.ts       # stale NOTE re-pointed in review
  - docs/memory-table.md, docs/sql-ddl.md, docs/module-authoring.md, docs/design-isolation-layer.md
difficulty: medium
----

# Complete: memory backend re-validates UNIQUE after a value-rewriting ALTER COLUMN

## What the defect was

Two `alter column` changes rewrite the stored values of one column:

- `set data type` when the physical storage class changes — every value is re-parsed
  (`'1'`, `'01'` → the integer `1`);
- `set not null` when the column holds NULLs and has a DEFAULT — every NULL is backfilled with
  the DEFAULT literal.

Either can turn two legitimately distinct rows into two identical ones. SQL UNIQUE also treats
several NULLs as mutually distinct, which is what makes the backfill case reachable. The memory
backend re-validated uniqueness only for `set collate`; both value-rewriting changes were
accepted silently, leaving a duplicate behind an enforcing unique index.

## What landed

**`manager.ts` — the pre-mutation validate block in `alterColumn` grew a second arm.** It was
`if (collationChanged) { … }`; it is now `else if (valueConvert) { … }` as well, where
`valueConvert` is the per-value conversion the existing code already builds for both rewriting
families. The new arm re-runs the same probe the collate arm uses, passing a row mapper so the
probe judges the **converted** values. Still sited before `baseLayer.updateSchema(...)`, so a
rejection leaves the table, schema and transaction untouched.

**`validateUniqueOverEffectiveRows` / `validateRekeyedUniqueStructures` took an optional
`mapRow`.** It wraps whichever row stream is in play — the wrapper-supplied `EffectiveRowSource`
(async) or the manager's own `effectiveDdlRows()` (sync). The probe is built from
`finalNewTableSchema`, so its comparator carries the column's **new** logical type — that is what
makes `text → real` (`'1.0'`/`'1.00'` → `1.0`) reachable.

**`row-convert.ts` (new, ~38 lines) holds the one definition of "the converted row".**
`convertRowAtIndex` was the body of `convertBaseRows`; it is now shared by three callers that must
not disagree: the new probe, the committed-base rewrite, and each open transaction layer's
own-write rewrite (which held a third copy at HEAD). The callers differ only in error handling,
deliberately: the two rewrite sites keep the row as-is on a conversion failure (the value is
shadowed by a pending delete/overwrite and unreadable), the probe lets the failure propagate.

**Docs.** `docs/memory-table.md` § "DDL and transactions" rule 1 now names both families, with the
concrete collapsing examples and a note that the probe reads converted values under the new
logical type. Three further docs were corrected during review (below).

## Testing

New fixture `test/logic/41.7.3-alter-column-retype-unique.sqllogic`, 10 sections, listed in
`MEMORY_ONLY_FILES` until `bug-retype-unique-revalidation-store` lands.

Rejection cases (each verified accepted before the change, rejected after, with message
`UNIQUE constraint failed: <table> (<cols>)`): §1 `text → integer` under an explicit unique index;
§2 the same under a table-level `unique (v)` auto-index; §3 `text → real`; §4 / §4b the
`set not null` backfill, two NULLs and one-NULL-meets-existing-DEFAULT; §7b a composite
`unique (a, v)` where the pair collides; §9 a collision only among rows the open transaction has
inserted uncommitted.

Accepted cases (regression floor): §4c a lone NULL still backfills; §5 a non-colliding retype
rewrites values, an index-backed lookup finds a row by the new numeric value, and the index still
enforces; §6 NULLs stay mutually distinct; §7 a composite that still differs in `a`; §8 a collision
only among rows the transaction has deleted; §10 (added in review) a rejected retype leaves the
transaction usable — delete the offending row, retry, commit.

Validation on the final tree: `yarn test` green (7204 quereus + 258 isolation + all other
workspaces, 0 failing), `yarn lint` clean (quereus eslint + `tsconfig.test.json` type pass).
`yarn test:store` deliberately not run — the fixture is memory-only and the store path is
`bug-retype-unique-revalidation-store`.

## Review findings

### What was checked

The implement diff was read first, before the handoff summary. Reviewed for correctness of both
arms and their ordering relative to `updateSchema`; DRY-ness of the extracted `convertRowAtIndex`
(compared line-by-line against the three bodies it replaced — behavior is identical, including the
swallow-vs-propagate split); type safety (no `any`, `RowMapper` is a named type); resource cleanup
(the two mapping generators are `for…of`/`for await…of` wrappers, so an early throw in the consumer
closes the source); error handling; docs.

Probe semantics were exercised directly against the engine, beyond the fixture: partial unique
indexes in *both* directions (a collision outside the index predicate is correctly ignored, one
inside is correctly rejected — for the retype arm and the pre-existing collate arm alike); two
unique structures where only the second collides; a UNIQUE constraint that also has a covering
materialized view (rejection still fires — the auto-index is walked); tables with no declared
primary key (every column is the key, so a retype is rejected upstream — no silent row collapse);
`real → integer`; and a collision introduced by an `UPDATE` inside the open transaction.

### Findings fixed in this pass (minor)

- **The async row-stream arm had no test anywhere in the suite** — the handoff flagged this as its
  main open question. It is reachable today: `IsolationModule.alterTable` supplies an
  `EffectiveRowSource` on *every* forwarded ALTER, so any `using isolated` table drives it. Driven
  end-to-end and confirmed correct (reject on committed collision, reject on overlay-staged
  collision, honored + values rewritten when distinct, deleted-in-transaction collision does not
  block). Three tests added to `packages/quereus-isolation/test/alter-table-conformance.spec.ts`
  covering exactly those, with a comment naming `mapRowsAsync` so the coverage is not lost.
- **Three docs were stale.** `docs/sql-ddl.md` § ALTER COLUMN described the `SET COLLATE`
  re-validation but not the new one (added, with the store's pending gap named);
  `docs/module-authoring.md` listed only `ADD CONSTRAINT … UNIQUE` / `SET COLLATE` as the
  row-validating arms and only collation-rekey as a row-content check (both extended);
  `docs/design-isolation-layer.md` § DDL carried the same short list (extended).
  `docs/memory-table.md` was accurate as written.
- **Fixture gap:** nothing covered "rejected inside a transaction, then retry after removing the
  offending row". Added as §10 — it also proves the probe re-runs correctly on the second attempt.
- **An in-code claim was narrower than it read.** The new comment justified skipping the primary-key
  pre-pass with "a retype of a PK column is rejected upstream", which says nothing about the *other*
  arm user, the NOT NULL backfill. Verified the backfill cannot reach a PK column either (the engine
  rejects a NULL in any PK member regardless of declared nullability, so such a column never holds
  the NULLs a backfill needs) and extended the comment to say so.
- **A stale pointer in `isolation-module.ts`**: its `NOTE:` about the `set data type` overlay gap
  referred readers to a ticket that had already completed. Re-pointed at the new ticket below.

### Findings filed as tickets (major)

- **`tickets/fix/bug-isolation-retype-leaves-staged-rows-unconverted.md`** — an *honored*
  `set data type` inside a transaction does not convert the issuing connection's staged rows. After
  commit the table holds a text value under a column the catalog calls INTEGER; `where v = 20`
  returns nothing while `where v > 5` returns the row. Reproduced. Pre-existing (the diff touches no
  isolation code, and the gap's own `NOTE:` predates this commit) and consciously deferred by an
  earlier review as a mirror of the documented `set collate` overlay limitation — filed anyway
  because the symptom is committed data contradicting the declared schema, not merely a validation
  blind spot. The ticket says so, so it can be closed as a duplicate if that call is revisited.
  Worth noting the interaction this ticket creates: the new probe judges overlay rows *converted*
  while the honored path leaves them *unconverted*, so the two disagree until that gap closes.
- **`tickets/backlog/debt-memory-alter-column-method-too-long.md`** — `MemoryTableManager.alterColumn`
  is ~337 lines handling six attribute changes through two long, mutually load-bearing `if/else`
  ladders sited hundreds of lines apart. Pre-existing and correct, but this ticket threaded another
  arm through both ladders and the next one will be harder. Not fixed here: restructuring a DDL path
  whose ordering guarantees are the thing under test is not a review-pass edit.

### Handoff items verified, no action

- **`bug-retype-to-semantic-type-unique-and-query` really is a distinct defect.** Reproduced:
  `text → timespan` changes no physical class, so neither validate arm runs, yet `'PT1H'`/`'PT60M'`
  become comparator-equal — a third equivalent spelling is then rejected as a duplicate on insert
  yet returns 0 rows on select. It is out of scope here (no value rewrite happens, so there is
  nothing for this ticket's probe to judge) and correctly filed in `tickets/fix/`.
- **The carried `NOTE:` about a UNIQUE constraint covered by a materialized view** still reads
  correctly in its rewritten surroundings, and the case was checked empirically: with an MV present
  the rejection still fires, because the auto-index exists alongside and is what the walk finds.

### Tripwires (recorded, not ticketed)

- **Nullable primary-key members** would open a collision path in the backfill arm (two NULL keys
  → one DEFAULT, with no PK pre-pass and no primary-tree re-key). Impossible today; recorded as a
  `NOTE:` at the validate block in `manager.ts`.
- **Probe cost** — one probe index build per uniqueness-enforcing structure covering the altered
  column, over the effective rows. Considered and deliberately *not* recorded: it is exactly the
  cost the collate arm has always paid on the same statement, so it is not a new condition to watch,
  and the existing `NOTE:` about rebuilding every secondary index already sits at that site.

### Empty categories

- **No correctness defect was found in the diff itself.** Every probe attempted against the new arm
  behaved as specified, including the ones the fixture does not cover.
- **No pre-existing test failures** to report: the full suite is green, so `.pre-existing-error.md`
  was not written.
