---
description: Fixed a bug where a persistent-store table with a flexible `any`, `json`, or date/time primary key treated text case-insensitively when deciding whether two rows were the same row — rejecting a legitimate second row, and silently destroying the first row on "insert or replace". Such keys now compare byte-for-byte, matching what a memory table does.
files:
  - packages/quereus-store/src/common/store-table.ts             # the fix, the dead-clause removal, the NOTE tripwire
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # regression coverage
  - packages/quereus-store/test/collation-order-preserving.spec.ts
  - packages/quereus-store/test/custom-collation-key.spec.ts
  - docs/schema.md                                               # § Per-column PK key collation
difficulty: medium
---

# Non-textual, text-capable PK columns are keyed under BINARY

## What changed

`resolvePkKeyCollations` (`store-table.ts`) decides, per primary-key column, which collation
produces that column's physical key bytes. It used to gate on `col.logicalType.isTextual` and
return `undefined` for everything else. But `undefined` does not mean "encode type-natively" to
`encodeValue` — it means *fall back to `options.collation`*, the table key collation K, which
defaults to `NOCASE`. So an `any` / `json` / temporal PK column's text was lowercased before it
became key bytes, while the engine compared that same column under `BINARY`. Uniqueness was
enforced under NOCASE and compared under BINARY.

The gate is now `columnCanHoldText`, and a text-capable-but-not-`isTextual` member returns a
hard-coded `'BINARY'` — the collation the engine actually compares under, because none of these
types lets the collation argument `createTypedComparator` hands it influence the result.

Two consequential cleanups came with it:

- `validateKeyCollations`' `pkFallsBackToTableKeyCollation` term is gone — it tested a condition
  that is now unsatisfiable by construction. `'BINARY'` enters the `names` set for these tables
  instead, and always has a normalizer, so no table becomes unopenable.
- The read-side gate un-declines itself. `pkOrderPreservingPrefixLength` compares the member's
  key collation against `col.collation ?? 'BINARY'`; both are now `BINARY`, so PK range seeks and
  PK-order advertisement return for these columns.

`reconcilePkCollations` (`store-module.ts`) was deliberately not touched: it reconciles only
`isTextual` PK members, and the non-textual ones now pin their key collation independently.

The behaviors fixed, each covered by `packages/quereus-store/test/any-json-pk-binary-key.spec.ts`:

```sql
-- Spurious UNIQUE rejection on an `any` PK (and the same on `json`, and via UPDATE).
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert into t values ('a', 'lower');   -- was: ConstraintError. now: 2 rows.

-- The DATA-LOSS direction — no error, one row silently gone.
insert or replace into t values ('a', 'lower');   -- was: 1 row. now: 2 rows.

-- The read-side win: a `date` PK range now seeks instead of full-scanning.
select v from t where d > '2024-03-01';           -- plan now contains INDEXSEEK
```

Temporal types store canonical ISO strings whose case is fixed, so no two distinct temporal
values ever collided — the *uniqueness* bug was unreachable for them. Their key bytes were still
wrong, and the read-side gate had been declining every range seek on them as a result.

## Review findings

### What was checked

The implement-stage diff (`26b4a6e7`) was read before its handoff summary. Every factual claim
the diff makes about the engine was verified against the engine source rather than taken on
trust: `ANY_TYPE.compare`, `TEXT_TYPE.compare`, `JSON_TYPE.compare`, each of the four temporal
`compare` implementations, `createTypedComparator`'s dispatch, `logicalTypeCanHoldText`'s
`NEVER_TEXT_PHYSICAL_TYPES` allow-list, `ColumnSchema.logicalType`'s optionality, and
`reconcilePkCollations`' `isTextual` gate. The removed `pkFallsBackToTableKeyCollation` term was
traced for reachability, and `validateKeyCollations` was checked for tables it might newly make
unopenable (none: `'BINARY'` always carries a normalizer, and the one CREATE it stops rejecting
is the one the updated `custom-collation-key.spec.ts` test now asserts succeeds).

The two claims that carry the most weight — "BINARY key bytes are order-faithful" and "a memory
table is the oracle" — were tested empirically with throwaway specs against the store and memory
modules side by side, across all five JSON storage classes, mixed-type `any` keys, and every
temporal type. The scratch specs were removed afterward.

