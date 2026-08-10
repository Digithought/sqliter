---
description: Changing an in-memory table's column to a type that treats differently-spelled values as equal (like a duration, where "1 hour" and "60 minutes" mean the same thing) used to leave any index on that column comparing the old way; it now rebuilds the index and re-checks uniqueness first, matching what the persistent storage backend already did.
files:
  - packages/quereus/src/util/comparison.ts                  # comparisonSemanticsDiffer (~498)
  - packages/quereus/src/index.ts                            # export (~126)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — comparatorChanged / structuresRekeyed
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # adoptSchema doc comment (~167)
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES entry (~48)
  - packages/quereus/test/alter-table-conformance.spec.ts    # two new arms (~347)
  - docs/sql-ddl.md, docs/memory-table.md, docs/module-authoring.md
difficulty: medium
---

# `ALTER COLUMN … SET DATA TYPE` into a differently-comparing type re-keys memory indexes

## What shipped

TEXT, TIMESPAN, JSON, DATE, TIME and DATETIME are all stored as text, so retyping a column
between them rewrites no stored byte. It does change how two values *compare* — TIMESPAN ranks
by elapsed time, so `'PT1H'`, `'PT60M'` and `'PT3600S'` are one value where text sees three.

The memory module used to treat "same physical storage" as "nothing to do", leaving every index
sorted the old way while write-time uniqueness read the new schema. A value could be
simultaneously rejected as a duplicate on `INSERT` and absent on `SELECT`.

The fix adds `comparisonSemanticsDiffer(a, b)` (`a.compare !== b.compare` — `createTypedComparator`
is fully determined by `type.compare`, so those two identities *are* the question) and routes a
same-storage-class retype that trips it down the existing `SET COLLATE` path in
`MemoryTableManager.alterColumn`: UNIQUE re-validation over the transaction's effective rows
before anything mutates, `rebuildAllSecondaryIndexes` on the base, and `adoptSchema` on every
open transaction layer. The index-column collation propagation and the primary-tree re-key stay
on `SET COLLATE` alone. A retype whose types compare identically (`text → varchar(50)`,
`integer → bigint`) shares one `compare` and stays a metadata-only no-op.

The subtlest part of the change is that `alterColumn` now rebuilds the `IndexSchema` objects for
a comparator-only retype even though it has no field to write into them: object identity is the
signal `TransactionLayer.adoptSchema` uses to decide a layer's index must be replaced, and
without a fresh object the DDL transaction's own layers kept their old-comparator indexes and
shadowed the base's rebuilt trees at commit.

## Review findings

### Checked and clean

- **Correctness of the re-key, probed live.** `ORDER BY` (asc and desc), range predicates
  (`v > 'PT6M'`), a multi-column `unique (a, v)` collision, `ROLLBACK TO SAVEPOINT` across an
  accepted retype, and index usability after a *rejected* retype all behave correctly. None of
  these were in the implementer's fixture set.
- **`comparisonSemanticsDiffer` is sound on function identity.** `inferType` returns registry
  *singletons* (`typeRegistry` maps `VARCHAR`/`BIGINT`/… onto the shared `TEXT_TYPE`/
  `INTEGER_TYPE` objects) and no logical type is constructed per-declaration, so comparing
  `compare` identities is stable. The implementer's stated worry — a future parameterized type
  family sharing one `compare` — remains hypothetical; nothing in the registry can produce it
  today.
- **The store leg.** `yarn test:store` — the run the implementer flagged as not done — now run:
  **7202 passing, 21 pending, 0 failing.**
- **Docs.** `sql-ddl.md`, `memory-table.md`, `module-authoring.md` and the two doc comments were
  read against the code; the claims match the implementation. `docs/types.md` and `docs/schema.md`
  make no claim this change invalidates.

### Fixed in this pass (minor)

- **`JSON` was missing from every enumeration.** `JSON` is a fourth same-physical-class type
  carrying its own `compare` (ranks by canonical structure, so `'{"a":1}'` ≡ `'{ "a" : 1 }'`),
  and the fix handles it correctly — but the predicate's doc comment, `sql-ddl.md`,
  `memory-table.md` and the `module-authoring.md` module contract row all listed only TIMESPAN
  and DATE/TIME/DATETIME. Added to all four, plus new sqllogic sections 9 / 9b / 9c covering the
  JSON collision reject, the accepted case, and the natively-declared column the retyped one has
  to match.
