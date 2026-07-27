description: Two devices that each created the same table offline could never finish syncing with each other; replicated table and index changes are now applied only when they are not already in place, so the two sides converge instead of failing forever.
prereq:
files:
  - packages/quereus-sync/src/sync/store-adapter.ts (the fix: `decideSchemaChange`, `normalizeDDL`, `findIndexOwner`, `assertDefinitionMatches`, `schemaEventSignature`)
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts (new spec, 14 cases)
  - packages/quereus-sync/test/sync/_peer-harness.ts (new `relayAll`; documented why `relay` strips migrations)
  - docs/sync.md (§ Schema Synchronization → new "Idempotent DDL application")
  - tickets/backlog/bug-sync-schema-migrations-replicate-empty-ddl.md (newly filed; see below)
difficulty: medium
----

## What was wrong

Two peers that each ran `create table orders` while offline both recorded a
`create_table` migration. On sync, the migration with the higher HLC is admitted
at the peer that *already has* the table, and `applySchemaChange` re-ran the raw
DDL there — which throws "Table main.orders already exists".

That throw is collected into `ApplyToStoreResult.errors`, and any non-empty
`errors` aborts the whole admission unit before its CRDT metadata commits. So the
receiver's rows landed in storage with **no** column-version / tombstone records,
its peer watermark never advanced, and it re-applied and re-failed the identical
batch on every subsequent sync. Permanent non-convergence, not just log noise.

## What changed

**`store-adapter.ts` — `applySchemaChange` now decides before it acts.** A new
`decideSchemaChange` runs *before* `events.expectRemoteSchemaEvent` (registering
an expectation for DDL that is then not executed would linger and mis-mark a
later genuine *local* DDL as remote) and returns one of:

- `execute` — object absent for a create, present for a drop: unchanged behavior.
- `already-applied` — object already in the wanted state and its definition
  matches: log at debug, execute nothing, return. The caller still counts it
  applied, so the migration metadata commits and the change stops being re-sent.
- (throw) — object exists with a *different* definition: an error naming the
  object and printing both definitions.

Covers `create_table`, `drop_table`, `add_index`, `drop_index`. Column-level
migrations fall through to `execute` unchanged. A blank `ddl` short-circuits to
`execute` (an empty `db.exec('')`, exactly as before) — see the filed sibling
ticket.

"Definition matches" regenerates the local canonical DDL (`generateTableDDL` /
`generateIndexDDL`, no `db` argument — the same call the origin used) and
compares under `normalizeDDL`: strip trailing `;`, collapse whitespace, trim,
lowercase.

