---
description: Reproduced on real LevelDB — renaming a table to a name containing a broken half-character silently empties the table (its rows are moved to a storage location the database then forgets about), and two such tables can be pointed at one storage location. Reject those names when the physical storage name is built, before anything moves.
files:
  - packages/quereus-store/src/common/key-builder.ts            # buildDataStoreName / buildIndexStoreName — add the guard here
  - packages/quereus-store/src/common/store-module.ts           # create() ~616, createIndex() ~922, renameTable() ~2530/2600/2641
  - packages/quereus-plugin-leveldb/src/provider.ts             # encodeSublevelName ~50 — docstring claims injectivity; false for lone surrogates
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts     # 3 tests expect CREATE TABLE to succeed; must now expect rejection
  - packages/quereus-store/test/key-builder.spec.ts             # unit coverage for the new guard
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts  # model for the new LevelDB regression spec
difficulty: medium
---

## Background: what a "lone surrogate" is

A JavaScript string is a sequence of 16-bit code units. Characters above U+FFFF are stored
as a *pair* of units (a high half U+D800–U+DBFF followed by a low half U+DC00–U+DFFF). A
string may also contain a **lone (unpaired) surrogate** — one half with no partner. That is
a legal JS string and a legal Quereus `text` value, but it is not valid Unicode and **no
UTF-8 byte sequence encodes it**: `TextEncoder` silently replaces every one of the 2048
lone surrogates with the same replacement character U+FFFD (bytes `EF BF BD`).

A prior ticket (`bug-store-catalog-key-lone-surrogate-identifier-collision`) hardened the
**catalog keys** against this — `buildCatalogKey` and friends now reject an identifier
carrying a lone surrogate instead of folding it. The **physical store-name** builders were
left out of that fix's scope. This ticket closes them.

## Reproduced — confirmed against real LevelDB

Two findings, both verified with a throwaway spec wired to a real `LevelDBProvider` +
`Database` + `StoreModule` (same harness shape as
`packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts`).

### 1. The folding is real in the LevelDB provider

`LevelDBProvider.encodeSublevelName` (`provider.ts:50`) runs the logical store name through
`TextEncoder` before percent-escaping. So:

```
buildDataStoreName('main', '\uD800')  ->  'main.\uD800'  ->  sublevel 'main.%EF%BF%BD'
buildDataStoreName('main', '\uD801')  ->  'main.\uD801'  ->  sublevel 'main.%EF%BF%BD'   <-- same
```

Its docstring asserts "The mapping is deterministic and injective (distinct logical names →
distinct sublevel names)". That is **false** for lone surrogates, and it is exactly the
property `StoreModule.assertStoreNameFree` relies on — that guard compares *pre-encoding*
JS strings (`'main.\uD800' !== 'main.\uD801'`), so it cannot see the collision.

### 2. Actual silent data loss on RENAME

This is the sharp end, and it is worse than aliasing. Sequence:

```sql
create table p (id integer primary key, v integer) using store;
insert into p values (1, 111);
alter table p rename to "<lone surrogate>";   -- raises "unpaired surrogate" ... but too late
select * from p;                              -- []   <-- p's row is gone
```

`StoreModule.renameTable` does the **physical relocation first** (`provider.renameTableStores`,
`store-module.ts:2600`) and rewrites the catalog **after** (`saveTableDDL`, line 2641). The
catalog write is where the existing identifier guard fires. By then LevelDB has already moved
`main.p`'s keys into `main.%EF%BF%BD` and emptied `main.p`. The `catch` at line 2642 reverses
only the in-memory expression rewrites — not the physical move. Raw LevelDB dump after the
failed rename:

```
"!__catalog__!main.p" = "CREATE TABLE ... p ..."      <- catalog still says p exists
"!main.%EF%BF%BD!<key>" = "[1,111]"                   <- p's row, under an orphan store name
                                                      <- main.p is empty
```

The statement reports an error, so a careless caller might shrug it off — but the table is
now permanently empty with no further warning.

A second rename onto `"\uD801"` was caught, but only by LevelDB's incidental
"destination store already exists" backstop (`sublevelHasAnyKey`, `provider.ts:213`) — a
provider-local safety net, not the shared guard. Without it the second table's rows would
have merged into the first's orphaned store.

### IndexedDB

Not tested (needs a browser). IndexedDB object-store names are `DOMString`s compared by code
unit, so lone surrogates *should* survive per spec — but the fix below sits in the shared
builder, above every provider, so provider-by-provider analysis stops mattering for
correctness. Record the uncertainty as a comment, not as follow-up work.

## The fix

