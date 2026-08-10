---
description: Applications can teach the database its own rule for sorting text. If that rule disagrees with how the stored bytes sort, persistent-store tables used to silently skip rows in range queries and return rows in the wrong order. Applications can now promise their rule agrees with byte order, and without that promise the store falls back to a safe full scan.
files:
  - packages/quereus/src/core/database.ts                          # collations map entry, registerCollation options, built-in stamps, _isCollationOrderPreserving, UTF-16 NOTE
  - packages/quereus/src/core/database-internal.ts                 # DatabaseInternal._isCollationOrderPreserving (stripInternal hides it from Database's .d.ts)
  - packages/quereus/src/index.ts                                  # exports RegisterCollationOptions
  - packages/quereus-store/src/common/store-table.ts               # keyOrderMatchesCollation, pkOrderPreservingPrefixLength, leadingPkRangeIsOrderSafe, indexRangeIsOrderSafe
  - packages/quereus-store/src/common/store-module.ts              # db plumbed through computeBestAccessPlan; range-vs-eq split in tryIndexAccessPlan; buildPkOrderingAdvertisement truncation
  - packages/quereus-store/test/collation-order-preserving.spec.ts # 14 tests
  - packages/quereus/test/collation-normalizer.spec.ts             # `orderPreserving assertion` describe block
  - docs/store.md                                                  # § Order preservation, Built-in Collations table + footnote
  - docs/usage.md                                                  # db.registerCollation options object
  - docs/sql.md                                                    # § Physical key bytes — order-preservation caveat
  - docs/plugins.md                                                # registerCollation signature + store-collation guidance
difficulty: hard
---

# Order-preservation gate on store range seeks and PK-order advertisements

## What the bug was

A **collation** is an application-supplied rule for comparing strings, registered with
`db.registerCollation(name, comparator, { normalizer })`. The comparator answers "which
string sorts first"; the normalizer rewrites a string into a canonical form so that two
strings the comparator calls *equal* rewrite identically.

The persistent store (`using store`, plus the LevelDB / IndexedDB plugins on top of it)
writes each text value's **normalized** form into its key bytes and physically orders rows
by raw byte comparison of those bytes. `registerCollation` promised only that the
normalizer agrees with the comparator about **equality** — never about **order**. Three
store decisions assumed order anyway:

1. the primary-key byte-range window (`StoreTable.analyzePKAccess` → `buildPKRangeBounds`),
2. the secondary-index byte-range window (`StoreTable.analyzeIndexAccess`),
3. the PK-order advertisement (`StoreModule.buildPkOrderingAdvertisement`), whose
   `providesOrdering` lets the optimizer drop the Sort above `order by <pk>`.

Under a normalizer that preserved equality but not order, (1) and (2) silently dropped rows
and (3) returned them in byte order.

## What was built

**Engine** — `orderPreserving` is now an assertable collation property, mirroring the
existing `replicable` one:

- `registerCollation(name, comparator, { normalizer, replicable, orderPreserving })`.
  Both booleans default to `false`; the legacy positional-normalizer third argument also
  yields `false` (correctness over speed). The three built-ins are stamped `true`.
- `Database._isCollationOrderPreserving(name)` reads it back. It returns `false` for an
  unregistered name, and — deliberately — for a collation that asserted `orderPreserving`
  without supplying a normalizer, since the assertion is *about* the normalizer.
- The accessor is also declared on the `DatabaseInternal` interface: `packages/quereus`
  compiles its `.d.ts` with `stripInternal: true`, so an `@internal`-tagged method on the
  `Database` class is invisible to the store package. The store calls it through
  `(db as DatabaseInternal)`, matching how it reaches `_findRowTimeCoveringStructure`.
- `RegisterCollationOptions` is exported from the package root, so an embedder can name the
  type of a public method's parameter.

The assertion's precise meaning: *for all strings `x`, `y`, `sign(comparator(x, y))` equals
`sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`.* (See the first review finding
below: the three built-ins do not actually satisfy this for astral-plane text — a
pre-existing defect the gate does not close.)

**Store** — one shared predicate, consulted on both the "mark the filter handled" side
(`StoreModule`) and the "build a byte window" side (`StoreTable`), so the two can never
disagree:

```ts
// store-table.ts, exported
keyOrderMatchesCollation(db, column, keyCollation, compareCollation): boolean
//   non-text column                      → true  (type-native bytes)
//   compareCollation !== keyCollation    → false
//   else db._isCollationOrderPreserving(keyCollation)

pkOrderPreservingPrefixLength(db, schema, pkKeyCollations, tableKeyCollation): number
//   how many LEADING pk members pass the predicate
```

- **PK range** — `analyzePKAccess` returns `{ type: 'scan' }` when the leading PK column
  fails; `computeBestAccessPlan`'s `hasLeadingPkRange` arm declines under the same
  condition, falling through to the all-false-`handledFilters` full-scan plan.
