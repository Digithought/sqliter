description: A device that drops a table and immediately creates a new one with the same name now sends that pair of steps to other devices without the new table's rows going missing — previously the rows were filed away as "belonging to a table I don't have" and showed up late, or never.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts           # computeBatchTableFates + appliedDropKeys + the three read sites
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts   # 8 cases
  - packages/quereus-sync/test/sync/_peer-harness.ts              # provider now implements deleteTableStores
  - packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts
  - docs/migration.md                                             # § 4 unknown-table bullet + reactive-drain parenthetical
  - tickets/backlog/bug-sync-recreated-table-inherits-dropped-table-metadata.md  # holds the two deferred blocking arms
repro: verified
----

## What shipped

`applyChanges` used to reduce a batch's schema migrations to two order-blind sets
(`created` / `dropped`) and call a table absent when it appeared in both, so a
`create → drop → create` batch diverted every row for that table as unknown-table —
held until the next maintenance sweep under the default `quarantine`, lost outright
under `ignore`.

The sets are replaced by one per-table verdict derived from the schema steps' HLCs:

```ts
interface BatchTableFate {
	present: boolean;    // the table's LAST create/drop step (by HLC) is a create_table
	recreated: boolean;  // present, AND some drop_table has a strictly lower HLC
}
function computeBatchTableFates(changes: ChangeSet[]): Map<string, BatchTableFate>;
```

Only `create_table` / `drop_table` participate; a table the batch's DDL never touches is
absent from the map and falls back to the basis read. Three sites read it — the
row-admission gate (`fate ? fate.present : inBasis`), `freshLocalTable`, and the reactive
drain skip (`if (fate && !fate.present) continue`).

The `freshLocalTable` arm exists because dropping a table does not purge its sync
metadata: without it, the re-created table's rows resolve against the dropped
incarnation's cell versions and tombstones, and a stale tombstone silently discards them
under the default `allowResurrection: false`.

**Added in review:** `freshLocalTable` now also requires the batch to *apply* the
`drop_table` (`appliedDropKeys`, built from `pendingSchemaMigrations` after Phase 1a) —
see finding 1.

## Review findings

Read the implement diff (`git show 4bd5087b`) before the handoff, then the whole of
`change-applicator.ts`, `resolveChange`, `reconcileInBatchDeletes`, `drainTableGroup`,
`_peer-harness.ts`, and `docs/migration.md` § 4.

### Fixed in this pass

**1. Major, fixed: a re-delivered drop/re-create batch clobbered newer local writes.**
`freshLocalTable` makes `resolveChange` skip *every* read, so the change is applied
unconditionally — no LWW comparison at all. The implement diff granted that to any batch
whose steps *describe* a re-create, including one whose steps are all HLC-dominated and
change no local schema. Re-application is a live path, not a hypothetical (see
`schema-replication-idempotency.spec.ts`: a peer re-applies the same batch on every sync
until its watermark advances; a from-zero re-sync does the same). Verified before fixing —
receiver takes the batch, writes a strictly newer value locally, is handed the same batch
again:

```
AssertionError: expected [ { id: 1, w: 'origin' } ] to deeply equal [ { id: 1, w: 'newer' } ]
```

The newer value was silently overwritten by the older remote one, and the column version
regressed with it — divergence, not just a lost write. This was **introduced by the diff
under review**: pre-fix, `freshLocalTable = !inBasis` gave a receiver that already had the
table an ordinary LWW resolution.

Fix: read-free resolution is now reserved for the batch that actually *performs* the
re-create — `fate.recreated === true && appliedDropKeys.has(key)`. If the drop is skipped
as HLC-dominated, the re-create already happened here, the local table *is* the new
incarnation, and its surviving metadata is that incarnation's, so it must be consulted.
`present` is still computed over all migrations (a skipped migration means the receiver
already reached that state), so admission is unchanged. Pinned by a new spec.

The handoff's known gap 3 pointed at the right code ("worth deciding whether it should
be") but understated it as a skipped comparison; it is a clobber.

**2. Minor, fixed: known gap 4 was a test-harness artifact, not a product bug.** The
handoff reported that on a real peer `drop table` + `create table` leaves the old rows in
the store (`UNIQUE constraint failed: widgets PK` on re-inserting a pre-drop primary key)
and left it unfiled. Cause: `_peer-harness.ts`'s `createInMemoryProvider` implements no
`deleteTableStores`, so `StoreModule.tearDownTableStorage` takes its `closeStore`
fallback — a no-op in that provider — and `getStore` hands the re-created table the
dropped incarnation's store. Product code is fine; `quereus-store`'s own provider
(`test/coordinator-callback-leak.spec.ts`) implements it.

