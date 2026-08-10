description: Reviewed the new shared network-message-format module that the sync client and server will both use, so the two copies can no longer drift.
files:
  - packages/quereus-sync/src/sync/wire.ts                    # NEW — shared wire module (reviewed; 1 doc fix)
  - packages/quereus-sync/src/index.ts                        # wire exports
  - packages/quereus-sync/test/wire.spec.ts                   # round-trip codec suite (20 tests)
  - packages/quereus-sync-client/src/serialization.ts         # old client codec (reference; unchanged)
  - packages/sync-coordinator/src/common/serialization.ts     # old coordinator codec (reference; unchanged)
  - packages/quereus-sync-client/src/types.ts                 # old client message unions (reference; unchanged)
----

## What landed (implement stage)

New additive module `packages/quereus-sync/src/sync/wire.ts` — single source of truth for
the sync transport/JSON layer sitting on top of the unchanged `protocol.ts` data structures:
cross-platform base64 helpers, HLC transport helpers, typed `Serialized*` shapes, codec
functions (`serializeChangeSet` / `serializeSnapshotChunk` + inverses), the `ClientMessage` /
`ServerMessage` envelope unions, and `PROTOCOL_VERSION = 1`. All re-exported from `index.ts`.
Purely additive: both old codec copies (client + coordinator) and the client's old message
unions still exist and pass, untouched. The cutover that deletes them and enforces the
version handshake is the sibling ticket `sync-protocol-migrate-and-version`.

## Review findings

Reviewed the implement diff (`git show 892f853b`) with fresh eyes against `protocol.ts`, both
old codec copies, and the three source message definitions, then re-ran build + tests.

**Ported-fidelity check (codec) — PASS.** Byte-compared `wire.ts` against the old client
`serialization.ts` and coordinator `common/serialization.ts`:
- ChangeSet codec — identical logic. Present-only encodings preserved exactly: column
  before-image (`priorValue`+`priorHlc` gated together on `priorHlc !== undefined`), delete
  before-image (`priorRow` via conditional spread, empty `[]` stays present vs absent).
- Snapshot-chunk codec — ported from coordinator, now typed (was `unknown`→`object`). Tombstone
  routes bigint-`wallTime` HLC through `serializeHLC` (raw bigint would throw at
  `JSON.stringify`); pass-through chunks (`table-start`/`table-end`/`footer`) carry no binary
  fields and spread cleanly.
- Resolved divergences match the ticket's table: typed signatures, cross-platform base64
  (coordinator's Buffer-only browser bug dropped), lenient `schemaMigrations ?? []` on read.

**Message-envelope superset check — PASS.** Verified `ClientMessage`/`ServerMessage` against
all three sources: client `types.ts:124-233` (base unions), coordinator `websocket.ts:33-65`
(`ClientMessage` incl. `resume_snapshot`) and its senders (`snapshot_chunk`,
`snapshot_complete`, `apply_result`), and the client's `request_changes` handler
(`sync-client.ts:324`, exercised by `sync-client.spec.ts:1041`). The shared unions are a true
superset; field names/optionality align. `request_changes` has no coordinator sender in-repo
but the client accepts it (peer-relay), so its inclusion is correct.

**Test coverage — adequate floor.** 20 wire tests cover both prior-image branches, empty-vs-
absent arrays, lenient `schemaMigrations`, blob `SqlValue` round-trip, HLC transport, base64
under *both* environments (Buffer fallback force-exercised), and every `SnapshotChunk` variant
incl. the tombstone bigint→string + `JSON.stringify`-doesn't-throw assertion. Gaps below are
acknowledged and correctly deferred.

**Minor — FIXED inline.** `wire.ts` header comment (lines 17-20) claimed the module imports
"only from `protocol.ts`, the clock, the metadata codec, and `@quereus/quereus`" but also
imports `SnapshotCheckpoint` from `./manager.js` (line 44). Reworded to list `manager.ts` and
frame the constraint as intra-package (the anti-cycle rule is about not importing
`sync-client`/`sync-coordinator`, which still holds). Docs-reflect-reality is this ticket's
own bar; fixed.

**Major — NEW TICKET filed.** `backlog/debt-sync-resume-snapshot-checkpoint-jsonsafe.md`.
`ResumeSnapshotMessage.checkpoint` is typed `SnapshotCheckpoint`, which holds a raw
`Uint8Array` siteId and a bigint-`wallTime` HLC. `JSON.stringify` of it **throws**, and
`JSON.parse` would not restore the `Uint8Array` — the message cannot travel the wire. It is a
real latent defect (not a tripwire: definitely broken the moment the path runs), but **dormant**
— no client sends `resume_snapshot` today — and **pre-existing** (the coordinator already
declared it this way; `wire.ts` faithfully copied the shape). Filed as `debt-` per the
dormant-latent-defect rule. Independent of the cutover ticket (which does not touch checkpoint
JSON-safety and leaves the defect unchanged).

**Tripwires — recorded, no ticket.**
- Large-blob base64: `bytesToBase64` uses `String.fromCharCode(...bytes)`, which can exceed the
  JS arg-count limit on a very large blob. Already parked as a `NOTE:` at the call site
  (`wire.ts` `bytesToBase64`) by the implementer; fine for HLCs / typical cell blobs. Left as-is.
- No structural validation on deserialize: the codec trusts the `Serialized*` shape (only
  `schemaMigrations` is lenient); a malformed peer can still throw deep in a `.map`. This is
  architectural and intentional — the `PROTOCOL_VERSION` handshake (cutover ticket) is the
  designed guard against real drift; deep per-field validation is deliberately out of scope.
  Recorded here; no code site warrants a new comment beyond the existing lenient-read note.

**Type-only floor (acknowledged, not a finding).** The envelope unions are exercised only by
`tsc`, not a runtime test — no consumer emits/parses them until the cutover ticket, which adds
the client+coordinator handshake tests. Correct deferral.

**Not reviewed / out of scope.** `test:store` and full `yarn lint` (only `packages/quereus` has
a real lint; the sync packages are `echo` no-ops). Not relevant to this additive module.

## Validation

- `yarn workspace @quereus/sync build` — clean (strict tsc).
- `yarn workspace @quereus/sync test` — **470 passing** (incl. 20 wire tests). Console noise is
  expected error-path test output, not failures.
- `yarn workspace @quereus/sync-client build` and `@quereus/sync-coordinator build` — both clean:
  confirms no circular dependency and the additive exports break nothing.

## Follow-on work

- `sync-protocol-migrate-and-version` (implement/) — the cutover: delete both old codec copies +
  client message unions, repoint to `@quereus/sync`, add the `protocolVersion` handshake.
- `debt-sync-resume-snapshot-checkpoint-jsonsafe` (backlog/) — make the resume-snapshot
  checkpoint JSON-safe before any client resume path is wired.