- **Secondary-index range** — `analyzeIndexAccess` returns `null` for the range arm;
  `tryIndexAccessPlan` returns its `costOnly(...)` plan. The EQ/prefix arm is untouched on
  both sides (its coarser-`K` relaxation is sound for equality).
- **PK ordering advertisement** — `buildPkOrderingAdvertisement` truncates `pkOrdering` at
  the first failing PK member, and returns `{}` (no `providesOrdering`, no `monotonicOn`,
  no `supportsAsofRight`) when the leading member fails. `db` is now plumbed
  `getBestAccessPlan` → `computeBestAccessPlan` → `tryIndexAccessPlan` /
  `buildPkOrderingAdvertisement`.

## Behavior changes

Two shapes lose an optimization. Both were **returning wrong rows before**, so this is a
correctness fix that costs speed, not a pure regression:

- **Index range seek on a plain (BINARY) text column of a default-`K` (NOCASE) store
  table.** The range arm now requires `C === K`, not merely `K` coarser than `C`. Built-in
  counter-example, live today with no custom collation: `'K'` (U+212A KELVIN SIGN) is
  `> 'z'` under BINARY, yet its index bytes are `toLowerCase('K') = 'k'`, which sorts
  *before* `'z'` — the row fell outside the seek window and was dropped. Such a table now
  full-scans for ranges (equality seeks unchanged). Declaring the column `collate nocase`
  restores the seek. `backlog/debt-store-index-keys-use-column-collation` fixes it properly
  by encoding index-column bytes under `C`.
- **`any` / `json` primary-key columns.** `resolvePkKeyCollations` leaves them `undefined`,
  so their key bytes fall back to `K = NOCASE` while the engine compares them under BINARY.
  They now lose their PK range seek *and* their PK-order advertisement. (Review found this
  is the read-side symptom of a deeper write-side bug — see findings.)

## Tests

`packages/quereus-store/test/collation-order-preserving.spec.ts` (14 tests). The probe
collation is a legal registration today — `NOCASE` may be overridden, only `BINARY` is
protected — whose normalizer matches its comparator's equality classes exactly but whose
comparator orders **shorter strings first**, which byte order does not:

```ts
const lower = (s: string) => s.toLowerCase();
db.registerCollation('NOCASE',
  (a, b) => a.length !== b.length ? a.length - b.length
    : (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0),
  { normalizer: lower });
```

With rows `('aa'), ('b')` — comparator says `'aa' > 'b'`, key bytes say `'aa' < 'b'`:

| query | before | now |
|---|---|---|
| `select k from t where k > 'b'` (text PK) | `[]` | `['aa']`, no seek in plan |
| `select id from t where k > 'b'` (index on text `k`) | `[]` | `[1]`, no seek in plan |
| `select k from t order by k` | `['aa','b']` | `['b','aa']`, Sort retained |
| `select v from t where k = 'B'` (point seek) | found | found (equality path untouched) |

A memory-table control asserts the same rows for all of the above. The positive half
registers an order-preserving `stripSpaces` / `noSpace` pair with `{ orderPreserving: true }`
and asserts the PK seek is kept and the Sort elided; the *same* pair registered without the
flag returns identical rows through the scan path. The `shapes the gate must leave alone`
block pins the shapes that must not regress: integer PK range seek, built-in-NOCASE text PK
range seek, coarser-`K` equality index seek, plus (added in review) the composite-PK
truncation branch.

Engine-side, `packages/quereus/test/collation-normalizer.spec.ts` gains an
`orderPreserving assertion` block: built-ins report `true`; a custom collation defaults to
`false` in both the options and legacy positional forms; the options form honours `true`;
overriding a built-in name drops the built-in's assertion; the flag is independent of
`replicable`; and a property test checks each built-in comparator against UTF-8 memcmp of
its normalized forms over the existing shared corpus.

