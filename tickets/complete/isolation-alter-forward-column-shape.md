---
description: Adding, dropping, or renaming a column inside a transaction no longer throws away rows the transaction had already written before a savepoint. Reviewed and completed.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # the change, plus this review's fixes
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # savepoint + layout suites, plus 2 new reserved-name cases
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic  # cross-backend
  - docs/design-isolation-layer.md                            # reserved-column-name rule documented
---

# Complete: ADD / DROP / RENAME COLUMN forward to the isolation overlay in place

## What shipped

Rebuilding a connection's overlay (copying its staged rows into a fresh staging table)
registered a fresh connection whose replayed savepoint stack sat *above* the copied rows,
so `rollback to savepoint` discarded rows staged long before the savepoint was taken.
`ADD` / `DROP` / `RENAME COLUMN` now forward to each open overlay **in place**, through the
overlay's own `alterSchema`, so its layer chain and savepoint snapshots survive the ALTER.

- `alterTable` dispatches per change type; `forwardColumnShapeToOverlay` handles the three
  column-shape ones.
- `buildOverlayAddColumnChange` builds the overlay-flavoured `addColumn`: the new column is
  inserted ahead of the overlay's private deletion-marker column (which must stay last),
  `NOT NULL` is stripped (deletion markers carry placeholder NULLs the base never sees), and
  the per-row backfill routes through the same helper the pre-validation dry-run uses, so
  the two cannot drift.
- `applyInPlaceOverlayChange` centralises the error routing shared with the index paths:
  the issuing connection's own overlay raises `INTERNAL` on a constraint rejection (its rows
  were already judged), a foreign one is poisoned and left untouched for its owner to roll
  back.

Between implementation and this review, two sibling tickets landed on the same code and
finished the picture: `isolation-alter-forward-constraints-and-retype` moved the remaining
change types onto the in-place path and retired the rebuild machinery entirely, and
`bug-isolation-index-ddl-rebuild-drops-savepoint-writes` did the same for index DDL. This
review therefore read the current file, not just the original diff.

## Review findings

### Fixed in this pass

- **`add column` / `rename column` naming the overlay's deletion-marker column corrupted the
  table.** Reproduced: with a transaction open, `alter table t add column _tombstone …`
  reached the overlay, which rejected the duplicate name with a plain `ERROR`. That is not a
  data condition, so it rethrew — *after* the underlying base had irreversibly applied the
  column. The catalog stayed at the pre-alter column set while the base held the new one, and
  a later `insert into t values (2, 'b')` came back as `{"id":2,"v":"b","col_2":0}`: a phantom
  column and a value landed against the wrong slot. This broke the atomic-abort guarantee the
  method documents. Fixed by `assertColumnNameNotTombstone`, which rejects both directions
  with `UNSUPPORTED` before `underlying.alterTable` runs. The check is unconditional (not
  gated on an overlay existing), so a table cannot acquire the colliding name while idle
  either. Two regression tests added; the rule is documented in `docs/design-isolation-layer.md`.
- **A caller-supplied column position was silently discarded.** `buildOverlayAddColumnChange`
  overwrote `insertAtIndex` unconditionally. SQL always appends so no caller supplies one
  today, but the module API permits it and another in-process wrapper could; the base would
  have inserted at the requested slot while the overlay inserted at the end, diverging the two
  layouts with no error. Now `change.insertAtIndex ?? tombstoneIdx` — the overlay's data
  columns mirror the base's one-for-one below the marker, so the base's index is the
  overlay's too.

### Filed as a ticket

- `backlog/debt-isolation-module-file-too-large` — `isolation-module.ts` is ~2,500 lines and
  now holds both module lifecycle and the ~700-line schema-change forwarding machinery this
  ticket family grew. A pure move-and-reorganize, no behavior change. `isolated-table.ts`
  (~2,100 lines) noted there as a separate candidate.

### Recorded as a tripwire (not a ticket)

- A **`create table` that declares a column named like the overlay's deletion marker** puts a
  duplicate entry in the overlay's column list. Probed for a failure and could not produce
  one: reads, merged scans, a unique secondary index over that column, a staged delete and the
  commit flush all behaved identically to a non-colliding name, because every consumer reaches
  the marker by index and the name map resolves to it. Fine now; only matters if something
  ever resolves the overlay's columns *by name*. Parked as a `NOTE:` on `createOverlaySchema`.

### Checked and clean

- **The implementer's two flagged pre-existing defects are both gone.** (1) Memory-native
  `rename column` losing pending rows at commit across a savepoint — fixed by
  `memory-table-rename-with-savepoint-loses-transaction-rows`; the deferred `RENAME` leg is now
  in `41.8-alter-savepoint-staged-rows.sqllogic`, both directions. (2) `rollback to savepoint`
  restoring the pre-alter row layout — fixed; the three assertions that had been scoped around
  it are now tightened (the `DROP COLUMN` case carries a committed row and reads it back, the
  deletion-marker case reads the added column). `tickets/.pre-existing-error.md` is gone,
  `tickets/.pre-existing-known.md` is empty.
- **Dead rebuild machinery.** The implementer kept `dropColumnIdx`, `translateOverlayRow` and
  friends alive for the follow-up ticket. That ticket landed and removed all of it — no
  references remain in `src/` or `test/`.
- **Overlay schema staleness across repeated ALTERs.** `MemoryTable.alterSchema` refreshes its
  own `tableSchema` on both the success and the error path, so a second `add column` in the
  same transaction reads the *current* marker index rather than a stale one. Verified in the
  memory module rather than assumed.
- **Inline constraints on `add column`.** The engine passes the column definition through with
  its inline `UNIQUE` / `CHECK` / `FOREIGN KEY` still attached, and installs each separately via
  `add constraint`. Checked the memory module's `addColumn`: it reads only the default,
  nullability and collation off the definition, so filtering `NOT NULL` alone is sufficient and
  no un-narrowed unique index or marker-hostile CHECK reaches the overlay.
- **Docs.** `docs/design-isolation-layer.md` and `packages/quereus-isolation/README.md` were
  read in full against the current code; the sibling reviews had already brought the in-place
  migration, poison and atomicity sections up to date, and they read true. Added only the
  reserved-column-name rule this review introduced. `yarn docs:check` green (ratchet included).
- **Missing overlay `alterSchema` is a no-op** — the implementer asked for a reviewer opinion.
  Leaving it: it is now the *uniform* behavior of every forward path in the file (column shape,
  column attributes, constraints), the rebuild fallback it would have to reach for no longer
  exists, and it is unreachable with the bundled memory module. Making one path louder than its
  five siblings would be the inconsistency, not the fix.
- **The store-leg savepoint warnings** the implementer flagged (`rollback-to savepoint depth 0
  out of range`) still appear and all assertions still hold. Not introduced here; the underlying
  store auto-commits its transaction on DDL, so a forwarded savepoint rollback finds no frame.
  Left alone — it is the store transaction coordinator's contract, outside this diff.

## Validation

`yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` all green after the review fixes.
7,404 engine tests and 320 isolation tests passing (up 2 — the new reserved-name cases), zero
failing across every package. `yarn docs:check` clean. No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written.
