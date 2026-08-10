description: A synced table whose name contains a colon used to be invisible to other devices and its deletes could hit the wrong table; every part of a sync bookkeeping key now carries its own length, so no punctuation is reserved and no name can shift the split.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts (`joinKeyParts` + every build*/parse* pair)
  - packages/quereus-sync/src/metadata/column-version.ts (getRowVersions parses the key)
  - packages/quereus-sync/src/sync/snapshot-identity.ts (imports the shared `joinKeyParts`)
  - packages/quereus-sync/src/sync/change-applicator.ts (in-batch collapse keys — review fix)
  - packages/quereus-sync/src/sync/snapshot-stream.ts, sync-manager-impl.ts (comments)
  - packages/quereus-sync/test/metadata/keys.spec.ts, test/sync/colon-table-name.spec.ts
  - docs/sync.md (§ Storage layout, § Row identity vs. address, § Change log, § Metadata format version)
----

## What shipped

Every sync metadata key used to pack the schema and table name between a bare `.`
and a bare `:` (`cv:main.orders:…`), and every parser recovered them by hunting
for the first `.` and the first `:`. Both characters are legal in a quoted SQL
identifier, so `create table "a:b" (...)` produced keys that either failed to
parse (the table's rows never replicated, and applying an incoming snapshot
deleted the local cells) or parsed back confidently wrong as a table named `a`
(a tombstone for `a:b` could delete a row from the sibling table `a`).

Now every variable-length key component — schema, table, pk identity, column — is
written as `{length}:{text}` by one shared helper:

```ts
// packages/quereus-sync/src/metadata/keys.ts
export function joinKeyParts(...parts: string[]): string {
  return parts.map(part => `${part.length}${SEPARATOR}${part}`).join('');
}
```

No character is reserved, so no name can shift a split and no two distinct
component tuples can produce the same key. Layouts (`⟨x⟩` = one length-prefixed
component; fixed-width parts carry no prefix):

```
cv: cv:⟨schema⟩⟨table⟩⟨identity⟩⟨column⟩
tb: tb:⟨schema⟩⟨table⟩⟨identity⟩
sm: sm:⟨schema⟩⟨table⟩{version:010}
cl: cl:{hlc30}{type1}⟨schema⟩⟨table⟩⟨identity⟩[⟨column⟩]
qt: qt:⟨schema⟩⟨table⟩{hlc30}{type1}⟨rawIdentity⟩[⟨column⟩]
bl: bl:⟨schema⟩⟨table⟩
```

On-disk layout change: `SYNC_METADATA_FORMAT_VERSION` 2 → 3. An existing replica
refuses to open and must re-bootstrap from a peer snapshot — the already-documented
recovery, no migration pass.

Also landed at implement: `ColumnVersionStore.getRowVersions` parses the key
instead of stripping a known prefix (`buildColumnVersionRowPrefix` is module-private
now); `buildChangeLogKey`/`buildQuarantineKey` test `column !== undefined` rather
than truthiness, so a zero-length column name still emits its component.

## Review findings

Reviewed the implement diff (`95f38a4e`) first, then every consumer of the changed
key builders/parsers. `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` all
pass; `@quereus/sync` is 625 passing / 0 failing (621 after implement — 4 added
here). No pre-existing failures surfaced.

### Verified correct (no change needed)

- **The encoding is genuinely prefix-free.** A component's length digits are
  terminated by `:`, which is not a digit, so any key sharing a built prefix must
  agree on that component's length *and* text. Confirmed by argument and by the
  scan-bounds suite: `a` vs `a:b`, identity `a` vs `ab`, schema `s` vs `s:x`,
  table `t` vs `t:u` — all disjoint in both directions.
- **Ordering consumers survive the sort-order change.** Only two places depend on
  key order: `SchemaMigrationStore.getCurrentVersion` (a `reverse: true, limit: 1`
  scan inside one table's bounds — still correct, the version stays fixed-width
  and immediately after an exact table prefix) and the streaming snapshot's
  per-table/per-row contiguity, which is now a real guarantee rather than a
  convention.
- **The length-in-UTF-16-code-units claim holds across the byte round-trip.**
  `TextEncoder` folds a lone surrogate to U+FFFD, one code unit for one, and
  `joinKeyParts` always interposes `{len}:` between parts, so a trailing high
  surrogate can never pair with the next part's leading low surrogate.
- **`bl:` keys really are never parsed back.** `basis-lifecycle.ts:123`
  (`splitRelKey`) looks like a `bl:` parser but splits an in-memory lowercased
  `schema.table` relation key; the stored record carries schema and table in its
  value. The handoff's claim is accurate.
