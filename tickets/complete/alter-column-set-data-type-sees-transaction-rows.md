----
description: The in-memory backend's "change a column's type inside a transaction" now sees and converts the transaction's own uncommitted rows instead of ignoring them; this ticket records the review of that fix.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - docs/memory-table.md
----

# Complete: `alter column … set data type` sees & converts the issuing transaction's rows (memory backend)

## What landed

`alter table … alter column … set data type <T>` on the in-memory backend used to read and
convert only the committed base tree, ignoring the open transaction's own pending rows — silently
accepting an unconvertible pending value and discarding a conversion at commit. The implement
commit (`3a75549c`) makes it:

- validate convertibility over the transaction's **effective** rows (committed overlaid with
  pending) before any mutation, rejecting with `MISMATCH` atomically;
- **replace** the base primary tree with converted rows (`convertBaseRows` +
  `rebuildPrimaryTreeFromRows`) rather than mutate it in place (which `inheritree` forbids while
  open layers derive from it), rebuilding secondary indexes from the new values;
- convert the transaction's own open layers oldest-first via new `TransactionLayer.convertColumn`,
  collapsing each layer's own-write log to net per-key effect carrying the converted value;
- **reject** retyping a PRIMARY KEY column (`CONSTRAINT`) — a value-only rewrite cannot re-key.

Store backend untouched (was the reference; see finding below). Memory-only diff.

## Review findings

**Checked:** the full implement diff (manager.ts, transaction.ts, spec, docs) read fresh before
the handoff; the base-replacement / layer-conversion ordering; `convertColumn` vs the
`rekeyPrimaryKey` it is modelled on (own-write collapse, deletion replay, secondary rebuild);
NULL handling parity across the validation pass / `convertBaseRows` / `convertColumn`; the
autocommit path; the catch/rollback restore; store-backend parity for the two behaviors the memory
fix changed; docs (`docs/memory-table.md` § DDL and transactions).

**Verified correct (no action):**
- Base tree replaced, not mutated — sidesteps `MutatedBaseError`; `rebuildPrimaryTreeFromRows`
  uses `insert` and PK is unchanged, so keys stay unique.
- `convertColumn` oldest-first ordering sound: each layer rebuilds over its parent's
  already-converted tree; own-write collapse dedups by encoded PK; a key is finally-deleted or
  finally-upserted, never both (PK stable), so the `rekeyPrimaryKey` `survivingDeletions` filter
  is correctly unnecessary here.
- "Keep unconvertible value as-is" in both `convertBaseRows` and `convertColumn` is safe: the
  effective-view validation already rejected any value a reader can see, so a surviving one is
  shadowed.
- Lint clean; `yarn workspace @quereus/quereus test` → **6913 passing, 0 failing** (13 pending),
  including the new 11-case block. Matches the handoff exactly.

**Major — filed as new tickets (both out of this diff's scope):**
- `backlog/bug-store-pk-column-set-data-type-corrupts-keys` — **confirmed the handoff's
  highest-value open question.** The store backend does NOT special-case a PK-column
  `set data type`: `mapRowsAtIndex` rewrites the row payload's value at the column index but leaves
  the physical key encoded under the old type, producing a key/value mismatch (corruption) where
  memory now safely rejects. Recommended fix: mirror the memory reject in the store; re-key support
  is a larger optional follow-up.
- `backlog/bug-set-data-type-skips-unique-index-revalidation` — **pre-existing** (not introduced
  here): the type-conversion path rebuilds secondary indexes non-enforcing and never re-validates
  UNIQUE, so a conversion that collapses two distinct values to equal (`'1'`/`'01'` → `1`) silently
  violates a UNIQUE index/constraint. Affects both backends. Low priority (narrow trigger).

**Tripwires (parked, not ticketed):**
- `convertColumn` rebuilds **every** secondary index per layer, not only those covering the altered
  column — matches the base's unconditional rebuild. The implement diff already carries a `NOTE:`
  comment at the base rebuild site; the per-layer rebuild is the same reasoning. Only a perf
  concern for wide-index tables under deep savepoint stacks. No code change.
- Rollback fragility if `convertColumn` ever became throwing: validation runs first and
  convert-failures are skipped, so it is effectively non-throwing today; the `alterColumn` catch
  restores only the base tree/schema, not partially-converted layers. Same fragility the collate
  path carries — a shared latent constraint, documented here so a future change that makes
  per-layer conversion able to throw knows the catch must become layer-aware.

**Known gaps re-confirmed, correctly left as-is (no new ticket):**
- Isolation overlay not converted — when a wrapper supplies `rows`, pending rows live outside this
  manager and `convertColumnOnOpenLayers` no-ops. Mirrors the documented collate gap
  `isolation-ddl-validation-ignores-overlay-rows`; the spec header already records it.
- Post-rollback staleness of a shadowed value re-appearing under the new type — consistent with
  `bug-rolled-back-rows-violate-surviving-ddl` and the known "ROLLBACK does not undo DDL" behavior
  (`feat-ddl-transaction-capability`).

**Empty categories:** no minor findings required an inline fix — the implementation, comments, and
docs were accurate and complete for the memory backend; the only defects found were in the store
backend and the pre-existing uniqueness gap, both routed to backlog above.

## Test / store deferral

`yarn test:store` not run (memory-only diff exercises no store code). The store PK-retype
corruption filed above should be confirmed under LevelDB when that ticket is worked.
