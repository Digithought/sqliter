description: The sync client and server now share one copy of their network message format instead of two drifting copies, and they exchange and check a version number when connecting so a mismatched pair fails loudly at connect time instead of silently misbehaving.
files:
  - packages/quereus-sync/src/sync/wire.ts                   # single source of truth: codec + Serialized* + message unions + PROTOCOL_VERSION
  - packages/quereus-sync/test/wire.spec.ts                  # canonical codec suite; +4 HLC transport boundary cases (restored on review)
  - packages/quereus-sync-client/src/serialization.ts        # DELETED (codec moved to @quereus/sync)
  - packages/quereus-sync-client/src/types.ts                # stripped message/Serialized* types; kept SyncStatus/SyncEvent*/SyncClientOptions
  - packages/quereus-sync-client/src/index.ts                # codec + wire types re-exported from @quereus/sync (public API unchanged)
  - packages/quereus-sync-client/src/sync-client.ts          # shared codec import; sendHandshake stamps protocolVersion; handleHandshakeAck checks it
  - packages/sync-coordinator/src/common/serialization.ts    # DELETED
  - packages/sync-coordinator/src/common/index.ts            # re-exports codec from @quereus/sync
  - packages/sync-coordinator/src/server/websocket.ts        # shared unions; handleHandshake rejects bad/absent version before auth; ack echoes it
  - packages/sync-coordinator/src/server/routes.ts           # repointed import + cast at HTTP JSON boundary; NOTE tripwire on HTTP version gap (review)
  - packages/sync-coordinator/src/service/coordinator-service.ts  # cast at S3 batch-replay boundary
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts    # cast at S3 snapshot boundary
  - packages/quereus-sync-client/test/sync-client.spec.ts    # version tests; handshake helpers stamp version
  - packages/sync-coordinator/test/websocket.spec.ts         # version tests; existing handshakes stamp version
  - docs/sync.md                                             # protocol-version section; ASCII flow-diagram alignment fixed (review)
  - docs/sync-coordinator.md
----

## What shipped

Cut both sync packages over to the shared wire module from the prereq ticket
(`@quereus/sync` → `src/sync/wire.ts`), deleted both local copies of the wire
codec plus the client's local message-type declarations, and added a
`protocolVersion` handshake so a client and coordinator built against different
wire versions detect the mismatch at connect time.

There is now **exactly one** wire codec and **one** set of message/`Serialized*`
types, both in `@quereus/sync`. The client and coordinator import them; their
public surfaces are unchanged (the client re-exports the same names from its
`index.ts`, the coordinator from `common/index.ts`).

`PROTOCOL_VERSION` is `1` — no bump. This ticket establishes the field and the
check; it does not change any message payload shape beyond adding the version
field itself.

### Version semantics (strict integer equality)

- **Client → coordinator:** `sendHandshake` stamps `protocolVersion`. The
  coordinator's `handleHandshake` checks it **first** — before the
  `ALREADY_AUTHENTICATED` session guard and before authenticating — so a
  mismatched peer is rejected without touching the store. Absent or
  `!== PROTOCOL_VERSION` ⇒ `sendError('PROTOCOL_VERSION_MISMATCH', …, fatal)` and
  `socket.close(4003, …)`.
- **Coordinator → client:** `handshake_ack` echoes `protocolVersion`. The client's
  `handleHandshakeAck` checks it first; on mismatch/absence it sets a lasting
  `error` status, flips `stopReconnect` (auto-reconnect does **not** resume),
  rejects the pending `connect()`, and closes/detaches the socket.
- A versionless (pre-versioning) peer is treated as **incompatible** in both
  directions — silent drift is exactly what this guards against.

## Review findings

Read the implement diff (`41b6ef67`) fresh before the handoff. The core change is
sound: a genuine DRY win (one codec, one type set), the version gate is in the
right place (before auth / before store access on the server; before any post-ack
work on the client), strict-equality semantics are consistent, and absent-version
is correctly treated as a mismatch in both directions. Builds clean in order;
tests green (sync 470→**474**, client 52, coordinator 113); test-file type-checks
(`tsconfig.test.json`) clean for all three packages. Sync packages carry no real
lint (no-op `echo`); type safety was verified via the builds + the test-tsc pass.
The only package with a real lint (`packages/quereus`) is untouched by this ticket.

**Checked, aspect by aspect:**

- **DRY / single-source-of-truth** — confirmed: no lingering imports of the two
  deleted `serialization.ts` files anywhere; `ServerMessage`/`ClientMessage` and
  all `Serialized*` types resolve to `wire.ts` and are re-exported unchanged.
- **Type safety at boundaries** — the three out-of-scope coordinator casts
  (`routes.ts`, `coordinator-service.ts`, `s3-snapshot-store.ts`) feed untrusted
  JSON into the now-strictly-typed codec via `as Serialized*`. No regression: the
  old local codecs took `unknown` and cast internally, so malformed input degrades
  identically. Accepted.
- **Error handling / resource cleanup** — client fatal path detaches handlers,
  closes the socket, nulls `this.ws`, and settles `connect()`; server closes with
  4003. Both directions unit-tested.
- **Docs** — content is accurate and complete (new "Protocol version" section in
  `sync.md`, updated handshake tables in both docs).

**Found and fixed inline (minor):**

- **`docs/sync.md` ASCII flow diagram broke.** The two handshake lines grew past
  the box width, pushing the SERVER column and right border out of alignment
  (ragged `│        │` tails). Re-fit both lines (abbreviated the payloads with
  `…`; full payloads remain in the tables directly below). Now box-aligned.
- **Lost test coverage: HLC transport boundary cases.** The deleted client
  `serialization.spec.ts` had an "HLC edge cases" block round-tripping the
  transport codec at counter 0, max counter 65535, wallTime 0, and a large
  wallTime. `wire.spec.ts` had only one generic HLC transport test, and the
  handoff's claim that "HLC edge values live in `clock/hlc.spec.ts`" is inaccurate
  — that spec covers `serializeHLC`/`deserializeHLC` and JSON, but **not** the
  transport helpers at those packing boundaries. Restored the four boundary cases
  in `wire.spec.ts` (the codec's new home). Now 474 passing.
- **Misleading comment in `routes.ts`.** The new comment claimed HTTP drift "is
  caught by the version handshake" — but the REST endpoints run no handshake, so
  a purely-HTTP client is never version-checked. Corrected the comment.

**Tripwire (recorded, not filed):**

- **HTTP REST endpoints carry no protocol-version negotiation.** `POST
  /:databaseId/changes` (and the other REST routes) reuse the shared codec but
  never exchange or check `protocolVersion`, so a REST-only client on a drifted
  version would misbehave silently — the WS gate does not cover them. This is
  pre-existing (HTTP was versionless before and after) and dormant while all
  first-party clients sync over WebSocket, which *is* gated. Parked as a `NOTE:`
  comment at the `POST /changes` site describing the fix (add a header or body
  version field) if a REST-only client ever ships. Not a ticket.

**Coverage gap (acknowledged, not filed):**

- **No true end-to-end version-mismatch test.** The two halves are unit-tested
  separately (client vs `MockWebSocket`; coordinator vs a real `ws` client sending
  raw JSON). A live `SyncClient` against a live coordinator with deliberately
  mismatched versions is not covered. The check is trivial integer equality and
  both halves are solidly tested, so a dedicated integration harness is not worth
  a ticket. Noted for the record.

**No major findings** — no new `fix/`, `plan/`, or `backlog/` tickets spawned.