- **No coverage of the collation-legal `text → date` retype.** Section 7 only exercised
  `text collate nocase → date`, which turns out to be an illegal column shape (see below).
  Added section 7b over a plain `text` column so the DATE arm keeps coverage once section 7
  changes.
- **`MEMORY_ONLY_FILES` comment corrected** — it claimed the store covers "the TIMESPAN half"
  and not "the date/collation half". The store's key-transform guard covers TIMESPAN *and* JSON;
  what it does not cover is the DATE family.

### Filed as new tickets (major)

- **`tickets/fix/bug-retype-keeps-illegal-collation.md`** — `SET DATA TYPE` never re-checks the
  column's existing collation against the new type, so `text collate nocase → date` yields a
  `DATE COLLATE NOCASE` column that `CREATE TABLE` refuses to declare, and whose
  `generateTableDDL` output does not re-parse (`Unknown collation 'NOCASE' for type 'DATE'`).
  Verified live in both directions. Pre-existing, but this ticket's new section 7 *pinned* it as
  correct, so it could not be left silent; that section now carries a NOTE pointing at the
  ticket. This also resolves the implementer's open question about the memory/store trigger
  mismatch: for a **legal** column the mismatch is invisible (DATE/TIME/DATETIME compare exactly
  as BINARY text, so nothing needs re-keying on either side), and the only shape where the two
  backends diverge is the illegal `NOCASE` pairing — so it is one fix, not two.
- **`tickets/fix/bug-json-equality-not-structural.md`** — a `json` column's UNIQUE index treats
  two differently-spaced documents as one, but `=` treats them as two: `insert` is rejected as a
  duplicate while `select … where v = …` returns nothing. Reachable with a plain
  `create table (v json)` — unrelated to `ALTER`, found while adding the JSON coverage above.
  Cause: the query layer's semantic-equality path is gated on `groupKey`, which TIMESPAN supplies
  and JSON deliberately does not. Sections 9b/9c pin the current behavior with a NOTE.

### Tripwires (recorded, not ticketed)

- `src/util/comparison.ts`, on `comparisonSemanticsDiffer`: the predicate answers "may the order
  move", not "does it". DATE/TIME/DATETIME compare exactly as BINARY text does, and BINARY is the
  only collation they legally accept, so `text → date` re-sorts every structure into the order it
  was already in — O(rows) of wasted work. `NOTE:` at the site says what to narrow if a retype on
  a large table ever shows up as slow.
- The implementer's own `NOTE:` in `manager.ts` (metadata-only changes never hand the new schema
  to open transaction layers) was re-read and stands: verified non-observable today, with the
  trigger condition stated.

### Explicitly not found

- **No error-handling or resource-cleanup defects.** The `catch` restores schema, primary tree and
  secondary indexes; every new throw is a pre-mutation reject, and the rejected-ALTER path was
  probed live (table still writable, indexes still answering).
- **No source-hygiene findings.** The new function is 3 lines; `alterColumn`'s new branch is ~10.
  Comment density is high but each block explains a non-obvious ordering constraint, matching the
  surrounding file.
- **No type-safety findings.** No `any`, no new casts, no signature drift (`yarn lint` includes
  the `tsc -p tsconfig.test.json` pass over the spec call sites).
- **No DRY violations.** The change reuses the `SET COLLATE` pre-pass, rebuild and adopt sites
  rather than adding a parallel path; the one derived flag (`structuresRekeyed`) is what makes
  that reuse explicit.

## Validation

- `yarn lint` — clean.
- `yarn test` — **7210 passing, 0 failing** across every workspace package.
- `yarn test:store` — **7202 passing, 21 pending, 0 failing**.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

## Downstream

- `tickets/fix/bug-retype-same-class-skips-value-validation.md` (spun off by the implementer) —
  the same-physical-class branch does no value validation at all, so `set data type date` on a
  text column holding `'hello'` is accepted.
- `tickets/fix/bug-retype-keeps-illegal-collation.md` and
  `tickets/fix/bug-json-equality-not-structural.md`, filed by this review.
