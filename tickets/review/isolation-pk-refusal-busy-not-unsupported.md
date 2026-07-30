description: The transaction-isolation layer's refusal to change a table's primary key while a transaction has unsaved rows now reaches the application as a retryable error instead of being silently swallowed and replaced with a lossy fallback.
files:
  - packages/quereus-isolation/src/isolation-module.ts      # ~1338-1352 — the refusal, now StatusCode.BUSY
  - packages/quereus-isolation/test/isolation-layer.spec.ts # ~6471 'rejects the issuer up front...' — asserts BUSY
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts # new SQL-level regression, end of 'ALTER over staged overlay rows (isolation layer)' describe (~702)
  - packages/quereus-isolation/README.md                    # ~143 — now names BUSY
  - docs/design-isolation-layer.md                          # ~873 § "ALTER PRIMARY KEY..." — now names BUSY
difficulty: easy
---

# What changed

`IsolationModule.alterTable` (`isolation-module.ts` ~1338) raised `StatusCode.UNSUPPORTED` when the
issuing connection's transaction has staged rows and the statement is `ALTER TABLE ... ALTER PRIMARY
KEY`. `UNSUPPORTED` is the engine's signal for "this backend can't re-key in place, use the generic
shadow-table rebuild fallback" (`runAlterPrimaryKey` in `packages/quereus/src/runtime/emit/alter-table.ts`,
the `catch` around `module.alterTable` at ~1501). That fallback copies **committed** rows only, so
routing this refusal through it would silently drop the issuer's staged writes — exactly the failure
mode `docs/module-authoring.md` § `alterPrimaryKey` already documents and forbids.

The fix is a one-line code change: `StatusCode.UNSUPPORTED` → `StatusCode.BUSY` at that call site, plus
a comment explaining why (cites `docs/module-authoring.md`). `BUSY` is not caught by the engine's
`UNSUPPORTED`-only fallback trigger (`e.code === StatusCode.UNSUPPORTED` at alter-table.ts ~1502), so it
propagates straight to the caller — retryable, with the existing message that already names the remedy
("commit or roll back first").

**Unchanged, deliberately:**
- The genuine capability refusal ~50 lines earlier (`isolation-module.ts` ~1291, "Underlying module does
  not support ALTER TABLE for '…'") — still `UNSUPPORTED`, since that one really is "use the fallback".
- The `an underlying's UNSUPPORTED propagates with every overlay untouched` test (~6517 in
  `isolation-layer.spec.ts`) — a stub *underlying* refusing `UNSUPPORTED`, forwarded unchanged. Left
  untouched per the ticket; still passes.

# What to verify

- **Direct-call unit test** (`isolation-layer.spec.ts` ~6471, `iso.alterTable(dbA, ...)` directly): now
  asserts `StatusCode.BUSY`. Surrounding assertions (underlying never mutated, issuer overlay intact and
  unpoisoned, `hasChanges` still `true`) are unchanged — worth confirming they still make sense paired
  with `BUSY` (they do; they're about side effects, not the code).
- **New SQL-level regression** (`alter-table-conformance.spec.ts`, end of the `ALTER over staged overlay
  rows (isolation layer)` describe block, right before its closing `});`): goes through `db.exec` rather
  than calling the module directly, so it's the one test that would catch a regression to `UNSUPPORTED`
  (the direct-call test can't — the swallow lives in the engine, not the wrapper). It:
  - seeds a committed row, opens a transaction, stages a second row under the old PK,
  - asserts `alter table t alter primary key (...)` throws `BUSY` (not `UNSUPPORTED`),
  - asserts the PK is unchanged and the transaction is still open (a follow-up `select` in the same
    transaction sees the staged row),
  - asserts that after `rollback`, the **committed** row from before the transaction is still present —
    this is the specific regression the ticket is about: a shadow-rebuild fallback would have copied it
    into a replacement table, and the replacement survives while the copy is rolled back.
- A worthwhile manual sanity check for the reviewer: confirm `StatusCode.BUSY` really isn't in the
  engine's fallback trigger set. It isn't (`alter-table.ts` ~1502 checks `=== StatusCode.UNSUPPORTED`
  specifically; anything else at that catch just rethrows, ~1512).

# Known gaps / things I did not chase

- I did not independently re-verify the ticket's "reproduced on current main" walkthrough end-to-end
  *before* this fix, because a companion ticket (`alter-primary-key-rebuild-refuse-unsafe`, already on
  `main` per the git log — commits `aeda1152`/`d992c14a`) landed a separate engine-side guard
  (`isExplicitTransactionOpen` check, `alter-table.ts` ~1538) that now refuses the shadow-rebuild
  fallback with a generic `ERROR` whenever an explicit transaction is open — which may already have
  prevented the exact data-loss sequence the ticket describes, independent of this fix. I did not verify
  whether that guard alone would already have caught the ticket's repro (it plausibly would, given
  `IsolationModule` implements `renameTable`, so the guard's precondition is met and it fires before
  reaching the rebuild). Either way, this fix is correct and worth keeping on its own merits: it makes
  the isolation layer's own, more specific, already-documented refusal reach the caller intact, rather
  than depending on a generic engine-side backstop with a less informative message. The two guards are
  independent defense-in-depth, per the ticket's own note that neither depends on the other.
- Did not add a test asserting the *interaction* between this fix and the `isExplicitTransactionOpen`
  guard (e.g. confirming this `BUSY` fires before that guard would ever be reached, since `BUSY` isn't
  caught by the `UNSUPPORTED`-only catch). The new SQL-level regression test implicitly proves this (no
  rebuild happens — the committed row survives — so the fallback path was never entered), but there's no
  test naming that interaction explicitly.
- README and design-doc updates are prose-only; I did not grep for other UNSUPPORTED/BUSY mentions of
  this specific refusal beyond the two files the ticket named.

# TODO for review

- Confirm the `BUSY` code choice and comment placement read clearly in context.
- Confirm the new SQL-level regression test's assertions match ticket intent (BUSY thrown, transaction
  still open, committed row + PK survive rollback).
- Sanity-check the "known gaps" item above about the companion ticket's guard — worth a quick look at
  whether both refusals are exercised by different code paths as claimed, or if one now fully shadows
  the other (in which case a note update, not a code change, would be the right follow-up).
