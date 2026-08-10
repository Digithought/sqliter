description: Two devices that each created the same table offline could never finish syncing with each other; replicated table and index changes are now applied only when they are not already in place, so the two sides converge instead of failing forever.
prereq:
files:
  - packages/quereus-sync/src/sync/store-adapter.ts (`decideSchemaChange`, `normalizeDDL`, `findIndexOwner`, `assertDefinitionMatches`, `schemaEventSignature`, `applySchemaChange`)
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts (15 cases)
  - packages/quereus-sync/test/sync/_peer-harness.ts (`relayAll`, shared `relayWith`)
  - docs/sync.md (§ Schema Synchronization → "Idempotent DDL application")
  - tickets/backlog/bug-sync-schema-migrations-replicate-empty-ddl.md (filed during implement)
difficulty: medium
----

## What was wrong

Two peers that each ran `create table orders` while offline both recorded a
`create_table` migration. On sync, the migration with the higher HLC is admitted
at the peer that *already has* the table, and `applySchemaChange` re-ran the raw
DDL there — which throws "Table main.orders already exists".

That throw lands in `ApplyToStoreResult.errors`, and any non-empty `errors`
aborts the whole admission unit before its CRDT metadata commits. The receiver's
rows landed in storage with no column-version / tombstone records, its peer
watermark never advanced, and it re-applied and re-failed the identical batch on
every subsequent sync. Permanent non-convergence.

## What was built

`applySchemaChange` now decides before it acts. `decideSchemaChange` runs before
`events.expectRemoteSchemaEvent` and returns:

- `execute` — object absent for a create, present for a drop: unchanged behavior.
- `already-applied` — object already in the wanted state with a matching
  definition: log at debug, execute nothing, still count applied so the
  migration metadata commits and the change stops being re-sent.
- (throw) — object exists with a different definition: an error naming the object
  and printing both definitions.

Covers `create_table`, `drop_table`, `add_index`, `drop_index`; column-level
migrations fall through to `execute`. "Definition matches" regenerates the local
canonical DDL (`generateTableDDL` / `generateIndexDDL`, no `db` argument — the
same call the origin used) and compares under `normalizeDDL` (strip trailing `;`,
collapse whitespace, trim, lowercase).

Adjacent fix in the same function: `schemaEventSignature` replaced the old
string-shape derivation (`type.startsWith('drop')`, `type.includes('table')`),
which produced the wrong signature for `add_index` and every `*_column` type,
with an explicit map that is the exact inverse of `mapSchemaMigrationType` in
`sync-manager-impl.ts`.

## Review findings

### Read cold, then verified against the handoff

Read the implement diff (`2ac32955`) before the handoff summary, then verified
each of its load-bearing claims against the code it depends on rather than taking
them at face value:

- **`schemaEventSignature` really is the inverse of `mapSchemaMigrationType`** —
  checked `sync-manager-impl.ts:109-126`. Confirmed. The `add_column` /
  `drop_column` entries are unreachable from that map (it only ever produces
  `alter_column` for a table alter) but agree with it in direction.
- **The `create_table` definition comparison is symmetric.** The origin emits
  `generateTableDDL(reconciledSchema)` (`store-module.ts:700`) — the schema
  *after* `reconcilePkCollations` applies the store's key collation to an
  implicit-default text primary key. If the receiver's catalog held the
  pre-reconciliation schema, every duplicate create with a text PK would have
  been a false conflict. It does not: `reconcilePkCollations`' own docblock
  records that the reconciled schema is what `finalizeCreatedTableSchema`
  registers. Symmetric, no false conflict.
- **`already-applied` still counts as applied** — the adapter's schema loop
  increments `schemaChangesApplied` on any non-throwing call, so returning early
  commits the metadata. This is the whole point of the fix and it holds.
- **Only `create_table` carries DDL** — checked every `emitSchemaChange` call in
  `store-module.ts`. Confirmed; the handoff's claim is accurate and the sibling
  backlog ticket it filed describes the gap correctly.

### Found and fixed in this pass

