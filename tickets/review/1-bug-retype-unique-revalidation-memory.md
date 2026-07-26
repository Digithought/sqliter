----
description: The in-memory backend now re-checks uniqueness when a column's type change (or a blank-filling change) could make two rows identical, and rejects the change instead of letting a duplicate through.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn validate block (~2222-2258); validateUniqueOverEffectiveRows (~3034); validateRekeyedUniqueStructures (~3077); convertBaseRows (~3012)
  - packages/quereus/src/vtab/memory/layer/row-convert.ts    # NEW — convertRowAtIndex + mapRows/mapRowsAsync
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # convertColumn (~388) now calls the shared helper
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic   # NEW fixture, 9 sections
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES (~46)
  - docs/memory-table.md                                     # § DDL and transactions, rule 1
difficulty: medium
----

# Review: memory backend re-validates UNIQUE after a value-rewriting ALTER COLUMN

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

## What changed

**`manager.ts` — the pre-mutation validate block in `alterColumn` grew a second arm.** It was
`if (collationChanged) { … }`; it is now `else if (valueConvert) { … }` as well, where
`valueConvert` is the per-value conversion the existing code already builds for both rewriting
families. The new arm re-runs the same probe the collate arm uses, passing a row mapper so the
probe judges the **converted** values. Still sited before `baseLayer.updateSchema(...)`, so a
rejection leaves the table, schema and transaction untouched.

**`validateUniqueOverEffectiveRows` / `validateRekeyedUniqueStructures` took an optional
`mapRow`.** It wraps whichever row stream is in play — the wrapper-supplied `EffectiveRowSource`
(async) or the manager's own `effectiveDdlRows()` (sync). Mapping happens in the manager;
`base.ts`'s `populateIndexFromRows{,Async}` stayed a straight row → index pipe and is unchanged.
The probe is built from `finalNewTableSchema`, so its comparator carries the column's **new**
logical type — that is what makes `text → real` (`'1.0'`/`'1.00'` → `1.0`) reachable.

**`row-convert.ts` (new, ~38 lines) holds the one definition of "the converted row".**
`convertRowAtIndex(row, colIndex, convert, convertNulls)` was the body of `convertBaseRows`; it
is now shared by three callers that must not disagree: the new probe, the committed-base rewrite
(`convertBaseRows`), and each open transaction layer's own-write rewrite
(`TransactionLayer.convertColumn`, which held a third copy at HEAD). The callers differ only in
error handling, deliberately: the two rewrite sites keep the row as-is on a conversion failure
(the value is shadowed by a pending delete/overwrite and unreadable — their docstrings explain
it), the probe lets the failure propagate. The file also holds the two stream-mapping generators.

**Docs.** `docs/memory-table.md` § "DDL and transactions" rule 1 previously said only "A
collation change is validated the same way…". It now names both families, with the concrete
collapsing examples and a note that the probe reads converted values under the new logical type.

## Testing

New fixture `test/logic/41.7.3-alter-column-retype-unique.sqllogic`, 9 sections. Added to
`MEMORY_ONLY_FILES` in `test/logic.spec.ts` with a comment pointing at
`bug-retype-unique-revalidation-store`, which should remove the entry.

Rejection cases — each verified to be *accepted* before this change and *rejected* after, with
message `UNIQUE constraint failed: <table> (<cols>)`:

| § | case |
|---|---|
| 1 | `text → integer`, `'1'`/`'01'`, explicit `create unique index`; then asserts values, `typeof`, and that the table is still writable and still enforcing |
| 2 | same collision under a table-level `unique (v)` constraint (auto-built covering index) |
| 3 | `text → real`, `'1.0'`/`'1.00'` |
| 4 | `set not null` backfill, two NULLs → one DEFAULT |
| 4b | `set not null` backfill where the one NULL collides with an existing row already holding the DEFAULT |
| 7b | composite `unique (a, v)` where `a` matches too, so the pair collides |
| 9 | collision only among rows the open transaction INSERTED but has not committed |

Accepted cases (regression floor):

- §4c a single NULL with no colliding partner still backfills.
- §5 non-colliding `text → integer` succeeds, values are physically rewritten (`typeof` is
  `integer`), an index-backed lookup finds a row by the new numeric value, and the index still
  enforces afterwards.
- §6 a column holding two NULLs retypes fine (NULLs stay mutually distinct), more NULLs still
  insert, a duplicate of the converted non-null value is still rejected.
- §7 composite `unique (a, v)` where the retype of `v` collides only in a pair that differs in
  `a` → accepted, and the composite then enforces on converted values.
- §8 a collision only among rows the open transaction DELETED does not block the change.

How the "before" behavior was verified: the new arm's condition was temporarily gated on a
global flag and each rejection case re-run through the engine API with the guard off — all seven
were accepted, all seven rejected with the guard on. That scaffolding is removed; nothing of it
remains in the tree.

Validation run: `yarn test` green (7204 quereus tests plus the other workspaces),
`yarn lint` clean, `yarn workspace @quereus/quereus run typecheck` clean.
Single-file iteration command:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/logic.spec.ts" --grep "41.7.3"`.

## Known gaps — please probe these

**The wrapper-supplied row stream is untested on this path.** When a wrapper module (the
isolation layer) stages the transaction's writes outside the manager, it passes an
`EffectiveRowSource` and the mapper wraps that async stream instead. The engine's own emitters
omit `rows`, and the fixture is memory-only, so `mapRowsAsync` is exercised by nothing in the
suite today. It is a three-line generator, but a reviewer should convince themselves the async
arm is correct — or that `bug-retype-unique-revalidation-store` will cover it, since that path is
how the store reaches this code.

**A third door into the same defect is open, and is filed, not fixed.** A `set data type` whose
*physical* storage class does not change (e.g. `text → timespan`) rewrites no values and so sets
neither `valueConvert` nor `collationChanged` — neither validate arm runs — yet a `MemoryIndex`
comparator is built from the column's logical type, and the temporal types compare by meaning
(`'PT1H'` ≡ `'PT60M'`). Retyping a text column that already holds that pair is accepted, leaving
a duplicate the constraint forbids; worse, afterwards the index and the query layer disagree
about which values exist (a third equivalent spelling is rejected as a duplicate on insert yet
returns 0 rows on select). Reproduced on this branch. Filed as
`tickets/fix/bug-retype-to-semantic-type-unique-and-query.md` — deliberately out of scope here,
since it needs its own decision about which logical types compare semantically and a separate
fix for the half-applied type change. Worth a reviewer's sanity check that it really is a
distinct defect and not something this ticket should have absorbed.

**Carried over unchanged:** `validateRekeyedUniqueStructures` walks `newSchema.indexes`, so a
UNIQUE constraint covered by a row-time materialized view rather than its auto-index is not
walked. The auto-index always exists alongside, so the structure is still validated. The existing
`NOTE:` at that site says so and was left in place; the docstring around it was rewritten from
"SET COLLATE arm" to cover both families — check that the NOTE still reads correctly in its new
surroundings.

**Cost shape, unmeasured:** the new arm adds one probe index build per uniqueness-enforcing
structure covering the altered column, over the effective rows — the same cost the collate path
has always paid, on a DDL statement. Not benchmarked.

## Review findings

_(reviewer fills this in)_
