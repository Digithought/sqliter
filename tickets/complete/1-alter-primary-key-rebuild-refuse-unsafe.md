---
description: When a table's storage backend cannot change its own primary key, the engine used to silently rebuild the table — which could leave the table unreadable, or destroy already-committed rows if the surrounding transaction was rolled back. Both situations are now refused with a clear error instead.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAlterPrimaryKey guards (~1524-1550); rebuildViaShadowTable doc (~1723)
  - packages/quereus/test/no-alter-module.ts                     # shared no-`alterTable` stub module
  - packages/quereus/test/alter-table-conformance.spec.ts        # alterPrimaryKey arm in the no-hook sweep
  - packages/quereus/test/alter-primary-key-in-transaction.spec.ts  # refusal regression tests (6)
  - docs/sql-ddl.md                                              # ALTER PRIMARY KEY § — two fallback preconditions
  - docs/module-authoring.md                                     # § `alterPrimaryKey` — same two guards, module-author view
difficulty: medium
---

# What shipped

`alter table … alter primary key` asks the backend to re-key itself first (`module.alterTable`
with `{ type: 'alterPrimaryKey' }`). A backend that cannot raises `UNSUPPORTED`, and the engine
used to fall through to a generic rebuild (create shadow → `insert … select` → drop original →
rename shadow). Two of that rebuild's failure modes destroyed or stranded user data; both are
now refused at the point the rebuild is chosen, capability first:

1. **Module has no `renameTable`** ⇒ `StatusCode.UNSUPPORTED`. The rebuild ends by renaming a
   shadow table over the original; a backend that never hears about the rename keeps its rows
   under the shadow name and the rebuilt table cannot be opened at all.
2. **An explicit (`BEGIN`-opened) transaction is open** ⇒ `StatusCode.ERROR` (not `BUSY` — a
   retry inside the same transaction can never succeed). The rebuild's `drop` + `rename`
   survives `rollback` while its row copy does not, so a rollback would keep the new empty
   table and discard the copy of the rows it replaced.

The check uses `isExplicitTransactionOpen(db)`, not `getAutocommit()`: in autocommit the ALTER's
own `_ensureTransaction()` has already opened an *implicit* transaction, so `getAutocommit()`
alone would refuse the one case the rebuild handles correctly. `savepoint` without `begin`
upgrades the implicit transaction to explicit, so it is refused too — verified, see below.

The `UNSUPPORTED` swallow at the native attempt now logs at warn instead of vanishing.
`rebuildViaShadowTable`'s doc comment states both preconditions and why neither has a repair.

# Review findings

Reviewed the implement diff (`aeda1152`) before the handoff summary, then re-read the guard
site, `ddl-transaction-policy.ts`, `TransactionManager`, `rebuildViaShadowTable`, the module
interface, and the isolation wrapper.

## Fixed in this pass (minor)

- **Guard 1's error message was factually wrong on one of its two entry paths.** It read "the
  module implements neither 'alterTable' … nor 'renameTable'", but the guard also fires when the
  module *does* implement `alterTable` and that hook declined with `UNSUPPORTED`. Reworded to
  "it cannot re-key in place (it implements no 'alterTable' hook, or the hook declined)". The
  "does not support" phrase the conformance sweep matches on is preserved.
- **Two coverage gaps the handoff flagged, both closed** in
  `alter-primary-key-in-transaction.spec.ts` (now 6 tests):
  - `savepoint` opened without `begin` — behavior is already correct
    (`TransactionManager.upgradeToExplicitTransaction` makes the transaction explicit, so guard
    2 fires), but nothing asserted it. Test also checks the savepoint stack survives the
    refusal (`rollback to` / `release` / `rollback` all still work, committed row intact).
  - `alter primary key ()` — the legal empty-key form takes the same path and meets the same
    guard. Asserted against guard 2 only, so the test does not depend on the rebuild's own
    empty-key correctness.

## Filed as a ticket (major)

- **`backlog/debt-alter-pk-guard-blind-to-wrapper-modules`** — guard 1 probes capability by
  method presence (`if (!module.renameTable)`). `@quereus/isolation` always *defines*
  `renameTable` and only forwards to the wrapped module when that one has the hook
  (`isolation-module.ts:1518`), so a rename-less backend behind the isolation wrapper presents
  as capable, the guard passes, and the rebuild strands the rows exactly as the guard exists to
  prevent. Its `alterTable` has the mirror shape (always defined, raises `UNSUPPORTED` when the
  wrapped module lacks the hook) — so the wrapper both routes the statement into the rebuild
  and hides the lock. Dormant in-repo: memory and store both implement `renameTable`. Filed
  rather than fixed inline because the right answer is a capability protocol decision, not a
  patch to this one guard — method-presence probing has the same blind spot everywhere it is
  used.

## Recorded as a tripwire, not a ticket

- Guard 2 refuses on **every** `DdlTransactionality` tier, including a module that declares
  `'transactional'` — for which the `drop` + `rename` *would* roll back with the row copy,
  making the refusal over-broad. No module declares that tier today (memory:
  `'non-transactional'`, store: `'auto-commit'`), and the failure mode is a conservative
  refusal, not data loss. Parked as a `NOTE:` at the guard site naming the exemption to add
  (`resolveDdlTransactionality(module) === 'transactional'`, as `assertDdlTransactionPolicy`
  already does).

## Checked and found clean

- **Guard placement.** Both guards sit after the native `alterTable` attempt (whose
  `UNSUPPORTED` contract means nothing was mutated) and before `rebuildTableWithNewShape`, and
  before `rekeyBatchedDataEvents` — so a refusal leaves the catalog, the event batch and the
  enclosing transaction untouched. The three regression tests that continue using the
  transaction after the refusal confirm it behaviorally.
- **Blast radius.** `rebuildTableWithNewShape` has exactly one caller (`runAlterPrimaryKey`), so
  no other ALTER arm inherits the new refusals.
- **`warnLog` idiom** matches the 15 other `log.extend('warn')` sites in the package.
- **Docs.** `docs/sql-ddl.md` and `docs/module-authoring.md` both state the two preconditions
  and stay accurate after the message rewording. Swept every other doc that mentions ALTER
  PRIMARY KEY or the shadow rebuild (`schema.md`, `store.md`, `usage.md`, `module-events.md`,
  `memory-table.md`, `design-isolation-layer.md`, `sqlite-test-crosscheck.md`) — none describes
  the fallback's availability, so none went stale. `test/logic/41.1-alter-pk.sqllogic` exercises
  the memory native path only and is unaffected.
- **Test hygiene.** `no-alter-module.ts` is a helper, not a spec — the mocha glob is
  `test/**/*.spec.ts`, so it is imported, never collected as an empty suite.
- **Source hygiene.** Guards are two short early-throws in an already-long function; no
  extraction warranted. The rebuild's `Date.now()`-suffixed shadow name and its mid-rebuild
  failure path are pre-existing and out of this diff's scope.

## Not re-verified

- `yarn test:store` was not run (per the handoff's own note): the store re-keys natively and
  never reaches these guards.

# Validation

`yarn lint` clean. `yarn test` green across all workspaces (`packages/quereus` including the 6
refusal tests and the 76-test ALTER conformance + PK-transaction pair). No pre-existing failures
surfaced; `tickets/.pre-existing-error.md` not written.