- **Blank-DDL migrations leaked a remote-event expectation, and this diff made
  that leak harmful.** `packages/quereus-sync/src/sync/store-adapter.ts`. A
  migration with an empty `ddl` (every store schema event except `create_table`)
  decided `execute`, registered `events.expectRemoteSchemaEvent(...)`, then ran
  `db.exec('')` — which emits no module event, so the expectation was never
  consumed. `StoreEventEmitter` refcounts expectations and never expires them
  (`packages/quereus-store/src/common/events.ts`), so the entry lingered and the
  *next genuine local DDL of the same signature* was consumed by it and marked
  `remote: true` — and `sync-manager-impl.ts:666` filters remote events out of
  the local-fact capture, so that local change would never have been recorded and
  never replicated. Silent, permanent one-way schema divergence.

  This is not purely pre-existing. The old string-shape signature derivation
  produced `alter`/`index` for both `add_index` and the `*_column` types — a
  signature the module never emits, so those leaked entries could not match
  anything real. Correcting the map to `create`/`index` and `alter`/`table`
  turned two previously inert leaks into live ones.

  Fix: `applySchemaChange` returns immediately on a blank `ddl` — nothing to run,
  nothing to compare, and crucially nothing to expect. The blank-DDL branch moved
  out of `decideSchemaChange` (which now documents that it is never called with
  one). Regression test added: apply a blank `add_index` and a blank
  `alter_column`, then run the corresponding local DDL and assert both emitted
  events are *not* marked remote. Verified the test fails against the pre-fix
  behavior (temporarily disabled the guard, watched it go red, restored it).
  `docs/sync.md` updated with why the skip is total rather than "exec an empty
  string".

- **`relay` / `relayAll` were near-duplicate bodies.**
  `packages/quereus-sync/test/sync/_peer-harness.ts`. Both now delegate to a
  shared `relayWith(from, to, shape)`; each is a one-liner naming only how it
  shapes the changesets.

### Filed as new tickets

None. The one gap large enough to be its own work — that every schema event
except `create_table` replicates with an empty DDL string, so drops, indexes and
column changes silently do nothing on the receiver — was already filed by the
implement stage as `backlog/bug-sync-schema-migrations-replicate-empty-ddl`. Read
it; it is accurate and plainly written, and no second ticket is warranted.

### Parked as tripwires (conditional — no ticket)

Two were already in place from the implement stage and were checked, not just
inherited:

- `assertDefinitionMatches` docblock — a genuinely divergent concurrent
  `create_table` has no automatic convergence path and keeps aborting until an
  operator intervenes.
- `normalizeDDL` docblock — normalization reaches inside string literals, so two
  definitions differing only in a literal compare equal.

Two more added, both raised as open questions in the handoff and both genuinely
conditional rather than latent defects:

- `decideSchemaChange` docblock — presence is read from the in-memory catalog,
  which is assumed to match storage. True after `rehydrateCatalog`; only matters
  if sync is ever driven against a half-rehydrated catalog.
- `decideSchemaChange`'s `create_table` branch — the both-sides-render-identically
  symmetry is a property of the store module being the only DDL-emitting module.
  A second one rendering differently would false-conflict; the fix then would be
  to compare parsed schemas rather than rendered strings.

### Considered and deliberately left alone

- **The divergent-definition case still aborts and retries forever.** The handoff
  flagged this for judgment. Leaving it is right: the alternative (keep the local
  shape, commit the metadata) records "converged" for a divergence that is not,
  and the failure is loud rather than silent. The error does reach the host as a
  `status:'error'` sync event. Making it more discoverable is a design question
  about host-facing error surfacing generally, not about this fix.
- **`console.debug` for the skip.** `@quereus/sync` has no logger abstraction and
  uses bare `console.warn` elsewhere; introducing one here would be scope creep.
- **Index and column branches have no end-to-end coverage.** They cannot: index
  and column DDL replicates empty today. The synthetic-migration cases are the
  best available proxy and the sibling backlog ticket names re-verifying the full
  path via `relayAll` once real DDL flows.

### Test coverage judgment

The implementer's 14 cases were a genuine starting point rather than a
happy-path-only pass — they already covered both directions, a second round
proving the metadata committed, onward relay to a third peer, divergence, DDL
normalization noise, every drop/index branch, and blank DDL. The one uncovered
interaction was cross-invocation state: what a schema change leaves behind for
the *next* one. That is exactly where the expectation leak lived, and it is now
the 15th case.

## Validation

- `yarn workspace @quereus/sync test` → 511 passing, 0 failing
- `yarn build` → clean
- `yarn typecheck` → clean
- `yarn lint` → clean
- `yarn test` (whole workspace) → 0 failing (7329 + 312 + 104 + 56 + 17 + 28 +
  1076 + 511 + 52 + 31 + 34 + 134 + 22 passing, 13 pending)

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
