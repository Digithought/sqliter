description: A synced table whose name contains a colon is silently invisible to other devices — its rows never replicate, and a delete of one of its rows can be misapplied to a different table entirely.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts (the one site — every build*/parse* pair)
  - packages/quereus-sync/src/sync/snapshot-identity.ts (has `joinKeyParts`, the encoding to reuse)
  - packages/quereus-sync/src/sync/snapshot-stream.ts (clearExistingMetadata ~351, tombstone contiguity ~228/457/582)
  - packages/quereus-sync/test/metadata/keys.spec.ts
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts (model for the new e2e spec)
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts
  - docs/sync.md (§ Metadata format version, ~569)
difficulty: medium
repro: verified
----

## Status of the original report

This ticket supersedes `bug-sync-colon-in-column-name-drops-cell`. Half of what
that ticket described is **already fixed**: `bug-sync-pk-metadata-key-identity`
(commit `a607566b`) made the primary-key component of every metadata key
length-prefixed, so the identity/column split is now exact and a **column** name
containing a colon round-trips fine. Verified:

```
buildColumnVersionKey('main', 't', encodeRawPkIdentity([1]), 'a:b')
  → parse = { schema: 'main', table: 't', identity: 'n:1', column: 'a:b' }
```

The `NOTE:` that ticket said pointed here is also gone from `keys.ts`.

What was **not** fixed is the other half of the same key: the `{schema}.{table}:`
prefix, which still uses a bare `.` and a bare `:` as delimiters around two
components that are arbitrary user text. That is what remains, and it produces
the identical symptom one component to the left.

## What happens

`create table "a:b" (...)` is legal SQL and the engine accepts it. Nothing in the
sync layer rejects it — `assertKeyableIdentifiers` (`keys.ts`) rejects only
unpaired surrogates. But every metadata key packs the table name between a `.`
and a `:`, and every parser recovers it by hunting for the first `.` and the
first `:`. A colon in the table name lands the split in the wrong place.

Measured, by calling the builders and parsers directly (`main` / `a:b` / pk `[1]`):

| key | parsed back as |
| --- | --- |
| `buildColumnVersionKey` | `null` |
| `buildChangeLogKey` | `null` |
| `buildTombstoneKey` | `{ schema: 'main', table: 'a', identity: 'b:n:1' }` |

End to end, with two peers each running `create table "a:b" (id integer primary
key, v text) using store`, an insert on peer 1, and a manual relay:

```
p1 rows       = [{ id: 1, v: 'x' }]     ← the local write is fine
relay result  = { applied: 0, skipped: 0, conflicts: 0, transactions: 0 }
p2 rows       = []
```

No warning anywhere. The table simply does not exist as far as sync is
concerned.

The `null` rows in that table are the same silent-drop family the original ticket
described — `collectAllChanges`, `getChangesSince`, `getSnapshot`,
`getSnapshotStream` all treat `null` as "skip this record", and
`clearExistingMetadata` (`snapshot-stream.ts:351`) treats it as "not on the
preserve list, delete it", so applying an incoming snapshot wipes the local cells
too.

The tombstone row is worse, and is the reason this is filed as a data-loss bug
rather than a replication gap. `parseTombstoneKey` does not fail — it returns a
**confidently wrong** answer: a tombstone for table `a:b` reads back as a
tombstone for table `a`. The snapshot tombstone chunk takes `schema`/`table` from
the parsed key but `pk` from the record value (the untouched raw pk), so a peer
receiving that snapshot is told to delete row `pk` from table `a`. If a table
named `a` exists there with a matching row, the delete lands on it. *(Verified at
the key level — `parseTombstoneKey` returns `table: 'a'`. The cross-table delete
reaching the receiver is inferred by reading the chunk-building code, not
observed; the new e2e spec below should settle it.)*

The same ambiguity also means the "one table's tombstones are contiguous in the
`tb:` scan" claim asserted at `snapshot-stream.ts:228` is not actually guaranteed
today — tables `a` and `a:b` interleave under it.

## Root cause

One site: `packages/quereus-sync/src/metadata/keys.ts`. Four of the six key
families embed schema and table as bare text between reserved punctuation:

```
cv:{schema}.{table}:{identity_length}:{identity}:{column}
tb:{schema}.{table}:{identity}
sm:{schema}.{table}:{version}
cl:{hlc}{type}{schema}.{table}:{identity_length}:{identity}[:{column}]
qt:{schema}.{table}:{hlc}{type}:{raw_identity}[:{column}]
bl:{schema}.{table}
```

The primary key and column components were already made unambiguous. Schema and
table were not, and the fix is the same one: length-prefix them.

Note `snapshot-identity.ts:41` already has exactly this helper, written for
exactly this reason:

```ts
function joinKeyParts(...parts: string[]): string {
	return parts.map(part => `${part.length}:${part}`).join('');
}
```

## Expected behaviour

Any schema, table, or column name the engine accepts, and any primary-key value,
must survive a full round trip through sync — local write → full sync / delta
sync / snapshot → peer, and back — with no cell silently skipped, no record
attributed to the wrong table, and no local data deleted on snapshot apply.

## Approach