**Mutation-checked** twice: with `keyOrderMatchesCollation` forced to return `true`, 7 of
the original 13 tests fail; with `pkOrderPreservingPrefixLength`'s loop forced never to
break, 6 fail including the new truncation test.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn test` — all workspaces green (quereus 6785 passing / 9 pending; quereus-store 851).
- `yarn test:store` — run by the implement stage (6779 passing / 15 pending). Not re-run in
  review: the review's own source edits are a comment, a `??` → `||`, and a type re-export,
  none of which alter the store's runtime behavior on a non-empty table collation.

## Review findings

Reviewed the implement diff against the source before reading its handoff, then read every
file the change touched and the ones it should have (`encoding.ts`, `comparison.ts`,
`rule-select-access-path.ts`, `reconcilePkCollations`). Ran `yarn build`, `yarn lint`,
`yarn test` — all clean. Verified the two decision sites (`StoreModule.computeBestAccessPlan`
and `StoreTable.analyzePKAccess` / `analyzeIndexAccess`) cannot disagree: the module only
marks a range filter handled when the predicate passes, and `rule-select-access-path` builds a
PK range seek only from `handledFilters`, so a store-side decline can never leave a dropped
residual.

### Major — two pre-existing defects found and filed

Both were **reproduced against a memory-table oracle**, both predate this ticket, both are
outside its scope.

1. **`fix/bug-store-astral-text-keys-mis-order`** — the `orderPreserving` assertion the three
   built-ins now carry is *false*. Their comparators use JavaScript `<` / `>` (UTF-16
   code-unit order); the store's key bytes are UTF-8. The two disagree for astral-plane
   characters. With no custom collation at all:
   `create table t (k text collate binary primary key) using store` holding `'😀'` and `'Ａ'`
   (U+FF21) gives `select k from t where k < 'Ａ'` → `[]` on the store, `['😀']` on a memory
   table (row silently dropped), and `order by k` → `['Ａ','😀']` on the store versus
   `['😀','Ａ']` in memory (Sort wrongly elided). The implement stage recorded this as a
   tripwire NOTE. It is not conditional — it is wrong today, on the default collation, for
   any text containing an emoji alongside a fullwidth/CJK-compatibility/private-use
   character — so it is filed as a bug, and the NOTE now points at the ticket.

2. **`fix/bug-store-any-json-pk-keyed-under-table-collation`** — an `any` or `json`
   primary-key column's key bytes are encoded under the table key collation `K` (default
   NOCASE) because `resolvePkKeyCollations` returns `undefined` and `buildDataKey` reads
   `undefined` as "fall back to `options.collation`" — while the engine compares the column
   under BINARY. So `insert into t (k any primary key) values ('A'), ('a')` raises
   `UNIQUE constraint failed`, where a memory table accepts both rows; likewise
   `'{"A":1}'` / `'{"a":1}'` on a `json` PK. This ticket's gate declines those columns'
   range seeks and PK-order advertisement, which is a correct *symptom* guard, but the
   write path still keys under the wrong collation. A stale comment in
   `resolvePkKeyCollations` asserted the opposite ("stays BINARY-keyed *and* BINARY-compared")
   and has been corrected to point at the new ticket.

### Minor — fixed in this pass

- **The truncation branch was untested**, as the handoff admitted. Added a test for
  `primary key (id, v)` with `v any`: `order by id` keeps its elided Sort (advertisement
  truncated to the safe leading member), `order by id, v` gets its Sort back, and
  `where id > 1` still seeks. Mutation-checked. The branch turned out to be correct as
  written.
- **`computeBestAccessPlan` read the table collation with `?? 'NOCASE'`** while
  `StoreTable.encodeOptions` uses `|| 'NOCASE'`. An empty-string `config.collation` would
  make the two disagree — the module marking a window handled that the table then declines,
  which returns the whole table. Changed to `||` and commented.
- **`RegisterCollationOptions` was not exported** from the package root, so an embedder
  could not name the type of `registerCollation`'s third argument. Exported.
- **Docs were stale beyond the two files the ticket touched.** `docs/plugins.md` carried the
  old `registerCollation` signature (no `orderPreserving`) and told store-plugin authors
  nothing about the assertion; `docs/sql.md` § *Physical key bytes* still called the store's
  key bytes "sort-preserving" unconditionally. Both updated. `docs/store.md`'s Built-in
  Collations table claimed "Full" range support for all three built-ins; a footnote now
  records the astral caveat and the `any`/`json` caveat, each pointing at its ticket.

### Conditional — recorded as a tripwire, not filed

- **A cost-only index plan carries no PK-order advertisement**, even though the store still
  iterates in PK key order for it. The range gate makes that arm fire more often (an index
  range on a BINARY text column of a default-`K` table now lands there), so
  `... where v > 'x' order by <pk>` picks up a Sort it did not need. Correct, just slower,
  and only if such a query shows up hot. `NOTE:` at the `costOnlyFallback` return in
  `store-module.ts`.

### Checked, no finding

- **`supportsAsofRight` is dropped wholesale when the leading PK member fails**, which the
  handoff flagged as possibly over-conservative. It is not: `prefix === 0` means the leading
  column's byte order is not its comparator order, so no asof scan over it can be sound. No
  change.
- **`monotonicOn` survives on a truncated prefix while `providesOrdering` shrinks**, which
  the handoff flagged as an asymmetry. It is correct: `monotonicOn` names only the leading
  PK column, which by construction passed the predicate.
- **The `K`-vs-`C` equality relaxation, including the `K === 'NOCASE' && C === 'BINARY'`
  special case that reasons about built-in names.** Sound for equality under any `K`: every
  normalizer is coarser-or-equal to BINARY's identity, so the `K`-window is always a superset
  of the `C`-equal rows. Left as-is; pre-existing and documented in the guard's doc comment.
- **No plugin-level test drives LevelDB / IndexedDB with a non-order-preserving collation.**
  The gate lives entirely in the shared `quereus-store` layer, which `test:store` exercises
  transitively; a plugin-level duplicate would test the same code through a slower backing.
  Not worth a ticket.
