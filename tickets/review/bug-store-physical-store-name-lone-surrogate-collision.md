---
description: A table or index whose name contains a broken half-character is now rejected up front, instead of being accepted and then silently emptying the table when it was renamed.
files:
  - packages/quereus-store/src/common/key-builder.ts                    # the fix — guard on both store-name builders
  - packages/quereus-store/src/common/store-module.ts                   # NOTE tripwire at renameTable's physical relocation (~2596)
  - packages/quereus-plugin-leveldb/src/provider.ts                     # corrected injectivity docstring (~42)
  - packages/quereus-plugin-indexeddb/src/provider.ts                   # NOTE about untested IndexedDB behavior (~75)
  - docs/store.md                                                       # doc paragraph on the physical-name guard
  - packages/quereus-store/test/key-builder.spec.ts                     # 12 new unit tests
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts             # 3 tests retimed to reject at CREATE
  - packages/quereus-plugin-leveldb/test/lone-surrogate-store-name.spec.ts  # NEW — 4 real-LevelDB regression tests
difficulty: medium
---

## What a "lone surrogate" is (one paragraph, for a reader with no context)

A JavaScript string is a list of 16-bit units. Characters above U+FFFF are stored as a
*pair* of units. A string may also hold one half of such a pair with no partner — a **lone
(unpaired) surrogate**. It is a legal JS string and a legal Quereus `text` value, but it is
not valid Unicode and **no UTF-8 byte sequence encodes it**: `TextEncoder` replaces all 2048
of them with the same replacement character U+FFFD. So any code that turns a name into UTF-8
bytes maps every lone surrogate onto one identical byte string.

## What was wrong

Physical storage names (`{schema}.{table}`, `{schema}.{table}_idx_{index}`) were built with
no check. `LevelDBProvider` percent-escapes the name's UTF-8 bytes to form a sublevel name,
so `main.\uD800` and `main.\uD801` both became the sublevel `main.%EF%BF%BD` — two distinct
tables, one physical store.

The sharp end was **silent data loss on RENAME**. `StoreModule.renameTable` relocates
physical storage *first* and rewrites the catalog *after*; only the catalog write carried the
identifier guard (added by the earlier ticket
`bug-store-catalog-key-lone-surrogate-identifier-collision`). So
`alter table p rename to "<lone surrogate>"` raised an error — after LevelDB had already
moved p's rows into an orphan sublevel and emptied `main.p`. The statement errored and the
table came back permanently empty, with the catalog still naming `p`.

## What was changed

`buildDataStoreName` and `buildIndexStoreName` (`key-builder.ts`) now call
`assertKeyableIdentifiers` on every identifier they compose from — the same helper the
catalog-key builders already used. The helper was moved above the two builders in the file
so it is declared before first use; its docstring was widened to say it is shared by both
families of builders.

This is the right layer because every call site computes the physical name **before** its
first side effect: `create()` before `provider.getStore`, `createIndex()` before
`provider.getIndexStore`, `renameTable()` before the coordinator flush and
`provider.renameTableStores`. The throw always lands on a clean no-op — which is exactly what
kills the data-loss path. It also sits above every provider, so LevelDB, IndexedDB, React
Native LevelDB and the in-memory provider behave identically without per-provider analysis.

Also changed, non-functionally:

- `LevelDBProvider.encodeSublevelName`'s docstring claimed the encoding is injective. That
  was false for lone surrogates. It now says injective *over the names the guarded builders
  can produce*, and explains why it is not injective over arbitrary JS strings.
- A `NOTE:` tripwire at `store-module.ts:2596`, on the `provider.renameTableStores` call:
  the relocation runs before the catalog rewrite and nothing undoes it, so **any** new
  post-relocation failure mode would strand rows under the new physical name. Harmless
  today (bad target names are refused before anything moves; a table whose DDL text is
  unpersistable can never have held rows), but if a new failure mode appears there, the
  relocation must be undone or deferred.
- A `NOTE:` on `IndexedDBProvider.getStore` recording that IndexedDB object-store names are
  `DOMString`s compared by code unit, so a lone surrogate *should* survive per spec — but
  that was not verified against a real browser, and it no longer affects correctness.
- `docs/store.md` gained a paragraph next to the existing catalog-key guard discussion.

`buildStatsStoreName` was deliberately left unguarded: it is deprecated and has no callers
outside the barrel re-export in `common/index.ts`.

## User-visible behavior change

`create table "<lone surrogate>" using store` and `create index "<lone surrogate>" on t (v)`
now fail **at the DDL statement** with a message naming the unpaired surrogate, instead of
succeeding and then failing on the first INSERT/SELECT. Such a table could never persist its
schema anyway, so it was dead on arrival — the change is strictly earlier, not stricter.

A lone surrogate that appears only in the persisted **DDL text** (a quoted column name, a
`default` string literal) while the table's own name is clean still surfaces lazily on first
data access, because the store-name guard never sees it. That split is now spelled out in
the leading comment of the relevant block in `lone-surrogate-keys.spec.ts`.