**Adjacent fix, in the same function — `schemaEventSignature`.** The old code
derived the module-event signature by string shape:
`change.type.startsWith('drop') ? 'drop' : startsWith('create') ? 'create' : 'alter'`
and `change.type.includes('table') ? 'table' : 'index'`. That is wrong for
`add_index` (→ `alter`/`index`, but the module emits `create`/`index`) and for
every `*_column` type (→ `alter`/**`index`**, should be `alter`/`table`). A
signature that never matches means the pre-marking fails, so the receiver records
the replicated DDL as its **own local** migration and broadcasts it back out — an
echo loop. Replaced with an explicit map that is the exact inverse of
`mapSchemaMigrationType` in `sync-manager-impl.ts`. Dormant today (those
migrations carry no DDL so nothing executes), but it is in the same function and
directly serves "be correct the moment real DDL flows", which the source ticket
asked for.

**Harness.** Added `relayAll` to `_peer-harness.ts` — same as `relay` but keeps
`schemaMigrations`, so replicated DDL actually reaches `applyToStore`. Documented
on `relay` why it strips (both peers already ran the DDL; the data-focused specs
care about row convergence).

## How to exercise it

`yarn workspace @quereus/sync test` — the new spec is
`test/sync/schema-replication-idempotency.spec.ts` (14 cases, two layers):

**End-to-end, two real engines, via `relayAll`:**

- *identical table created offline on both peers* — each inserts a row, relay
  both directions **twice**. No throw in any direction or round; both rows on
  both peers; round 2 reports `applied === 0` in both directions (proving the
  migration metadata committed and the duplicate stopped being re-sent). This is
  the ticket's repro; it threw before the fix.
- *the receiver can relay onward* — after `b → a`, a third peer `c` pulls from
  `a` and gets **both** rows. This is the check that the metadata actually
  committed: under the old abort, `a` held `b`'s row with no column versions and
  could not forward it.
- *divergent definitions* (`orders` with an extra column on one peer) — the relay
  surfaces an error naming `main.orders`, the migration type, and both
  definitions.

`makeDivergedPair` creates peer `a`'s table first with a 25 ms settle before
peer `b`'s, so `b`'s migration always carries the strictly greater HLC. Without
that the failure direction depends on a same-millisecond siteId tiebreak and the
test would be flaky.

**Adapter-level, synthetic `SchemaChangeToApply` records** (needed because only
`create_table` carries real DDL on the wire today, so the drop/index branches
have no end-to-end driver): create for an absent table executes; matching
duplicate create converges with **zero** module events emitted; normalization
tolerates whitespace/trailing-`;`/casing noise; divergent create reports a
conflict; `drop_table` for an absent table counts applied without executing;
`drop_table` for a present table executes and emits `drop`/`table`/`remote:true`;
`add_index` for an absent index executes and emits **`create`/`index`**/
`remote:true` (this is the signature-mapping fix); matching duplicate `add_index`
converges silently; divergent `add_index` conflicts; `drop_index` absent → no-op,
present → executes; blank-DDL migrations still behave as the no-ops they are.

## Validation run

- `yarn workspace @quereus/sync test` → 510 passing, 0 failing
- `yarn build` → clean
- `yarn test` (whole workspace) → all suites green, 0 failing (7329 + 312 + 104 +
  56 + 17 + 28 + 1076 + 510 + 52 + 31 + 34 + 134 + 22 passing, 13 pending)
- `yarn lint` → clean

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known gaps — please poke at these

- **The divergent-definition case still aborts and retries forever.** That is the
  deliberate choice (recorded as a `NOTE:` tripwire on `assertDefinitionMatches`
  in `store-adapter.ts`): silently keeping the local shape and committing the
  metadata would record "converged" for a divergence that is not. But it means an
  operator has to intervene, and *nothing surfaces the error to a host other than
  the existing `status:'error'` sync event*. Whether that is discoverable enough
  in a real deployment is worth a reviewer's judgment.
- **`normalizeDDL` reaches inside string literals.** Collapsing whitespace and
  lowercasing means `default 'a  b'` and `default 'a b'`, or `default 'X'` and
  `default 'x'`, compare equal — so a duplicate create differing *only* in a
  literal is treated as converged. `NOTE:`-tagged at the site. Harmless for the
  shapes canonical DDL emits today; a stricter check would compare parsed schemas
  rather than rendered strings.
- **The `create_table` comparison assumes both sides render through
  `generateTableDDL` with no `db` argument.** Verified true for the store module
  path. A peer whose table was created through a *different* module that emits
  DDL some other way would be reported as a false conflict rather than
  converging. Not exercised by any test — there is no second DDL-emitting module
  to test against.
- **Index branches have no end-to-end coverage**, only synthetic-migration
  coverage, because index DDL replicates empty today. The synthetic tests hand
  `applySchemaChange` real `CREATE INDEX` text, which is the best available
  proxy, but the wire shape those branches will actually see is unverified.
- **`schemaEventSignature` for column migrations is untested.** `add_column` /
  `drop_column` / `alter_column` now map to `alter`/`table`, matching
  `mapSchemaMigrationType`'s `'table' alter → alter_column` direction. Nothing
  drives it (blank DDL), so this is reasoned-correct, not demonstrated.
- **`decideSchemaChange` reads the schema manager, not storage.** It trusts
  `db.schemaManager` to reflect what is actually persisted. If a table exists in
  storage but is absent from the in-memory catalog (mid-rehydration, say), the
  decision is `execute` and the underlying `already exists` throw returns. No
  test covers that window.
- **`console.debug` for the skip.** `@quereus/sync` has no logger abstraction
  (it uses bare `console.warn` elsewhere), so this follows local convention
  rather than introducing one. It fires once per duplicate migration per sync.

## Review findings input

- Filed `tickets/backlog/bug-sync-schema-migrations-replicate-empty-ddl.md`. The
  source ticket said this gap was "tracked separately as
  `sync-schema-migrations-replicate-empty-ddl`", but no such ticket file existed
  anywhere in `tickets/` — the fix-stage agent named it without creating it. The
  code comment in `decideSchemaChange` now points at the real slug.
- Tripwire parked at `packages/quereus-sync/src/sync/store-adapter.ts`
  (`assertDefinitionMatches` docblock): divergent concurrent `create_table` has
  no automatic convergence path; the fix would be last-writer-wins over schema
  definitions.
- Tripwire parked at `packages/quereus-sync/src/sync/store-adapter.ts`
  (`normalizeDDL` docblock): normalization is literal-insensitive.
