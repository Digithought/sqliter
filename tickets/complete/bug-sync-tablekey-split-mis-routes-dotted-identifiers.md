----
description: Fixed a bug where a database table whose quoted name contains a dot (like "a.b") could sync to the wrong table, or be silently dropped from a snapshot, in the sync engine.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/sync/snapshot.ts
  - packages/quereus-sync/src/sync/snapshot-stream.ts
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts
----

# Sync: `tableKey.split('.')` mis-routes quoted identifiers containing dots — COMPLETE

## What shipped

A composite `"<schema>.<table>"` grouping key was built by joining two known
strings with `.`, then re-split later. A quoted SQL identifier may legally
contain a dot (`create table "a.b" (...)`), so `'main.a.b'.split('.')` yields
three segments and `const [schema, table] = ...` silently drops the last.

Four sites, all in `packages/quereus-sync`:

1. `store-adapter.ts` `groupChangesByTable` consumer — reads `schema`/`table`
   off the first grouped change instead of splitting the key.
2. `snapshot.ts` `getSnapshot()` — map value carries `{ schema, table, rows }`.
3. `snapshot-stream.ts` `streamSnapshotChunks()` — `tableKeys` is now a
   `Map<string, { schema, table }>`.
4. `snapshot-stream.ts` `parseBootstrapTables()` — cannot carry a pair (the
   checkpoint persists only the flat string), so it splits on the **first** dot,
   which recovers a dotted table name. Dotted *schema* names remain an accepted
   edge case, documented in a `NOTE:` at the function, matching the tradeoff
   already shipped in `@quereus/store`'s `buildDataStoreName`.

Regression coverage: `packages/quereus-sync/test/sync/dotted-table-name.spec.ts`,
one test per site, verified red-before / green-after by stashing the source fixes.

## Review findings

**Checked:** the implement diff read cold before the handoff summary; each of the
four fixed sites re-read in full context; `groupChangesByTable` invariants;
`parseBootstrapTables`' no-dot branch; the new spec's assertions (do they fail
for the right reason, do they cover error paths and the resumed-transfer path);
a repo-wide sweep for the same `split('.')` shape; `docs/sync.md`; lint,
typecheck, and full test suite.

**Correctness:** no defects found in the diff.
- `tableChanges[0]` is safe: `groupChangesByTable` only creates a group by
  seeding it with a change, so no group is ever empty.
- `parseBootstrapTables`' no-dot branch now returns `table: ''` where it
  previously returned `undefined`. Unreachable — every `completedTables` entry is
  produced by joining a schema and a table — and `''` is at least type-honest
  where `undefined` was a lie against the declared `string`. Left as-is.
- Test quality: the four tests are genuine end-to-end drives (two real peers with
  a relay for site 1; a hand-seeded checkpoint plus a `notifyExternalChange` spy
  for site 4), not assertions against the fixed helpers in isolation. Adequate.

**Major (new ticket filed):** the handoff correctly noted it had not swept
outside its own file list. The sweep found the *same defect class* alive in the
core engine — `base.split('.')` on a joined `schema.table` in
`database-watchers.ts`, `database-assertions.ts` (two sites),
`database-materialized-views.ts`, and `func/builtins/explain.ts`. Filed as
`backlog/bug-core-fq-name-split-mis-routes-dotted-table-names`. Notably the sweep
found **nothing** in `quereus-sync-client` or `sync-coordinator` — the two
packages the handoff flagged as unaudited are in fact clean.

**Tripwire (recorded, not ticketed):** the joined `"<schema>.<table>"` key is
still ambiguous when the *schema* name contains a dot — schema `"main.a"` table
`b` collides with schema `main` table `"a.b"`, which would merge two tables'
changes into one group in `groupChangesByTable`. No consumer re-splits the key
anymore, so today the key is opaque and the only cost would be that misgrouping,
and only if both dotted-schema tables exist. Dotted schema names are effectively
unreachable. Parked as a `NOTE:` comment on `groupChangesByTable` in
`store-adapter.ts`, naming the fix if it ever trips (delimiter identifiers
cannot contain).

**Docs:** read `docs/sync.md`. Its one `schema.table` mention documents the
`byTable` key format of `getUnknownTableStats()` — a stats-reporting convention,
not this routing path, and unchanged by the fix. Nothing stale. No other doc in
the repo describes these four call sites. No doc changes needed.

**Validation:** `yarn workspace @quereus/sync run test` → 450/450 passing.
`yarn workspace @quereus/sync run typecheck` → clean. `yarn lint` → clean. No
pre-existing failures surfaced.