Well-formed astral characters (a proper surrogate *pair*, e.g. `'\u{10000}'`) keep working.

## Use cases to exercise when reviewing

The regression that matters, against a real LevelDB directory:

```sql
create table p (id integer primary key, v integer) using store;
insert into p values (1, 111), (2, 222);
alter table p rename to "<lone surrogate>";   -- must raise
select v from p order by id;                  -- must STILL be 111, 222
insert into p values (3, 333);                -- p must still be writable
```

Plus: two `create table` statements differing only in *which* lone surrogate they use must
both reject and must never share a sublevel; `create index "<lone surrogate>" on t (b)` must
reject while `t`'s rows and its existing index-backed lookups keep working; and no key on
disk may carry the `%EF%BF%BD` folded sublevel prefix afterward.

## Tests

- `packages/quereus-store/test/key-builder.spec.ts` — 12 new unit tests: each builder rejects
  a lone high surrogate, a lone low surrogate, and one embedded mid-identifier, in the
  schema / table / index position; each still accepts a well-formed astral character.
- `packages/quereus-store/test/lone-surrogate-keys.spec.ts` — the three tests that pinned the
  old late-failure timing for a bad *table* name now assert rejection at `CREATE`, and assert
  `loadAllDDL()` stays empty. The index test was reworked to put the lone surrogate in the
  *index* name (the table clean) and to check the table's rows survive. The two DDL-text tests
  (column name, `default` literal) are untouched — their timing is unchanged.
- `packages/quereus-plugin-leveldb/test/lone-surrogate-store-name.spec.ts` — NEW, 4 tests over
  a real `LevelDBProvider` + `Database` + `StoreModule` on a temp dir, including a raw
  `ClassicLevel` reopen that asserts no `%EF%BF%BD` sublevel exists on disk.

**The regression tests were verified to actually catch the bug.** With the two
`assertKeyableIdentifiers` calls temporarily removed and the workspace rebuilt, all 4 LevelDB
tests fail — the rename test failing with exactly the reported symptom
(`expected [] to deeply equal [ { v: 111 }, { v: 222 } ]`) and the index test showing two
stranded keys under `!main.t_idx_%EF%BF%BD!`. The guard was restored and the workspace
rebuilt afterward; `git diff` on `key-builder.ts` confirms no probe residue.

## Validation run

| Command | Result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` (full workspace) | **0 failing**, 7m22s — quereus 7267 passing / 13 pending, store 1037, leveldb 55, sync 481, others green |
| `yarn workspace @quereus/plugin-leveldb run test` | 55 passing |
| `yarn typecheck` (fan-out) | clean |
| `npx tsc -p packages/quereus-store/tsconfig.test.json --noEmit` | clean |
| `npx tsc -p packages/quereus-plugin-leveldb/tsconfig.test.json --noEmit` | clean |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

`yarn test:store` (quereus logic tests re-run against the LevelDB store module) was **not**
run — it was not in the ticket's validation list and its wall-clock risks the runner's idle
timeout. Worth a thought during review given this ticket touches the store path.

## Known gaps — treat these as the starting point, not the finish line

- **Two providers compose their own physical names and never call the guarded builders.**
  `packages/quereus-plugin-react-native-leveldb/src/provider.ts:74-93` and
  `packages/quereus-plugin-nativescript-sqlite/src/provider.ts:57-78` build their store names
  from `schemaName`/`tableName` directly. They are safe *only* because `StoreModule` calls
  `buildDataStoreName` / `buildIndexStoreName` itself on all three paths (`store-module.ts`
  lines 616, 922, 2534/2542) before any provider call, so no unguarded name can reach them.
  Worth confirming there is no path that reaches `provider.getStore` / `getIndexStore`
  without going through those builder calls first.
- **`nativescript-sqlite` has a much broader, pre-existing collision surface.** Its
  `getTableName` (`provider.ts:58`) does `.replace(/[^a-zA-Z0-9_]/g, '_')`, so tables named
  `a-b` and `a b` collapse to the same SQLite table. That is unrelated to lone surrogates and
  well outside this ticket, but it is the same class of defect and nobody appears to have
  filed it. A reviewer may want to raise it.
- **`collectOccupiedStoreNames` (`store-module.ts:524`) now runs the guarded builder over
  *existing* schema objects,** not just the incoming one. If a table whose name carries a
  lone surrogate ever got into the schema manager by some other route, an unrelated
  `CREATE` / `RENAME` in that schema would start throwing. Believed unreachable — post-fix
  `create` throws before registration, and a legacy persisted catalog entry would have been
  folded to a real U+FFFD character on write, not a lone surrogate — but this is reasoning,
  not a test.
- **IndexedDB was not exercised.** It needs a browser. The spec says its object-store names
  compare by code unit, so lone surrogates should survive intact, but that is unverified;
  recorded as a code comment only, per the ticket.
- **No end-to-end test that a well-formed astral table name works through a real provider.**
  Astral acceptance is covered only at the builder unit level, so an over-rejection that only
  manifests deeper in a provider would not be caught.
