description: On the persistent storage backend, changing which columns make up a table's primary key inside a transaction used to throw away that transaction even when the change was rejected — so a user lost unrelated work they had not committed yet. Fixed by asking the legality question before writing anything out.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # alterTable dispatcher + alterPrimaryKeyChange — the fix
  - packages/quereus-store/src/common/store-table.ts          # validateRekeyedPrimaryKey — probe shared with the SET COLLATE arm
  - packages/quereus-store/test/alter-primary-key-rekey-transaction.spec.ts  # 6 cases
  - docs/store.md                                             # §"DDL that implicitly commits", PK re-key bullet
  - docs/sql-alter.md                                         # §ALTER PRIMARY KEY, empty-key rule
----

# `alter table … alter primary key` rejects before it flushes — complete

## What shipped

`StoreModuleAlter.alterPrimaryKeyChange` now asks `StoreTable.validateRekeyedPrimaryKey` —
the same two throw-only probes the sibling `ALTER COLUMN … SET COLLATE` arm already used —
**before** `ddlCommitPendingOps()` flushes the module's buffered transaction. Previously the
flush ran first and only `rekeyRows`' internal duplicate check could reject, by which point
the flush had committed every table the store module was holding.

Two changes at one site, plus the `rows?: EffectiveRowSource` threading the `alterPrimaryKey`
dispatch arm had been dropping.

## Behavior

- A rejected `alter table … alter primary key` leaves the store, the catalog, **and** the
  enclosing transaction untouched — a following `rollback` undoes every earlier uncommitted
  statement, on the altered table and on every sibling table the module holds.
- Collision among rows the transaction can see → `CONSTRAINT`, naming the colliding key,
  now worded identically to the memory backend's message for the same statement.
- Collision confined to committed rows the transaction has *deleted* → `BUSY`
  ("Commit/rollback and retry"). This is a behavior change on the bare store module:
  previously such a transaction silently succeeded, spending the delete's rollback-ability.
  It now matches the isolation-wrapped path and the SET COLLATE arm.
- A non-colliding re-key inside a transaction still succeeds; rows resolve under the new key
  immediately (point lookup, not just full scan).

## Review findings

### Verified, no change needed

- **The implementer's one unverified claim — that `updatedSchema.columns` vs the old columns
  is a no-op for the probe's key resolution — holds.** `rekeySchemaPrimaryKey`
  (`packages/quereus/src/schema/table.ts:710`) rewrites only each column's `primaryKey` /
  `pkOrder` flags; `resolvePkKeyCollations` and `resolvePkKeyTransforms`
  (`pk-key-resolution.ts:65,210`) read only `collation` (via `pkKeyCollationName`) and
  `logicalType`. Neither reads the flags, so probe and re-key resolve identical key bytes.
- **Only two callers of `rekeyRows` exist** (the SET COLLATE arm and this one) and both now
  probe first, so `docs/store.md`'s stronger claim — pass 1 is "not a rejection path a caller
  can reach" — is accurate as written.
- **No test anywhere asserted the old `rekeyRows` message text** (`duplicate primary key on
  rekey of '…'`), and `test/logic/41.1-alter-pk.sqllogic` §3 asserts a bare `-- error:`, so the
  message change breaks nothing.
- **`rows` threading is now complete across `alterTable`.** The arms that read existing rows
  (`alterPrimaryKey`, `addConstraint`, `alterColumn`) all receive it; the remaining arms
  (`addColumn`, `dropColumn`, `renameColumn`, `drop`/`renameConstraint`) never consult
  `effectiveDdlRows`, so nothing else is silently dropping it.
- **The implementer's admitted gap #1 — no test for `EffectiveRowSource` divergence under the
  isolation wrapper for `ALTER PRIMARY KEY` — is unreachable by design, not untested.**
  `IsolationModule.alterTable` refuses the statement with `BUSY` up front when the issuing
  transaction has staged rows for the table being altered, so the wrapper's `rows()` can never
  diverge from the committed set for this arm. The threading is defensive; the SET COLLATE
  sibling spec covers the shared probe's staged-row path. No ticket.
- **Generator cleanup on rejection is correct.** Both probes throw from inside `for await`,
  which calls the iterator's `return()`, so neither the wrapper's row stream nor the store
  iterator is left open.

### Minor — fixed in this pass

- **`rekeyRows` was called with the *old* column array while the probe used the new one.**
  `alterPrimaryKeyChange` passed only the pk-def and let `rekeyRows` default `newColumns` to
  `this.tableSchema!.columns` (still the pre-ALTER schema at that point), whereas the probe
  passed `updatedSchema.columns`. Byte-identical today (verified above), but it is a silent
  divergence waiting on any future change that touches a column's collation during a re-key.
  Both now pass `updatedSchema.primaryKeyDefinition` / `updatedSchema.columns`, matching the
  SET COLLATE arm. `store-module-alter.ts:487`.
- **`alter primary key ()` on a multi-row table reported `(key: )`** — the store's probe joins
  an empty component list. The memory backend words the same rejection "(the empty key admits
  one row)". Aligned, since closing that divergence was this ticket's stated aim.
  `store-table.ts:196`.
- **`docs/sql-alter.md` §ALTER PRIMARY KEY said the empty-PK form "is permitted" with no
  caveat.** Confirmed empirically against both backends: with two or more rows both reject it
  with `CONSTRAINT` (every row collapses onto the empty key). Doc now states the one-row limit.
  This is pre-existing behavior, not introduced here — `rekeyRows` pass 1 rejected it the same
  way before the fix.
- **The tripwire `NOTE:` on `validateRekeyedPrimaryKey` still said "the SET COLLATE re-key"**
  when describing the four-full-scan cost; both arms now pay it. Updated in place — the
  concern itself (drop pass 1 for pre-validating callers if a huge table makes it slow) is
  unchanged and stays parked at the site, not re-filed.

### Test coverage

Added one case to `alter-primary-key-rekey-transaction.spec.ts` (6 total, was 5): reverting to
an implicit key on a multi-row table is rejected without spending the transaction — the
implementer's admitted gap #2, and it pins the empty-key message. The existing five cases were
re-read and do cover the happy path, both error paths (`CONSTRAINT` / `BUSY`), the retry-after-
commit recovery, the sibling-table regression the ticket was filed for, and the wrapper path.

### Major findings

None. No new tickets filed. The two backlog items the ticket scoped out
(`bug-rolled-back-rows-violate-surviving-ddl`, `bug-overlay-table-name-leaks-into-rekey-error`)
were re-checked and neither is widened by this change.

### Source hygiene

`store-module-alter.ts` 686 lines, `store-table.ts` 725 — both in line with their siblings, no
split warranted. The two arms' pre-flush comment blocks are near-identical six-liners; left as
is, since each names its own arm's specifics and collapsing them would put the explanation
away from both call sites.

## Validation

```
yarn typecheck        # clean
yarn lint             # clean
yarn test             # all workspaces green; @quereus/store 1385 passing (was 1384; +1 new)
yarn test:store       # 8747 passing / 21 pending (unchanged)
```

No pre-existing failures encountered.