Guard `buildDataStoreName` and `buildIndexStoreName` with the same
`assertKeyableIdentifiers` helper the catalog-key builders already use
(`key-builder.ts:81`). This is the right layer for two reasons:

- Every call site computes the store name **before** its first side effect —
  `create()` builds it before `provider.getStore` (`store-module.ts:616`), `createIndex()`
  before `provider.getIndexStore` (line 922), `renameTable()` before the coordinator flush
  and the physical relocation (line 2534). So the throw always lands on a clean no-op, which
  is what kills the data-loss path above.
- It is above every provider, so LevelDB, IndexedDB, React Native LevelDB and the in-memory
  provider all behave identically.

The user-visible change: `create table "<lone surrogate>" using store` now fails **at CREATE
TABLE** instead of succeeding and then failing on the first INSERT/SELECT. That is strictly
better — such a table could never persist its schema anyway, so it was already dead on
arrival — but three existing tests pin the old late-failure timing and must be updated
(see TODO).

Well-formed astral characters (a proper surrogate *pair*, e.g. `'\u{10000}'`) must keep
working unchanged — the guard rejects only unpaired halves.

## TODO

- [ ] Add `assertKeyableIdentifiers(...)` to `buildDataStoreName` and `buildIndexStoreName`
      in `packages/quereus-store/src/common/key-builder.ts`. Guard every identifier the name
      is composed from (schema + table; schema + table + index). Leave the deprecated
      `buildStatsStoreName` alone.
- [ ] Update each builder's docstring to say the physical name is now identifier-guarded, and
      note that this is what makes `assertStoreNameFree`'s JS-string comparison sound (it
      compares names *before* any provider byte-encoding; with unpaired surrogates refused,
      the remaining name space encodes injectively).
- [ ] Fix the false injectivity claim in `LevelDBProvider.encodeSublevelName`'s docstring
      (`packages/quereus-plugin-leveldb/src/provider.ts:38-49`): say the mapping is injective
      *for the names the guarded builders can produce*, and that it is NOT injective over
      arbitrary JS strings because `TextEncoder` folds unpaired surrogates to U+FFFD.
- [ ] Add a `NOTE:` tripwire at `store-module.ts` renameTable, at the
      `provider.renameTableStores` call (~line 2600): the physical relocation runs before the
      catalog rewrite, so **any** failure after it (an IO error, or the DDL-text guard at
      `encodeCatalogDDL` firing on a lone surrogate in a column name or `default` literal)
      strands the rows under the new physical name while the catalog still names the old
      table. Harmless today for the validation cases — the store-name guard now rejects a bad
      target name before anything moves, and a table whose DDL text is unpersistable can hold
      no rows in the first place — but if a new post-relocation failure mode appears, the
      relocation needs to be undone or deferred.
- [ ] Unit coverage in `packages/quereus-store/test/key-builder.spec.ts`: both builders reject
      a lone high surrogate, a lone low surrogate, and one embedded mid-identifier, in the
      schema / table / index position; and both still accept a well-formed astral character.
- [ ] Update the three tests in
      `packages/quereus-store/test/lone-surrogate-keys.spec.ts` (the
      "an identifier or persisted DDL text carrying a lone surrogate" block, ~lines 260-282)
      that currently `await db.exec('create table "<lone surrogate>" ...')` expecting success:
      the CREATE now rejects. Keep asserting the message names the unpaired surrogate and is
      never a UNIQUE violation. The two tests whose *table* name is clean (lone surrogate in a
      column name at ~line 284, in a `default` literal at ~line 291) are unaffected — leave
      their late-failure timing as is, and update the block's leading comment to say the
      table-name case is now refused at CREATE while the DDL-text cases still surface lazily.
- [ ] New LevelDB regression spec (e.g.
      `packages/quereus-plugin-leveldb/test/lone-surrogate-store-name.spec.ts`, modeled on
      `sibling-collision.spec.ts` — real `LevelDBProvider` over a temp dir):
      - `create table "<lone surrogate>" using store` rejects, and a second CREATE differing
        only in which lone surrogate is used also rejects (never sharing a sublevel).
      - **The data-loss regression:** create and populate table `p`, attempt
        `alter table p rename to "<lone surrogate>"`, assert it raises **and** that
        `select * from p` still returns p's original rows. This is the test that would have
        caught the bug; it fails before the fix.
      - `create index "<lone surrogate>" on t (v)` rejects, and `t`'s own rows and existing
        index-backed lookups still work afterward.
- [ ] Validate: `yarn build`, then `yarn test`, then
      `yarn workspace @quereus/plugin-leveldb run test`. Stream output with `tee` (see
      AGENTS.md § Build & Test).