**Recommended: length-prefix schema and table too**, moving `joinKeyParts` into
`keys.ts` and having `snapshot-identity.ts` import it rather than keeping two
copies. Every component of every metadata key then carries its own length and no
delimiter is reserved. Layouts become:

```
cv: cv:{n}:{schema}{n}:{table}{n}:{identity}{n}:{column}
tb: tb:{n}:{schema}{n}:{table}{n}:{identity}
sm: sm:{n}:{schema}{n}:{table}{version_padded_10}
cl: cl:{hlc30}{type1}{n}:{schema}{n}:{table}{n}:{identity}[{n}:{column}]
qt: qt:{n}:{schema}{n}:{table}{hlc30}{type1}{n}:{raw_identity}[{n}:{column}]
bl: bl:{n}:{schema}{n}:{table}
```

Things to check while doing it, none of which look like blockers:

- **Scan bounds stay exact.** Every prefix builder (`buildTableColumnVersion…`,
  `buildColumnVersionScanBounds`, `buildTombstoneScanBounds`,
  `buildSchemaMigrationScanBounds`, `buildQuarantineScanBounds` including its
  schema-only form) still produces a fully determined byte prefix, because each
  component's length is fixed by the component itself. Confirm the schema-only
  quarantine prefix `qt:{n}:{schema}` cannot match a different schema.
- **Sort order changes** from lexicographic-by-name to length-major-then-name.
  Per-table and per-row *contiguity* is preserved (that is what the streaming
  code actually relies on), but cross-table and cross-row ordering differs. Run
  `snapshot-stream-order.spec.ts` and the peer-harness e2e specs and look for
  anything that asserted alphabetical order.
- **This is an on-disk layout change**, so bump `SYNC_METADATA_FORMAT_VERSION`
  from 2 to 3 in `keys.ts`, update its doc comment, and update
  `docs/sync.md` § *Metadata format version* (~line 569, which names version 2
  explicitly). Existing replicas re-bootstrap from a peer snapshot; that is the
  documented recovery and needs no migration pass.
- `bl:` is never parsed back, but keep it uniform so the file has one rule.

**Fallback, only if the ordering fallout turns out to be large:** reject `:` in
schema and table names inside `assertKeyableIdentifiers`, the way unpaired
surrogates are already rejected. The original ticket explicitly allows this
("sync must reject it loudly at write time rather than accepting the write and
losing the data later"). It is worse — a table that already exists locally starts
throwing on every write — so treat it as a retreat, not a first choice.

## Adjacent ticket, no dependency

`bug-sync-migration-version-key-ignores-object-kind` (in `tickets/fix/`) also
changes `buildSchemaMigrationKey` and also needs a format-version bump. Neither
blocks the other. If that one has already landed when you pick this up, fold the
length-prefixing into whatever `sm:` layout it produced and reuse its bump
instead of bumping twice.

## Not reproduced: schema names containing a dot

`parseColumnVersionKey` splits schema from table at the **first** `.`, so a
schema named `x.y` holding table `t` reads back as schema `x`, table `y.t`. The
composite `${schema}.${table}` strings used for the snapshot preserve list and
`completedTables` are ambiguous the same way. But no path was found to create
such a schema — `create table "x.y".t (...)` fails with `Schema 'x.y' not found`,
and schemas are only created implicitly. Length-prefixing removes the ambiguity
for free; do not spend time hunting for a reachable path.

## TODO

- [ ] Move `joinKeyParts` from `snapshot-identity.ts` into `keys.ts` as the shared
      component encoder; import it back in `snapshot-identity.ts` (do not leave two copies).
- [ ] Rewrite the `cv:`/`tb:`/`sm:`/`cl:`/`qt:`/`bl:` builders and parsers in
      `keys.ts` to length-prefix schema and table; update each function's format
      doc comment.
- [ ] Verify every scan-bounds builder still emits an exact, unambiguous byte
      prefix under the new layout — including `buildQuarantineScanBounds`'
      schema-only and no-argument forms.
- [ ] Bump `SYNC_METADATA_FORMAT_VERSION` to 3, update its doc comment in
      `keys.ts` and `docs/sync.md` § *Metadata format version*.
- [ ] Fix the contiguity comment at `snapshot-stream.ts:228` — under the new
      layout the guarantee is real; say why (length-prefixed prefix), not "the `:`
      separator".
- [ ] Unit specs in `test/metadata/keys.spec.ts`: schema, table, identity and
      column each containing `:` and `.`, round-tripping through every
      `build*`/`parse*` pair; plus tables `a` and `a:b` in one schema producing
      non-overlapping scan bounds.
- [ ] New e2e spec modelled on `test/sync/dotted-table-name.spec.ts` (call it
      `colon-table-name.spec.ts`): with `create table "a:b" (id integer primary
      key, v text) using store` on two peers, assert (a) a relayed insert applies
      and the row lands on peer 2, (b) `getSnapshot()` / `getSnapshotStream()`
      carry the table, (c) a delete on peer 1 removes only the `a:b` row on
      peer 2 and does **not** touch a sibling table named `a`, (d) applying an
      incoming snapshot with `a:b` on the preserve list does not wipe its local
      cells.
- [ ] `yarn workspace @quereus/sync run test` green; then `yarn build`,
      `yarn typecheck`, `yarn test`.
