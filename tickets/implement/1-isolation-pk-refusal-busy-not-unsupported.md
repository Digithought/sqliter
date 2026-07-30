---
description: The transaction-isolation layer already knows it cannot change a table's primary key while the transaction has unsaved rows, and says so with a clear message — but that message never reaches the application, because it is reported with a code the engine treats as "try something else" rather than "no".
prereq:
files:
  - packages/quereus-isolation/src/isolation-module.ts      # ~1338 — the refusal; also ~1291, the genuine capability refusal that must KEEP UNSUPPORTED
  - packages/quereus-isolation/test/isolation-layer.spec.ts # ~6471 'rejects the issuer up front when its transaction has staged rows' — asserts the code
  - packages/quereus-isolation/README.md                    # ~143 — states the refusal is UNSUPPORTED
  - docs/design-isolation-layer.md                          # ~869 § "ALTER PRIMARY KEY: the one change no overlay can follow" — same
  - docs/module-authoring.md                                # ~905 — the contract this violates ("BUSY reads best")
  - packages/quereus/src/runtime/emit/alter-table.ts         # runAlterPrimaryKey ~1500 — the catch that swallows UNSUPPORTED
difficulty: easy
---

# What is wrong

`@quereus/isolation` wraps a storage backend and gives each connection a private staging area
("overlay") for the rows it has written but not yet committed. An overlay's staged rows are
filed under the table's *current* primary key, and a staged deletion is recorded as a marker
identified by that same key — so if the primary key changes, the overlay can no longer say
which row any of its entries refers to. The layer therefore refuses the change outright when
the issuing transaction has anything staged, with a message that names the remedy:

```
Cannot alter the primary key of 'main.t' while this transaction has uncommitted changes
staged for it; commit or roll back first.
```

That message is unreachable. It is raised as `StatusCode.UNSUPPORTED`
(`isolation-module.ts` ~1338), and `UNSUPPORTED` is the engine's agreed signal for *"this
backend cannot re-key in place — use the generic fallback"*. `runAlterPrimaryKey`
(`packages/quereus/src/runtime/emit/alter-table.ts` ~1500) therefore catches it and rebuilds
the table by copying its rows into a replacement — which is exactly the wrong thing to do here,
because the copy sees only committed rows and, on `rollback`, the copy is undone while the
replacement table is not. Reproduced on current `main`:

```ts
db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
await db.exec(`create table t (a integer not null, b integer not null, v text, primary key (a)) using isolated`);
await db.exec(`insert into t values (5, 5, 'pre')`);   // committed
await db.exec('begin');
await db.exec(`insert into t values (1, 9, 'x')`);
await db.exec(`alter table t alter primary key (a, b)`);  // reports success
await db.exec('rollback');
// select * from t  →  []   — the committed row is gone
```

# The contract it violates

`docs/module-authoring.md` ~905 already states the rule, in the `alterPrimaryKey` paragraph:

> Beware what the fallback cannot do: a shadow rebuild copies **committed** rows only, so a
> module that owns transactional pending state must either re-key it natively or refuse the
> change with a non-`UNSUPPORTED` error (`BUSY` reads best) while a transaction holds
> uncommitted writes — an `UNSUPPORTED` refusal is swallowed by the fallback and the pending
> writes are silently lost.

The isolation layer is precisely "a module that owns transactional pending state", and this is
precisely the refusal the paragraph describes. So this is a one-code fix to an
already-documented contract, not a design question.

`BUSY` also reads correctly to a caller: the refusal *is* retryable, just not from inside the
current transaction — which is what the message already says. This matches the layer's other
retryable refusal in the same area (the unrepresentable re-key that raises `BUSY`, described in
`docs/design-isolation-layer.md` § *SET COLLATE on a primary key*).

# What must NOT change

The refusal ~50 lines earlier in the same method — raised when the wrapped backend has no
`alterTable` hook at all (`isolation-module.ts` ~1291, "Underlying module does not support
ALTER TABLE for '…'") — is a genuine capability statement and must keep `UNSUPPORTED`, so the
engine's fallback still applies to it. Only the staged-rows refusal changes code. The test
`an underlying's UNSUPPORTED propagates with every overlay untouched`
(`isolation-layer.spec.ts` ~6517) pins a third case — a stub *underlying* refusing with
`UNSUPPORTED`, forwarded through the wrapper unchanged — and must also keep passing untouched.

The engine-side guard that refuses the rebuild inside an explicit transaction for *any* backend
lands separately in `alter-primary-key-rebuild-refuse-unsafe`. The two are complementary and
neither depends on the other: this ticket gives the isolation layer's own, better-sited message
back to the caller; that one is the backstop for backends that have no such message.

# TODO

- Change the staged-rows refusal at `isolation-module.ts` ~1338 from `StatusCode.UNSUPPORTED`
  to `StatusCode.BUSY`. Leave the message text as-is — it already names the remedy.
- Extend the comment above it to say *why* the code is `BUSY` and not `UNSUPPORTED`: the engine
  swallows `UNSUPPORTED` from `alterTable` as "use the shadow-table fallback", which would copy
  committed rows only and lose this transaction's staged writes. Cite
  `docs/module-authoring.md` § `alterPrimaryKey`.
- Update `isolation-layer.spec.ts` ~6478 to expect `StatusCode.BUSY`. The surrounding
  assertions (underlying never asked to mutate, issuer overlay intact and unpoisoned) stay.
- Add an end-to-end regression that goes through SQL rather than calling `iso.alterTable`
  directly — the direct-call test cannot catch the swallow, since the swallow is in the engine.
  Use the reproduction above: assert the ALTER throws `BUSY`, that the transaction is still
  open, and that after `rollback` the committed row is still present and the primary key is
  unchanged. Home: `packages/quereus-isolation/test/alter-table-conformance.spec.ts`, in the
  existing `ALTER over staged overlay rows (isolation layer)` describe block (~373), whose
  stated purpose is exactly "an open transaction with staged overlay rows … a reject arm still
  rejects (never a silent success)".
- Update `packages/quereus-isolation/README.md` ~143 and `docs/design-isolation-layer.md` ~869
  (the "Issuer with staged rows" bullet) to name `BUSY` instead of `UNSUPPORTED`, each with the
  one-clause reason (an `UNSUPPORTED` refusal would be swallowed by the engine's rebuild
  fallback).
- Run `yarn build`, then `yarn test` (streamed, `2>&1 | tee /tmp/t.log`), then `yarn lint`.
