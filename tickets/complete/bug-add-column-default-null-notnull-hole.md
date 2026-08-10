description: Adding a column spelled "default null" to a table that already had rows used to succeed and leave those rows blank in a column the engine treats as mandatory, breaking every later insert; the statement is now refused up front, and both storage backends refuse it identically.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # runAddColumn gate ~line 481-494 — the fix
  - packages/quereus/src/vtab/memory/layer/manager.ts              # MemoryTableManager.addColumn gate ~line 1938-1953 — the fix + a tripwire note
  - packages/quereus-store/src/common/store-module-alter.ts        # StoreModuleBase.alterAddColumn ~line 176 — unchanged; the shape copied
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic  # section 8 (8a-8f)
  - packages/quereus/test/alter-add-column-delegate.spec.ts        # delegation fixture + two new cases
  - packages/quereus/test/optimizer/statistics.spec.ts             # line 588 — one-word edit
  - docs/sql-ddl.md                                                # §2.6 "ADD COLUMN over a non-empty table" block; restriction list at ~line 570
  - docs/memory-table.md                                           # ~line 372
difficulty: medium
---

# What shipped

Quereus treats a column as mandatory unless you write `null`: the session option
`default_column_nullability` ships as `not_null`. So `alter table t add column extra text
default null` declared a **mandatory** column but supplied no usable value for the rows
already in the table. It was accepted; the existing rows kept NULL in a column reported as
`notnull = 1`, and every later `insert` that omitted the column failed. The user saw the
INSERT break, but the mistake was an ALTER that had reported success.

Two gates each asked a slightly wrong question. Both now ask the same one — *is there a
value for the existing rows?*

**Engine gate — `runAddColumn`** (`packages/quereus/src/runtime/emit/alter-table.ts:481-494`).
Was `columnDef.constraints?.some(c => c.type === 'notNull')` — mandatoriness read off the
statement text, so a column mandatory only via the session option never tripped it. Now
resolved through `columnDefToSchema(...).notNull`, the same resolver the memory module, the
store module and the isolation layer's `deriveAddColumnBackfill` already use.

**Memory module gate — `MemoryTableManager.addColumn`**
(`packages/quereus/src/vtab/memory/layer/manager.ts:1939`). Was
`notNull && defaultValue === null && !defaultIsLiteral && !hasDefaultExpr &&
!backfillEvaluator && tableHasRows` — the two DEFAULT-*kind* clauses stepped aside for
`default null`, since a NULL literal still counts as "a literal was written". Now
`notNull && defaultValue === null && !backfillEvaluator && tableHasRows`, identical to
`StoreModuleBase.alterAddColumn`. The two shipped storage modules no longer disagree on
identical SQL.

Net behaviour, all of it exercised under both `yarn test` (memory) and `yarn test:store`
(LevelDB) by section 8 of `packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic`:

| statement, on a table that already has rows | result |
| --- | --- |
| `add column extra text default null` | refused (8a) |
| `add column extra text default (null)` | refused (8b) |
| `add column extra text` (no DEFAULT) | refused (8e) |
| `add column extra text null default null` | accepted, column optional (8c) |
| any `add column` on an **empty** table | accepted; NOT NULL enforces from the first write (8d) |
| `add column extra text default null` under `pragma default_column_nullability = 'nullable'` | accepted, column optional (8f) |
| `add column mandatory text not null default null` under the same `nullable` pragma | refused (8f) |

Rejections are pre-mutation: `table_info` shows no new column afterwards and writes over the
original shape still work.

Docs: `docs/sql-ddl.md` gained a block under §2.6 *Default Values* — "ADD COLUMN over a
non-empty table needs a value for the rows that already exist" — and the ADD COLUMN
restriction list now points at it instead of paraphrasing it loosely.
`docs/memory-table.md` (~line 372) says the NOT NULL may come from the session option and
that a DEFAULT folding to NULL counts as "no DEFAULT".

# Review findings

## Verified, no change needed

- **Both module gates are now the same predicate.** Read side by side:
  `manager.ts:1939` and `store-module-alter.ts:176`. Identical.
- **The isolation layer already agreed.** `deriveAddColumnBackfill`
  (`quereus-isolation/src/alter-migration.ts:282`) resolves nullability through the same
  `columnDefToSchema` + session-option pair. No fourth spelling exists.
- **`columnDefToSchema`'s side effects are bounded.** It throws in exactly two places — an
  unknown explicit `COLLATE`, and `DEFAULT` together with `GENERATED ALWAYS AS`. Otherwise
  pure. Its `primaryKey ⇒ notNull` branch is unreachable here: `runAddColumn` rejects a PK
  column add ~50 lines earlier.
- **The repeated `getStringOption('default_column_nullability') === 'not_null'` (now five
  sites) is not a drift risk.** `getStringOption` throws `INTERNAL` for an unregistered key,
  so a typo is loud, not a silent `false`. Considered filing a DRY ticket; decided against —
  the duplication is a comparison against a string constant with no silent-failure mode.
- **The pre-existing test edit preserves its intent.** `statistics.spec.ts:588` uses the
  ALTER only to produce a frozen schema for an ANALYZE check; it asserts frozen-ness and row
  counts, never nullability, so spelling the column `NULL` changes nothing it tests.
- **No other `add column … default null` exists in the repo** — swept source, tests, and docs.
- **The tripwire this ticket existed to discharge is gone.** No reference to the slug remains
  in `packages/` or `docs/`.

