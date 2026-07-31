description: A synced table whose name contains a colon used to be invisible to other devices and its deletes could hit the wrong table; every part of a sync bookkeeping key now carries its own length, so no punctuation is reserved and no name can shift the split.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts (the whole change: `joinKeyParts` + every build*/parse* pair)
  - packages/quereus-sync/src/sync/snapshot-identity.ts (now imports `joinKeyParts` instead of holding a copy)
  - packages/quereus-sync/src/metadata/column-version.ts (getRowVersions parses the key instead of stripping a prefix)
  - packages/quereus-sync/src/sync/snapshot-stream.ts (tombstone-contiguity comment ~228)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (one stale `sm:` layout comment)
  - packages/quereus-sync/test/metadata/keys.spec.ts (new: round-trip + scan-bounds suites)
  - packages/quereus-sync/test/sync/colon-table-name.spec.ts (new e2e)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts (two literal-prefix assertions replaced)
  - docs/sync.md (§ Storage Layout, § Row identity vs. address, § Metadata format version)
difficulty: medium
----

## What changed

Every sync metadata key used to pack the schema and table name between a bare `.`
and a bare `:` — `cv:main.orders:…` — and every parser recovered them by hunting
for the first `.` and the first `:`. Both are legal characters in a quoted SQL
identifier, so `create table "a:b" (...)` produced keys that either failed to
parse (the table's rows never replicated, and applying an incoming snapshot
deleted the local cells) or parsed back *confidently wrong* as a table named `a`
(a tombstone for `a:b` could delete a row from the sibling table `a` on the
receiver).

Now **every** variable-length key component — schema, table, pk identity, column
— is written as `{length}:{text}`. No character is reserved as a delimiter, so no
name can shift a split, and no two distinct component tuples can produce the same
key. The helper is one exported function:

```ts
// packages/quereus-sync/src/metadata/keys.ts
export function joinKeyParts(...parts: string[]): string {
  return parts.map(part => `${part.length}:${part}`).join('');
}
```

`snapshot-identity.ts` had its own private copy (used for in-memory grouping
keys); it now imports this one.

Resulting layouts (`⟨x⟩` = one length-prefixed component; fixed-width parts —
the 30-byte HLC, the 1-byte change type, `sm:`'s zero-padded version — carry no
prefix):

```
cv: cv:⟨schema⟩⟨table⟩⟨identity⟩⟨column⟩
tb: tb:⟨schema⟩⟨table⟩⟨identity⟩
sm: sm:⟨schema⟩⟨table⟩{version:010}
cl: cl:{hlc30}{type1}⟨schema⟩⟨table⟩⟨identity⟩[⟨column⟩]
qt: qt:⟨schema⟩⟨table⟩{hlc30}{type1}⟨rawIdentity⟩[⟨column⟩]
bl: bl:⟨schema⟩⟨table⟩
```

This is an **on-disk layout change**: `SYNC_METADATA_FORMAT_VERSION` went 2 → 3.
An existing replica refuses to open and must re-bootstrap from a peer snapshot —
the already-documented recovery, no migration pass. `docs/sync.md` § *Metadata
format version* was updated to match.

Two smaller things landed with it:

- `ColumnVersionStore.getRowVersions` recovered the column name by slicing a
  known prefix off the key; it now calls `parseColumnVersionKey`, so the
  `buildColumnVersionRowPrefix` export is gone (it is module-private now).
- `buildChangeLogKey` / `buildQuarantineKey` decided "is there a column?" by
  truthiness, so a zero-length column name would have emitted 3 components where
  the parser demands 4 and the record would have read back as unparseable. Both
  now test `column !== undefined`. Dormant today (SQL will not accept an empty
  column name), fixed because it is the same builder/parser contract.

## How to validate

**Automated (all green):**

- `yarn workspace @quereus/sync run test` — 621 passing, 0 failing (was 608 before;
  13 new).
- `yarn build`, `yarn typecheck`, `yarn test` (whole repo) — all clean.

