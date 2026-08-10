description: The sync client no longer puts the auth token in the WebSocket URL's query string (where proxies and server logs routinely record it); the token now travels only in the handshake message body, which the coordinator already reads.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # connect() ~186: `this.ws = new WebSocket(url)` (dropped `wsUrl` query-string construction)
  - packages/quereus-sync-client/test/sync-client.spec.ts   # ~380 renamed test asserts URL has no token AND handshake body carries it
difficulty: easy
----

## What shipped

`SyncClient.connect` (`sync-client.ts:186`) dropped the token-in-URL construction
(`${url}?token=${encodeURIComponent(token)}`) in favour of a plain
`this.ws = new WebSocket(url)`. The token now travels only in the `handshake`
message body, sent on `onopen` via `sendHandshake(databaseId, token)`
(`sync-client.ts:190`). This closes a credential-in-URL exposure — query strings
are logged by proxies, load balancers, and access logs.

Test at `sync-client.spec.ts:380` renamed to
"should not include token in URL, sending it in the handshake body instead":
asserts `ws.url` lacks `token=my-token` **and** the sent `handshake` message's
`.token` equals `'my-token'`.

## Review findings

Adversarial pass over commit `5a5ac911`. Change is a 1-line drop plus its test
inversion — small surface, verified end-to-end by reading both sides of the
auth path.

**Correctness / security (the core claim) — verified, no findings.**
- Server-side WS auth reads the token from the handshake **message body**, never
  the URL. `handleHandshake` builds `authContext.token` from `msg.token`
  (`packages/sync-coordinator/src/server/websocket.ts:143`) and
  `CoordinatorService.authenticate` reads only `context.token` / `context.siteId`
  / `context.siteIdRaw` (`coordinator-service.ts:216-244`) — never
  `request.query`.
- The only `request.query` reader in the coordinator is `sinceHLC` on the REST
  `GET /:databaseId/changes` route (`server/routes.ts:97`) — unrelated to auth.
  No `query.token` reader exists anywhere in `packages/sync-coordinator/`.
- So dropping the query string removes redundant data; nothing server-side
  regresses. No pre-handshake credential is needed at WS-upgrade time (auth is
  post-open on the handshake message), so no `Authorization`-header substitute is
  required (and a browser `WebSocket` couldn't set one anyway).

**Reconnect path — verified.** Reconnect reuses the stored `connectionToken`
(`sync-client.ts:726` → `connect(url, databaseId, connectionToken)`), which flows
back into `sendHandshake`. Token survives reconnects; no query string involved.

**Tests — pass.** `yarn workspace @quereus/sync-client test` → **52 passing**,
0 failing. `build` (tsc) clean. Lint for this package is the repo's intentional
`echo 'No lint configured'` no-op — not a real check, as the implement handoff
noted. The renamed test correctly asserts both the negative (no token in URL) and
the positive (token in handshake body), so it can't silently pass if a future
edit reintroduces the query string.

**Docs — already accurate, no update needed.** `docs/sync.md:908` documents the
`handshake` message as carrying `{ siteId, token?, protocolVersion }`, and the
connection-lifecycle diagram (`sync.md:976`) shows `onopen → send handshake`.
Neither the docs nor `packages/quereus-sync-client/README.md` ever claimed the
token rode in the URL, so the change leaves them consistent. (Confirmed by a
repo-wide `token=` / `query string` grep: only the ticket files and the accurate
handshake-body doc lines matched.)

**Minor nit (not fixed — cosmetic, no code impact).** The implement handoff cited
the coordinator handshake handler as `packages/sync-coordinator/src/service/websocket.ts`;
the actual path is `packages/sync-coordinator/src/server/websocket.ts` (it's in
`server/`, not `service/`). The handoff's `:110`/`:143` line references and its
reasoning are otherwise correct. No code or doc consequence.

**Tripwire — custom auth hooks.** `service.authenticate` also passes `request`
into `AuthContext`, so a consumer-supplied `onAuthenticate` hook
(`coordinator-service.ts:232`) *could* have read `request.query.token`. No
first-party code does; the default and token-whitelist paths read only
`context.token`. If a downstream consumer ever relied on the query-string token
via a custom hook, they must switch to `context.token` (same value, delivered via
handshake body). This is conditional on an undocumented external usage that was
not found — recorded here as knowledge, not filed as a ticket. Not annotated in
code because the hook interface already exposes `context.token` as the intended
source; adding a NOTE at the `request` pass-through site would gesture at a
consumer path that doesn't exist in-repo.

**External consumers (out of repo).** Cannot grep outside this monorepo; any
external caller that parsed the token back out of `ws.url` would see it gone. This
is the intended behavior change (credentials out of URLs), flagged for release
notes rather than as a defect.

## Disposition

No major findings; no new tickets filed. One cosmetic path nit in the prior
handoff (noted above, not fixed — nothing to change in code). One tripwire
recorded (custom auth hooks). Change is correct, minimal, tested, and
documentation already reflects it.
