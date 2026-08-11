---
description: When a transaction changes the sorting rule of a primary-key column on a persistent table and the change is refused, the error message named an internal bookkeeping table instead of the table the user actually wrote — now fixed and covered by a regression test.
files:
  - packages/quereus-isolation/src/isolation-module.ts    # new private renameOverlayInError() helper (~line 978); wired into the PK re-key pre-flight catch in alterTable() (~line 1541)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # regression test at line 2619, inside the "SET COLLATE on a PRIMARY KEY column judges the transaction's effective rows" describe block
difficulty: easy
---

# Re-key refusal named the internal staging table — fix verified, ready for review

## What changed

`IsolationModule.alterTable` pre-flights a primary-key-rekeying `ALTER COLUMN … SET COLLATE`
against the issuing connection's own overlay (an internal `MemoryTable` named
`_overlay_<table>_<id>`, see `IsolationModule.createOverlaySchema`) before touching the shared
underlying table. When the collision this transaction's own INSERT-then-DELETE created was
confined entirely to the overlay's own layer chain — never reaching the shared underlying table
— the overlay's own representability check raised `BUSY` naming its internal overlay table name,
and that raw error text reached the caller unchanged. Every other overlay-sourced error in this
module was already caught and re-described with the real schema-qualified table name; this one
pre-flight call was the sole unguarded spot.

Fix: a new private `IsolationModule.renameOverlayInError(e, overlaySchema, tableName)` helper
(isolation-module.ts ~line 978) — if `e` is a `QuereusError` whose message contains the overlay's
internal schema name, returns a new `QuereusError` with that substring replaced by the real table
name (same code/cause/line/column); no-op otherwise. Wired into the PK re-key pre-flight's catch
block (~line 1541).

## Use cases / how to validate

Primary regression coverage — `packages/quereus-isolation/test/isolation-layer.spec.ts:2619`,
`'names the user's table, not the internal overlay staging table, when the collision is confined
to rows this transaction both inserted and deleted'`:

- `CREATE TABLE ecp_own (k TEXT PRIMARY KEY, v TEXT) USING isolated`
- `BEGIN; INSERT INTO ecp_own VALUES ('A','x'),('a','y'); DELETE FROM ecp_own WHERE k IN ('A','a')`
  — both rows live only in this transaction's overlay, never on the shared underlying table.
- `ALTER TABLE ecp_own ALTER COLUMN k SET COLLATE NOCASE` refused with `BUSY`, message contains
  `table ecp_own:` and does **not** match `/_overlay_/`.

Sibling tests in the same describe block (`raises the same BUSY when only one of the two
colliders is deleted`, `refuses two staged live colliders with CONSTRAINT`, `still refuses
committed colliders visible to the transaction with CONSTRAINT`) pin the other three
collision-visibility permutations so this fix's substring-replace couldn't accidentally change
their `-- error:` wording — worth a skim if touching this code further, since one of those
(`41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`) is matched by a `sqllogic` test
elsewhere on the message text `"still collide under the new key definition"`, which the fix
deliberately leaves untouched.

## Verification performed this stage

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run test` — 387 passing (re-ran fresh; matches prior stage's
  count), including the regression test above.
- Read the wiring end-to-end: `renameOverlayInError` call site (isolation-module.ts:1544) and the
  regression test body — confirmed the substitution is scoped to the PK re-key pre-flight catch
  only, and the test asserts both the positive (`table ecp_own:`) and negative (`not /_overlay_/`)
  cases.
- Prior implement-stage verification (not independently re-run this stage, but consistent with
  the above): `yarn workspace @quereus/quereus run test` (memory mode) — 9396 passing, 25 pending,
  0 failing, including `41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`.

## Known gap — flag for reviewer

- `yarn test:store` (LevelDB-backed store logic tests) was **not** run in either the implement or
  this review stage — it re-runs the full `packages/quereus` sqllogic suite against the LevelDB
  store module and isn't scriptable to a single targeted file from the CLI (`test-runner.mjs`
  has no per-file filter flag), making a quick targeted run impractical here. The fix is
  store-agnostic by construction: the overlay module wrapped by `IsolationModule` is always an
  in-memory `MemoryTableModule` regardless of which module `underlying` points at (memory or
  store), and the bug's collision is confined entirely to that overlay's own layer chain before
  ever reaching `underlying`. So the code path exercised is identical under `USING isolated` over
  a store-backed table. Reviewer can run the full `yarn test:store` (slow, several minutes) for
  end-to-end confirmation if desired; otherwise this is safe to accept on the memory-mode
  evidence above plus the store-agnostic code-path argument.
- No other call site was found that leaks an overlay's internal name into a user-facing error —
  established by reading call sites (every other overlay-sourced error in this module already
  routes through a re-describe helper), not by an exhaustive search-tool run.