- **The "composite `{schema}.{table}` strings left alone" gap is safe.** Those
  sites (`snapshot-stream.ts` preserve list and `parseBootstrapTables`,
  `snapshot.ts:59`, `change-applicator.ts:78`, several in `sync-manager-impl.ts`)
  all split at the FIRST dot, which recovers a dotted *table* name correctly; only
  a dotted *schema* name would break. There is no `create schema` statement in the
  parser at all — physical schemas are `main` and `temp` — so a dotted physical
  schema name is not constructible.

### Found and fixed in this pass

- **The in-batch collapse keys had the same collision, and it dropped
  bookkeeping.** `change-applicator.ts`'s `rowIdentityKey` joined
  `` `${schema}.${table}:${identity}` `` — the exact shape this ticket removed from
  the stored keys. Table `a` with pk `'b:s:1'` and table `a:s:b` with pk `'1'` both
  spell `main.a:s:b:s:1` (the identity carries an `s:` type tag), so two rows of
  different tables collapse onto one max-HLC winner. Only the winner's `cv:`/`cl:`
  records are written, so the loser's row lands in the receiver's store with no
  bookkeeping — invisible to every downstream sync path and wiped by the next
  snapshot apply. Fixed to use `joinKeyParts`; `columnKey` likewise appends the
  column as a length-prefixed part. Confirmed the new e2e test fails against the
  old join (`a is in the receiver's snapshot: expected undefined to exist`) and
  passes against the fix. Documented in `docs/sync.md` § *Change log*.
- **A fresh `TextDecoder` per parse call**, at five sites in `keys.ts`. These run
  once per key across whole-prefix scans (`clearExistingMetadata` walks every
  `cv:`/`tb:`/`cl:` key), and the implement diff put `getRowVersions` on that path
  once per cell. Now one module-level `decoder`, matching the existing `encoder`.
- **Test gaps.** Added: a zero-length column round-trips as a *present* component
  (the arm the implementer deliberately fixed but left untested — the
  `column !== undefined` change had no coverage at all); empty schema/table/identity
  round-trip; and a malformed-key rejection suite covering a foreign prefix, an
  out-of-bounds length, a non-numeric length, a leading separator, trailing bytes
  past the declared components, and — most usefully — that a version-2 key does not
  read back as a version-3 key for any of `cv:`/`tb:`/`sm:`.
- **Stale test-file header.** `keys.spec.ts` still said "Tests for change-log key
  encoding"; it now covers every key family.

### Filed as new tickets

- `backlog/debt-sync-schema-version-store-unused-and-ambiguous` — `metadata/schema-version.ts`
  still spells its keys `sv:{schema}.{table}:{column}` and parses them by hunting
  for the first `.` and `:`: the identical defect, missed because the module has no
  runtime caller (only its own unit test), though it is exported from the package
  entry point and listed in the README's architecture diagram. `sv:` also appears
  in neither `keys.ts`'s prefix list nor `docs/sync.md`'s storage-layout table.
  Filed as debt, not a bug, because no code path reaches it today; the ticket asks
  for the delete-or-wire decision first.

### Amended an existing ticket

- `fix/bug-sync-migration-version-key-ignores-object-kind` plans to widen the same
  `sm:` key and bump the format version. Appended a note that the layout is now
  length-prefixed and version **3** is taken, so an object-kind component is one
  more length-prefixed part and the bump is to **4**.

### Tripwires (recorded, not ticketed)

- **Key sort order changed** from alphabetical-by-name to length-major-then-name.
  Nothing in-repo depends on alphabetical order, and per-table/per-row contiguity —
  the only ordering the streaming snapshot uses — is preserved. Parked as the
  explicit tradeoff sentence in `docs/sync.md` § *Storage layout*; there is no
  single code site to annotate.

### Considered and deliberately not actioned

- **LevelDB / IndexedDB plugins untested** (every sync test runs against
  `InMemoryKVStore`). Read the diff for backend-sensitive behaviour and found none:
  keys are opaque `Uint8Array` to both, and the only byte-level operation,
  `incrementLastByte`, is unchanged and already produced non-UTF-8 upper bounds
  before this work. Not worth a ticket.
- **No end-to-end 2 → 3 upgrade rehearsal.** The `fv:` gate specs cover "refuses a
  different version", and re-bootstrap-from-peer is the documented recovery — the
  same posture as the 1 → 2 bump. Unchanged by this work, so not a finding against it.
