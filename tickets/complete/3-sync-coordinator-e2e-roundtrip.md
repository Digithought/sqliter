description: A new end-to-end test connects two real sync clients through a live coordinator server and checks that a write on one client shows up on the other, so protocol mismatches between client and coordinator get caught.
prereq:
files:
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts (round-trip spec — now 4 tests)
  - packages/sync-coordinator/test/_e2e-harness.ts (boots coordinator on ephemeral port + builds real-engine client peers)
  - packages/sync-coordinator/package.json (@quereus/sync-client devDependency)
difficulty: medium
----

## What shipped

Integration spec + harness in `packages/sync-coordinator/test/` that boots the
real coordinator HTTP+WebSocket server on an ephemeral port and connects two
real-engine `SyncClient`s over `ws://127.0.0.1:<port>/sync/ws`. The only path
from peer A's engine to peer B's is through the coordinator socket (separate KV
stores), so it genuinely exercises `SyncClient` → `apply_changes` →
`CoordinatorService.applyChanges` → `broadcastChanges` (`push_changes`) →
`SyncClient.handleChanges` → store.

Tests (4):
1. **A→B** insert arrives on B (row fidelity: `note` text + `qty` int).
2. **B→A** reverse.
3. **cross-replication** of concurrent writes on both.
4. **update + delete A→B** (added in review — see below).

Validation: `yarn workspace @quereus/sync-coordinator test` → **117 passing**
(was 116 at implement handoff; +1 from the review-added test), clean exit, no
leaked-handle hang. `npx tsc -p tsconfig.test.json --noEmit` → clean.

## Review findings

Adversarial pass over the implement diff (`8009ef9a`). Verdict: solid,
well-documented test. One code addition, one new backlog ticket, no blockers.

**Checked — API correctness.** Verified every published-API call in the harness
against real exports: `createCoordinatorServer`/`CoordinatorServer` (server.ts),
`DEFAULT_CONFIG.basePath = '/sync'` → url `/sync/ws` matches the websocket route
(`websocket.ts:46` registers `${basePath}/ws`), `createSyncModule(kv, options)`
current 2-arg signature (harness uses it correctly; note the package READMEs
still show the stale 3-arg `createSyncModule(kv, storeEvents, {...})` form —
pre-existing doc drift, not introduced here, left for a docs pass),
`createStoreAdapter({db, storeModule, events})`, `KVStoreProvider` shape. All
correct. Typecheck via `tsconfig.test.json` is clean — this matters because the
test runner uses node type-stripping (no type-check at run time), so the tsc
pass is the only type gate.

**Checked — test is real, not pass-by-construction.** `waitFor` throws on
timeout (3 s bound, 25 ms poll) → the test fails if the row never arrives; value
assertions fail on any codec skew. Confirmed.

**Checked — the implementer's open question, and answered it.** Handoff asked:
"when a `get_changes` reply batches a `create_table` changeset *and* a DML
changeset into one `applyChanges`, does the create_table throw abort the whole
batch and drop the DML?" Read `store-adapter.ts`: schema changes (loop ~line
175) and data changes (loop ~line 197) apply in **separate** loops; a schema
throw is isolated to `result.errors` and does **not** stop the DML loop. Answer:
**no, co-batched DML is not dropped.** Recorded this in the new bug ticket so
it is not re-derived.

**Found (major) — non-idempotent `create_table` replication → filed
`tickets/backlog/bug-sync-create-table-replication-not-idempotent.md`.** The
implement handoff flagged the `Table main.orders already exists` spam. Traced it:
`applySchemaChange` runs `db.exec(ddl)` raw and throws when the table exists;
`change-applicator.ts`'s HLC-domination gate only stops a *dominated* create, so
two independent offline creates (different site IDs, neither dominates) both hit
the raw exec and throw. Reachable in normal offline-first use. Data-safe (see
above) but noisy and leaves the schema change's CRDT metadata un-committed →
re-sends without converging. Lives in `@quereus/sync`, out of scope for this
test-only ticket, so filed rather than fixed here.

**Fixed inline (minor) — codec coverage floor was insert-only.** Added test #4:
insert row 30 → assert on B, then `update` (column change) → assert propagated,
then `delete` → assert gone on B. Insert only exercises the upsert-of-fresh-row
codec; update and delete (tombstone) are distinct wire ops a codec skew could
break independently. Now covered A→B.

**Observations (no action — documented gaps, correct scoping).**
- *Schema-change wire codec is not e2e-covered.* The harness pre-seeds the base
  table before wiring sync capture so bootstrap DDL never replicates — a
  deliberate scoping choice (keeps the test on the DML path, sidesteps the
  create_table bug above without papering over it), not a defect. Schema-change
  round-trip is a natural follow-up once the backlog bug lands.
- *Auth happy-path only* (`auth.mode: 'none'`), *no reconnect-mid-stream*,
  *no multi-row fidelity* — all explicitly out of the ticket's scope; reasonable
  next layers.
- *Sync-metadata `InMemoryKVStore` (the `createSyncModule` kv) is not closed in
  `ClientPeer.close()`.* Harmless — `InMemoryKVStore` holds no OS handle (tests
  exit clean, no leaked-handle hang) and the instance is created inline with no
  retained reference to close. Not worth capturing a handle for; noted, not
  actioned.

**Tripwire (timing).** The spec's liveness knobs — `localChangeDebounceMs: 10`,
a 50 ms post-connect settle before the first write, `waitFor` 3 s / 25 ms — are
generous for in-memory engines but are the first thing to widen if this ever
flakes under heavy CI parallelism. No fixed `setTimeout` gates a *correctness*
assertion (only the settle-before-write liveness guard), so a flake would be a
liveness bound, not a false pass. Parked as this note (findings is the index);
the bound values live in the spec's beforeEach where a future reader meets them.

**Empty categories.** No security surface (test-only, loopback socket, auth
none). No performance concern (in-memory, ephemeral port). No docs required —
this ticket adds tests only and touches no user-facing behavior; the stale
`createSyncModule` README signature noted above pre-dates this work.