**New unit coverage** — `packages/quereus-sync/test/metadata/keys.spec.ts`:

- *separator-bearing identifiers round-trip through every key family*: schema,
  table, identity and column each drawn from `['a:b', 'a.b', 'x:y.z:', '.:', 'a']`,
  round-tripped through `cv:`, `tb:`, `sm:` and `cl:` (column and delete forms).
- *scan bounds stay exact*: a table named `a` and one named `a:b` in the same
  schema produce non-overlapping `cv:`/`tb:`/`sm:` bounds in **both** directions;
  a row scan for pk identity `'a'` does not pick up `'ab'`; the schema-only
  quarantine prefix `qt:⟨schema⟩` cannot match a different schema (`s` vs `s:x`),
  the per-table form cannot match a different table (`t` vs `t:u`), and the
  no-argument GC-sweep form still covers all of them.

**New end-to-end coverage** — `packages/quereus-sync/test/sync/colon-table-name.spec.ts`,
modelled on the existing `dotted-table-name.spec.ts`. Two real-engine peers, table
`"a:b" (id integer primary key, v text) using store`:

1. a relayed insert reaches peer 2 (before: `applied: 0`, peer 2 empty, no warning);
2. a delete of the `a:b` row on peer 1 removes exactly that row on peer 2 and
   leaves a **sibling table literally named `a`, holding the same pk**, untouched;
3. `getSnapshot()` and `getSnapshotStream()` both carry the full name, and the
   snapshot's tombstone chunk is attributed to `a:b` — never to `a`;
4. a resumed snapshot apply with `main.a:b` on the preserve list does not wipe the
   table's local cells.

**Manual smoke, if you want it:** create `"a:b"`, insert, sync two peers, then
delete and confirm only that table's row goes. Any pre-existing replica will
refuse to open with a *format version 2 does not match* error — that is the
intended v3 gate, not a regression.

## Known gaps / what a reviewer should push on

- **No upgrade path is exercised.** The `fv:` gate specs cover "refuses a
  different version", but nothing simulates a real v2 replica meeting v3 code and
  recovering via peer bootstrap. That is the documented recovery and was already
  the posture for the 1 → 2 bump; it is still untested end to end.
- **`bug-sync-migration-version-key-ignores-object-kind`** (in `tickets/fix/`)
  also plans to change `buildSchemaMigrationKey` and bump the format version. It
  was not landed when this went in, so this bumped to **3** on its own; that
  ticket now needs to fold into the v3 `sm:` layout and bump to **4** rather than
  reuse a 2 → 3 bump.
- **Composite `"{schema}.{table}"` strings are unchanged and still dot-joined** —
  the snapshot preserve list, `SnapshotCheckpoint.completedTables`, and the
  `tableKeys` grouping map in `snapshot-stream.ts`. A dotted *table* name is
  recovered correctly (split at the first dot); a dotted *schema* name would not
  be. Deliberately left alone: the source ticket found no way to create a schema
  whose name contains a dot (`create table "x.y".t (...)` fails with
  *Schema 'x.y' not found*), and this change removes the ambiguity at the key
  level regardless. Worth a second opinion on whether that reachability claim
  holds.
- **Key sort order changed** from lexicographic-by-name to
  length-major-then-name. Per-table and per-row contiguity — the only ordering
  the streaming snapshot actually depends on, and now a genuine guarantee rather
  than a convention (the contiguity comment at `snapshot-stream.ts:228` was
  rewritten to say why) — is preserved. Nothing in the suite asserted alphabetical
  order and everything passes, but an external consumer that assumed name order
  would see a difference.
- **Storage backends:** every sync test runs against `InMemoryKVStore`. The
  LevelDB / IndexedDB plugins were not exercised. Nothing in the change is
  backend-specific (the keys are opaque bytes either way), but it is untested.
- **`bl:` keys are never parsed back** — only written and iterated, with the
  payload in the record value. They were made length-prefixed for uniformity, so
  that arm has no round-trip test; it is covered only by the basis-lifecycle
  specs continuing to pass.