## Resolved an open question from the handoff

The handoff flagged that `default (null)` was "verified empirically, not reasoned from the
parser", and worried a parser change could silently reroute it. It can be reasoned: the AST
has **no parenthesized-expression node**, so the parser drops parens and `(null)` arrives as
a plain `literal` node. `tryFoldLiteral` folds it, `buildAddColumnBackfill` returns no
per-row backfill, and the value-based gate catches it — the same path `default null` takes,
not a parallel one. Not a latent routing risk; no tripwire needed.

## Found and fixed in this pass (minor)

- **The delegation fixture repeated the exact bug the ticket fixed.**
  `test/alter-add-column-delegate.spec.ts`'s `TotalMemoryModule` — the only worked example of
  the `delegatesNotNullBackfill` capability — decided whether to relax the new column with
  `constraints.some(c => c.type === 'notNull')`. Under the shipped `not_null` default, a bare
  `alter table t add column tier text` is already mandatory, so the fixture skipped its
  relaxation, handed a mandatory column to the base manager, and the manager rejected the add
  the capability exists to permit. Same for `default null`. Fixed to resolve nullability
  through `columnDefToSchema` and to treat a DEFAULT that folds to NULL as no value source;
  added two specs that fail against the old fixture and pass now.
- **Missing coverage for the inverse of the bug.** Nothing exercised the gate with
  `default_column_nullability` flipped to `nullable`, where `add column extra text default
  null` on a populated table *should* be accepted. Added sqllogic 8f, which also pins that an
  explicit `not null` under the same pragma is still refused — so the rule demonstrably
  tracks the resolved column, not the pragma. Runs under both storage modules.
- **`docs/sql-ddl.md:570` was left imprecise.** The ADD COLUMN restriction list still said
  "without a value source (no DEFAULT and no `GENERATED ALWAYS AS`)" — but `default null`
  *is* a DEFAULT and does not count, which is the whole point of the fix. Rewritten to state
  the resolved-nullability and folds-to-NULL rules and to cross-reference the new §2.6 block
  rather than paraphrase it a second time.

## Filed as a new ticket (major, outside this diff)

- `tickets/fix/bug-add-column-notnull-skips-other-connections-uncommitted-rows.md` — the
  "are there rows?" probe runs on the connection issuing the ALTER, so it sees committed rows
  plus that connection's own uncommitted ones. Under the isolation layer, another
  connection's uncommitted rows are invisible to it; with an empty committed table, a
  mandatory column can be accepted and then NULL-filled into that other connection's rows.
  `alter-migration.ts:583` explicitly relies on the engine having ruled this out. **Not
  caused by this ticket** — it behaves identically before and after, and was already
  reachable with an explicit `not null`. Found by reading, not running, so the ticket is
  written reproduce-first and says plainly what would make it a non-issue.

## Considered, deliberately not acted on

- **`columnDefToSchema` now runs unconditionally in `runAddColumn`, including for a module
  that declares `delegatesNotNullBackfill`.** Keeping it. Its two throws (bad `COLLATE`,
  `DEFAULT` + `GENERATED ALWAYS AS`) are that function's own invariants, reached with the
  same message and `StatusCode` a little earlier than before; a delegating module would hit
  them anyway the moment it built the column schema, and pre-mutation is the better place.
  The handoff called this untested on the delegating path — the two new delegate specs now
  exercise the resolver's `.notNull` there. The two throw paths still have no delegate-path
  test; they are covered where `columnDefToSchema` itself is tested, and a delegate-specific
  copy would assert the same function twice.
- **Source file sizes.** `alter-table.ts` is 2123 lines and `manager.ts` is 3662. Both are
  genuinely large, both entirely pre-existing, and this diff moves them by ±20 lines. Not
  this ticket's to split, and a refactor ticket spun out of a bugfix review would be scope
  creep. Noted, not filed.
- **Comment density in `runAddColumn`.** The gate is 6 lines under ~20 lines of comment. That
  is out of proportion in isolation but matches the file's established style exactly — every
  block around it carries the same weight of rationale. Left alone.

## Tripwire recorded

- **The engine gate and each module's gate still encode the rule independently.** They agree
  today, and section 8 running under both `yarn test` and `yarn test:store` is the only thing
  holding them together — nothing enforces it mechanically. Parked as a `NOTE:` at the memory
  gate (`packages/quereus/src/vtab/memory/layer/manager.ts:1941`), the site that actually
  drifted, saying to hoist a shared predicate rather than add a fourth copy.

## Empty categories

No error-handling, resource-cleanup, or type-safety findings. `validateNotNullBackfill`
finalizes its probe statement in a `finally`; the diff adds no new resource, no new `catch`,
and no new type — it deletes two boolean locals and routes one value through an existing
exported resolver.

# Validation

All run after the review edits.

- `yarn lint` — clean (eslint + the `tsconfig.test.json` tsc pass over test files).
- `yarn test` — **0 failing**; quereus 7856 passing (7854 at handoff, +2 new delegate specs),
  plus 344 / 113 / 63 / 17 / 28 / 1176 / 594 / 52 / 31 / 34 / 134 / 22 across the other
  packages. ~5 min.
- `yarn test:store` — **7847 passing, 22 pending, 0 failing** (7845 at handoff, +2). ~1 min.
- `41.4-alter-add-column-constraints.sqllogic` also run on its own under both memory and store
  to confirm the new section 8f passes on both backends.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