This mattered here because every drop/re-create spec in the ticket ran against a store
where the old incarnation's rows survived — exactly the thing under test. The harness now
implements `deleteTableStores` (dropping map entries without closing the handles — the
transaction coordinator keys buffered ops on the handle, and closing broke two
`transaction-commit.spec.ts` cases that drop a table in the same transaction as a write to
it). After the fix a re-created table reads empty and a pre-drop primary key is reusable.
No `deleteIndexStore` was added — same class of gap for `drop index`, but no spec here
depends on it.

**3. Minor, fixed: docs overstated the read-free rule.** `docs/migration.md` § 4 said a
drop-then-create batch's rows "are resolved read-free" flatly. Now qualified with the
applied-drop condition from finding 1. The rest of the implement diff's § 4 edits read
correctly — both the timestamp-ordered detection rule and the reactive-drain parenthetical
match the code.

**4. Minor, fixed: stale cross-reference.** The stale-tombstone spec pointed at "the note
in the review handoff", which does not survive this stage. It now names
`bug-sync-recreated-table-inherits-dropped-table-metadata` and says explicitly that the
`freshLocalTable` mitigation is **same-batch only** — a tombstone whose drop/re-create
landed in an *earlier* batch still blocks, because a later batch carrying only rows has no
schema steps and so no `fate`.

### Tests

The implement diff's 6 cases are sound and each asserts through `select` on real
`Database` peers. Two added:

- **re-delivered batch does not clobber a newer local write read-free** — finding 1's
  regression guard. Fails without the fix (output above).
- **lands a row whose primary key existed in the dropped incarnation** — the primary-key
  reuse case the harness artifact made impossible before finding 2. Pins both halves of
  "the rows land in the new incarnation": the drop reclaims the old row (no phantom
  survivor) and the new write for that same key lands, leaving receiver equal to origin.

Coverage checked and deliberately *not* added: the two deferred blocking arms (in-batch
delete from the dropped incarnation; a tombstone whose drop/re-create landed in an earlier
batch) would both be failing tests documenting open bugs, so they stay described on
`bug-sync-recreated-table-inherits-dropped-table-metadata` rather than committed red.

### Verified as claimed

- **Known gap 1** (in-batch pre-drop delete blocks the post-re-create write via
  `reconcileInBatchDeletes`) is real, correctly out of scope, and genuinely filed — the
  appended second arm on `bug-sync-recreated-table-inherits-dropped-table-metadata` names
  both code sites and the one policy decision they share. Nothing further to file.
- **Known gap 2** (`keepLatestStep`'s tie branch is unreachable because an HLC is unique
  per fact) holds. `recreated`'s `compareHLC(drop.hlc, step.hlc) < 0` is likewise
  equivalent to `drop !== undefined` in practice, since the deciding step is the batch
  max. Both are defensive, both documented in the JSDoc, neither worth a synthetic spec.
- The `fate &&` guard in the drain-skip loop is dead today (every `create_table` in
  `pendingSchemaMigrations` came from `changes`, so its key is always in the map) but is
  cheap and correct; left as-is.

### Tripwire

`change-applicator.ts` is 1144 lines (`wc -l`), second-largest in the package after
`sync-manager-impl.ts` at 1523; this diff added ~30. Not filed — the file is cohesive and
not an outlier for the package. Parked as a `NOTE:` at the drain block, which is the
natural seam (it shares only `resolveChange`, `reconcileInBatchDeletes`,
`commitChangeMetadata`, and `admitGroup` with the wire-apply half).

### Empty categories

No new `fix/`, `plan/`, or `backlog/` tickets. Everything major was either fixable in this
pass (finding 1) or already owned by an open ticket whose `files:` names the same site
(the two blocking arms). No resource-cleanup, error-handling, or type-safety findings: the
diff adds no I/O, no `catch`, and no assertions or casts — `SchemaMigration` and
`BatchTableFate` are fully typed and `fate?.recreated === true` avoids a truthiness
widening.

## Validation

- `yarn workspace @quereus/sync run test` — **609 passing, 0 failing** (607 at handoff, +2
  new).
- `yarn test` (whole workspace) — 0 failing across every package.
- `yarn build` — exit 0. `yarn workspace @quereus/sync run typecheck` — exit 0 (its
  `typecheck` covers `tsconfig.test.json`, so the spec call sites are type-checked).
- `yarn lint` — exit 0.

No pre-existing failures encountered, so no `.pre-existing-error.md` was written.