Lint (`yarn lint`), the store package suite (`yarn workspace @quereus/store run test`, 860
passing), a full typecheck of the store's test sources (`npx tsc -p tsconfig.test.json
--noEmit`), `yarn build`, and `yarn test` across every workspace all pass. No pre-existing
failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Fixed in this pass (minor)

- **Three code comments, one spec header, and one paragraph of `docs/schema.md` asserted a false
  reason for a true conclusion.** All of them said "`TEXT_TYPE` supplies no `compare` at all, so
  text alone reaches the collation-honoring `compareSqlValuesFast`", and that `JSON_TYPE` and the
  temporal types "compare under `BINARY_COLLATION` unconditionally". `TEXT_TYPE.compare` exists
  (`builtin-types.ts:135`) and applies the collation it is handed; `JSON_TYPE.compare` is a
  structural deep-compare; `TIMESPAN.compare` ranks by `Temporal.Duration` total. The conclusion
  the diff drew — text honors its collation, the others do not — is right, and the fix is right,
  but the stated mechanism was wrong in a way that would mislead the next reader into trusting
  `logicalType.compare` as the store's ordering contract. Rewritten to say what is actually true:
  `TEXT_TYPE.compare` is the only one that applies the collation.

- **`pkOrderPreservingPrefixLength`'s doc comment did not say what the ordering advertisement is
  measured against**, which is the only thing that makes it sound. Added: it is the order the
  planner's `Sort` would have produced, and `Sort` — like every scalar comparison — orders under
  the operand's collation via `compareSqlValuesFast`, never through `logicalType.compare`. This
  is why byte order remains a correct advertisement for a `timespan` or `json` PK even though
  those types' own `compare` disagrees with it.

- **Added the `alter table … alter column k set collate` regression the implementer flagged as
  untested.** `resolvePkKeyCollations` returns `'BINARY'` on both sides of such an ALTER for an
  `any` PK member, so `rekeyRows` must re-key to identical bytes. The new test inserts `'A'` and
  `'a'`, runs the ALTER, and asserts both rows survive — i.e. neither collides at a NOCASE key on
  the way through the rekey.

- **Added a test pinning the ordering contract itself**, replacing the "oracle sufficient?"
  worry the implementer raised. It asserts that the store's elided-`Sort` order for a `timespan`
  PK equals the order a *real* `Sort` produces over the same values in a table with an integer PK
  — an absolute assertion, not a memory-oracle comparison.

### A false alarm, recorded because it cost real time

Mid-review I believed the diff had introduced a silent wrong-result: opening the read-side gate
for `timespan` and `json` PKs advertises byte order, and neither `TIMESPAN.compare` nor
`JSON_TYPE.compare` agrees with byte order. I wrote the guard, wrote the tests, and the tests
failed in the opposite direction from the one I predicted. The engine's `Sort` and its `where`
predicates do **not** use `logicalType.compare` — they compare under the operand's collation. So
byte order *is* the order the advertisement promises, and the diff is correct. The guard was
reverted; only its documentation survives, as the paragraph above.

What the detour did surface is a genuine defect elsewhere, filed as
`backlog/bug-memory-pk-btree-orders-by-logical-type-compare`: `MemoryTable`'s primary-key BTree
*is* keyed by `createTypedComparator`, so `select d from m order by d` on a `timespan` PK returns
`'PT90M', 'PT2H'` while the same query over a non-PK `timespan` column returns `'PT2H', 'PT90M'`.
The memory module advertises an order its own `Sort` would not produce. It predates this diff
(the gate was closed for `timespan` before, so the store simply sorted) and is not the store's to
fix. The spec header and the `pkOrderPreservingPrefixLength` comment now both name that ticket,
so nobody re-derives the confusion.

### Filed as new tickets (major)

- `backlog/bug-memory-pk-btree-orders-by-logical-type-compare` — described above. Also covers the
  matching uniqueness split: the store admits `'PT60M'` and `'PT1H'` as distinct `timespan`
  primary keys, while the memory table rejects the second as a duplicate.
- `backlog/bug-isolation-any-pk-hashed-under-declared-collation` — the adjacent site the
  implementer identified at `packages/quereus-isolation/src/isolated-table.ts:491`, which hashes
  an `any collate nocase` PK under NOCASE while the engine compares under BINARY. Latent (only an
  explicit, inert `collate` clause trips it), so `backlog/` rather than `fix/`.

### Tripwires

- `NOTE:` at the `pkOrderPreservingPrefixLength` comparison site (`store-table.ts`), carried over
  from the implement stage and left in place: an explicit `k any collate nocase` PK declines its
  range seek conservatively, because the key collation is `BINARY` while `col.collation` is the
  declared-but-ignored `NOCASE`. Both sides genuinely compare under BINARY, so the decline costs
  an optimization on a declaration nobody should write, never a row.

### Checked and clean

- **Resource cleanup, error handling, type safety.** The diff adds no allocation, no async
  boundary, and no new failure mode; `resolvePkKeyCollations` remains total and `no-any` clean.
- **DRY.** `resolvePkKeyCollations` stays the single source of the PK key collation for both
  `StoreTable` and `StoreModule.buildIndexEntries`, and `pkOrderPreservingPrefixLength` remains
  the single gate for both the seek path (`store-module.ts:2141`) and the read arm
  (`store-table.ts`), so the fix could not land in one and miss the other.
- **The removed `pkFallsBackToTableKeyCollation` term.** The implementer's own note asks whether
  its unreachability deserves an assertion. It does not: the term tested `pkKeyCollations[i] ===
  undefined && columnCanHoldText(col)`, and `resolvePkKeyCollations` now returns `undefined`
  under exactly `!columnCanHoldText(col)`. The two are the same predicate; an assertion would
  restate the function's first line.
- **Migration.** `packages/quereus-store` has no on-disk format version stamp, and this change
  alters the physical key bytes of every existing `any` / `json` / temporal PK column in a store
  whose K is not `BINARY`. Per `AGENTS.md` ("Backwards compat: don't worry yet") the resolution
  is the explicit *unsupported* statement now in `docs/schema.md`, not a rebuild-on-open path.
  Left as-is, deliberately.
- **Docs.** `docs/schema.md` § "Per-column PK key collation" is the only doc that describes this
  rule; it was read in full and now states the mechanism correctly. `docs/sql.md` § ALTER COLUMN
  and `docs/plugins.md`'s collation-registration note were checked and need no change — neither
  makes a claim this diff invalidates.
