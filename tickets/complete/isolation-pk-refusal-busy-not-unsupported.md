description: The transaction-isolation layer's refusal to change a table's primary key while a transaction has unsaved rows now reaches the application as a retryable error instead of being swallowed and replaced by a fallback that would lose those rows.
files:
  - packages/quereus-isolation/src/isolation-module.ts      # ~1339-1349 — refusal is StatusCode.BUSY + NOTE tripwire
  - packages/quereus-isolation/test/isolation-layer.spec.ts # ~6478 direct-call unit test asserts BUSY
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts # ~703-737 SQL-level regression
  - packages/quereus-isolation/README.md                    # ~143
  - docs/design-isolation-layer.md                          # ~873
difficulty: easy
---

# Outcome

`IsolationModule.alterTable` refuses `ALTER TABLE ... ALTER PRIMARY KEY` when the issuing
connection's own overlay has staged rows. That refusal now carries `StatusCode.BUSY` instead of
`StatusCode.UNSUPPORTED`.

`UNSUPPORTED` from `alterTable` is the engine's signal for "this module can't re-key in place — use
the generic shadow-table rebuild" (`runAlterPrimaryKey`, `packages/quereus/src/runtime/emit/alter-table.ts`
~1501). That rebuild copies **committed** rows only, so routing this refusal through it discards the
issuer's staged writes — the failure mode `docs/module-authoring.md` § `alterPrimaryKey` documents and
forbids. `BUSY` is not in the engine's fallback trigger (the catch tests `=== StatusCode.UNSUPPORTED`
and rethrows everything else), so it propagates to the caller with the message that already names the
remedy ("commit or roll back first").

Unchanged, deliberately: the genuine capability refusal ~50 lines earlier ("Underlying module does not
support ALTER TABLE") stays `UNSUPPORTED` — that one really does mean "use the fallback". The
`underlying's UNSUPPORTED propagates` test likewise stays as-is (a stub *underlying* refusing, forwarded).

Docs: README and `docs/design-isolation-layer.md` name `BUSY` and say why. `docs/module-authoring.md`
already prescribed exactly this ("refuse with a non-`UNSUPPORTED` error — `BUSY` reads best") from the
companion ticket, so it needed no edit.

# Review findings

**Checked:** the implement diff read before the handoff; the engine's `runAlterPrimaryKey` catch and both
post-native refusals; the isolation `alterTable` prologue (overlay partition, poison skip, refusal
placement); test helpers and imports in the new SQL-level test; every doc mention of `UNSUPPORTED`/`BUSY`
in the isolation README, `docs/design-isolation-layer.md`, and `docs/module-authoring.md` §
`alterPrimaryKey`. Ran the full workspace test suite (`yarn test`, all green, 4m29s), the isolation
package alone (350 passing), `yarn lint` (green; only `packages/quereus` has a real lint), and
`@quereus/isolation typecheck` (green, covers the spec files).

**Minor — fixed in this pass:** the new test's comment claimed the surviving-committed-row assertion is
what catches a regression to `UNSUPPORTED`. It isn't, and I verified that empirically: with the fix
temporarily reverted, the statement fails with `ERROR` (code 1), not data loss — the companion ticket's
`isExplicitTransactionOpen` guard refuses the rebuild before it can run. The **status-code** assertion is
the discriminator; the row/PK assertions pin the rest of the contract. Comment corrected to say so and to
name the guard. No code or assertion change — the test does catch the regression, just not by the
mechanism its comment described.

**Resolved from the handoff's "known gaps":** the question of whether the companion guard now fully
shadows this refusal. It does not. Both fire, on different codes, from different places: this one before
`underlying.alterTable` with a specific, retryable diagnosis; the engine guard afterwards, generically,
for any module. The engine guard also cannot substitute — it only runs when the fallback is reached, and
`docs/module-authoring.md` states outright that it "does not remove a module's own obligation to refuse
with `BUSY`". Defense in depth, as the original ticket claimed.

**Major (new tickets):** none. The change is one status code plus tests and prose; no design, cleanup, or
coverage gap large enough to warrant its own ticket surfaced.

**Tripwire (parked, not ticketed):** an already-*poisoned* own overlay is skipped during the overlay
partition, so `ownEntry` is undefined and this refusal never fires for it — the `ALTER PRIMARY KEY` then
forwards while the poisoned overlay still holds rows keyed by the retired key. Harmless today because
poison is terminal: rollback is the only exit and it discards those rows. Parked as a `NOTE:` at the check
itself (`isolation-module.ts` ~1345) saying the check must consult the poisoned own overlay if poison ever
becomes recoverable.

**Not found / explicitly clear:** no stale `UNSUPPORTED` prose left for this refusal anywhere in the repo
(grepped both the message text and every `UNSUPPORTED`/`BUSY` mention in the three relevant docs). No
resource-cleanup, type-safety, DRY, or file-size concerns — the diff adds one changed enum member, one
comment block, and one test; nothing grew a new abstraction or a new code path.
