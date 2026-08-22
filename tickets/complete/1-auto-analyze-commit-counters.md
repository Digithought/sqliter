---
description: Added bookkeeping that counts how many rows each table has had changed since its statistics were last collected, plus four settings controlling when those statistics count as out of date. It only counts and reports — nothing refreshes statistics yet.
files:
  - packages/quereus/src/core/database-auto-analyze.ts        # NEW — AutoAnalyzeManager, threshold policy (212 lines)
  - packages/quereus/src/core/database-transaction.ts         # getChangedRowCounts, context iface, commit hook
  - packages/quereus/src/core/database.ts                     # ctor, close(), recordCommittedChangeCounts, 4 options
  - packages/quereus/test/auto-analyze-counters.spec.ts       # NEW — 27 tests
  - docs/optimizer-costing.md                                 # "Detecting that statistics have gone stale"
  - docs/usage.md                                             # options table rows
---

# Auto-analyze part 1 — committed-mutation counters and threshold policy (complete)

## What shipped

A per-table count of distinct rows changed by *committed* transactions, and the
threshold policy that turns that count into a "statistics are stale" verdict. Nothing
collects statistics: crossing the threshold flips `isStale` and writes one debug log
line. `tickets/implement/2-auto-analyze-scheduled-refresh` turns that signal into a
background refresh.

**Counting source.** `TransactionManager.getChangedRowCounts(): Map<string, number>`
sums `Map.size` over the per-transaction change log's base layer and every live
savepoint layer. The change log is already maintained unconditionally on every write
path, so nothing was added to the write path.

**Read site.** `commitTransaction()` calls
`ctx.recordCommittedChangeCounts(() => this.getChangedRowCounts())` right after the
post-commit watcher block — inside the window where the change log is still alive, and
before the `finally` that clears it. The argument is a thunk, so with `auto_analyze` off
no counts map is ever built. Rollback needs no hook (the log is cleared without ever
calling this).

**Manager.** `src/core/database-auto-analyze.ts`, modelled on `database-watchers.ts`:
owned by `Database`, constructed after `setupOptionListeners()`, subscribed to the
schema-change notifier for `table_removed`, disposed from `Database.close()`. Keyed by
the lowercased `schema.table` string the change log already uses.

```
stale  ⟺  changedSinceAnalyze >= max(auto_analyze_min_mutations,
                                     auto_analyze_ratio × knownRowCount)
```

`knownRowCount` = the entry's `analyzedRowCount` when set, else
`catalogRowCount(table) ?? 0`. For a never-analyzed table that is 0, so the absolute
floor governs — the bulk-load-into-a-fresh-table case.

**Options** (all registered in `setupOptionListeners()`, validated in `onChange` so the
options framework rolls a bad value back):

| option | type | default | validation |
| --- | --- | --- | --- |
| `auto_analyze` | boolean | `true` | — |
| `auto_analyze_min_mutations` | number | `500` | positive integer |
| `auto_analyze_ratio` | number | `0.2` | finite, `> 0` |
| `auto_analyze_row_limit` | number | `100000` | finite, `>= 0` (inert until part 2) |

## Validation

`yarn build`, `yarn lint`, `yarn test` all green after the review's changes.
`@quereus/quereus`: **10032 passing, 25 pending, 0 failing** (10029 before; +3 from this
review). Every other workspace passes. No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

`packages/quereus/test/auto-analyze-counters.spec.ts` — 27 tests.

## Review findings

### Checked and correct — no change

- **The semantics the handoff said were inherited rather than implemented.** Re-derived
  independently from `mergeRecordInto` and the layer walk in
  `core/database-transaction.ts`, not from the handoff's summary. All four hold:
  ten updates of one row coalesce to 1; insert-then-delete of a key removes the entry
  entirely (so no staleness entry is created at all); a PK relocation genuinely records
  delete-of-old + insert-of-new and so counts 2; a rolled-back savepoint's layer is
  popped before the read, and an explicit `rollback` never reaches the hook.
- **Commit-path coverage.** `clearChangeLog()` has four call sites (implicit→explicit
  upgrade, explicit `begin`, the commit `finally`, and rollback). Only the commit
  `finally` discards a *committed* log, and the hook sits above it, so there is no commit
  path that drops counts on the floor.
- **Key convention across all three producers.** `dml-executor.ts`,
  `database-external-changes.ts` and `database-materialized-views.ts` all build
  `` `${schemaName}.${name}` `` and the change log lowercases it; the `table_removed`
  listener lowercases the same pair. Cross-schema collision (`main.t` vs `temp.t`) was
  already covered by a test and still passes.
- **Option rollback really happens.** Read `DatabaseOptions.setOption` — it restores
  `oldValue` and rethrows when `onChange` throws, which is what the validation tests
  assert.
- **No second place enumerates options.** Grepped every package and doc for the two
  existing tunable options; the CLI, web UI and VS Code extension read the registry
  rather than a hardcoded pragma list, so `docs/usage.md` was the only file needing new
  rows. It has them.
- **Per-commit cost of a default-on feature.** Each commit now allocates one small `Map`
  and, per changed table, does one `_findTable` lookup until that table's crossing is
  logged (after which `evaluate` returns immediately). Judged negligible against what a
  commit already does — awaiting a `commit()` per registered connection and flushing the
  batched event queue. **Reasoned, not benchmarked**; no magnitude is claimed.

### Fixed in this pass (minor)

- **A predicate that mutates, now named for it.** `isStale()` deletes the entry when the
  table has disappeared. The side effect lived in a helper called `knownRowCount`, whose
  name promised a pure read. Renamed to `knownRowCountOrDrop` and documented at both the
  helper and `isStale`, so the surprise is visible at every call site instead of being
  discovered. Shape kept — dropping a key for a table that no longer exists is correct,
  and both consumers of a row count want it.
- **`auto_analyze`'s description was inaccurate about the off→on transition.** Both
  `docs/usage.md` and the registered option description said turning the feature back on
  "starts counting from zero". It does not: a table that already had a count resumes from
  it. Reworded to "resumes from whatever each table's count already was, without
  reconstructing the mutations missed while it was off" in both places.
- **`auto_analyze_row_limit` was documented as if it did something.** It is registered
  and validated but read by nobody in part 1, so a user setting it would see no effect.
  Added "Currently inert — staleness is only detected and logged; nothing refreshes
  statistics automatically yet" to its `docs/usage.md` row, and a TODO in the part 2
  ticket to remove that caveat when the knob goes live.
- **Three tests added**, closing gaps the handoff named honestly as gaps:
  - *counts the backing writes a materialized view makes* — the handoff argued this
    correct from the call graph but never exercised it. It is correct: an MV's backing
    writes land under the MV's own key (`main.mv`).
  - *counts externally-ingested changes replayed through the capture seam* — same, via
    `db.ingestExternalRowChanges`.
  - *never fails a committed transaction when bookkeeping throws* — forces a throw
    through the commit hook's `try/catch` and asserts the row is still there. The catch
    existed but nothing proved it protected anything.

### Tripwires parked (conditional — deliberately not tickets)

- **`DETACH` leaks staleness entries.** `SchemaManager.removeSchema` fires no per-table
  event (its own comment says so), so a detached schema's entries outlive it. Harmless
  now — three numbers each, and `knownRowCountOrDrop` evicts one the next time it is
  consulted — and only matters if a host attaches/detaches in a loop. Parked as a `NOTE:`
  on the `table_removed` listener in `core/database-auto-analyze.ts`, stating what to do
  if it ever bites.
- The implement stage's two existing `NOTE:` tripwires — non-persistence of counters
  (on the `entries` map) and cross-layer double counting (at `getChangedRowCounts`) —
  were re-read and are accurate. Left as-is.

### Arms appended to an existing ticket (not new tickets)

All three resolve at a site that does not exist yet — the reset/refresh path this
ticket's successor builds — so they went into
`tickets/implement/2-auto-analyze-scheduled-refresh.md` rather than becoming their own
tickets:

- **A hand-typed `ANALYZE` does not reset the counter.** Part 1 ignores `table_modified`
  by design and has no reset path, so `analyze t` leaves `changedSinceAnalyze` untouched.
  If it was already over the threshold, part 2 will re-scan a table whose statistics are
  seconds old — one wasted scan, then self-correcting. Part 2 must decide explicitly
  whether its reset keys off any successful `ANALYZE` or only its own refresh.
- **MV backing tables are counted and can climb far faster than their source.** A
  full-rebuild MV realizes its whole reshuffled result as a delta (see the existing
  `NOTE:` above `recordMaintenanceChanges`), so a small source write can push the MV past
  the threshold repeatedly. Analyzing an MV is legitimate; the frequency is what part 2's
  duty-cycle cooldown has to bound, and it should be pinned by a test.
- The `docs/usage.md` caveat above, to be removed when the row limit goes live.

### Considered and declined

- **The repeated layer-walk idiom in `core/database-transaction.ts`.** Four methods
  (`getChangedBaseTables`, `getChangedRowCounts`, `getChangedKeyTuples`,
  `getChangedTuples`) each declare a local `collect` and then run the same two-line
  `collect(this.changeLog); for (const layer of this.changeLogLayers) collect(layer);`
  tail; this diff added the fifth-ish instance. A private layer generator would remove
  the tail. Declined: it touches four otherwise-unrelated methods to save about four
  lines of an iteration idiom, not of logic — the bodies differ in every case.
- **`pragma auto_analyze_ratio = -1` reports `Unknown pragma: auto_analyze_ratio`.** The
  pragma emitter wraps *any* `setOption` failure into an unknown-name error, so a value
  problem is reported as a name problem. Confirmed pre-existing and applying equally to
  every already-validated option. The site is already claimed by
  `tickets/backlog/debt-audit-contextual-keyword-value-positions.md` (third bullet, which
  names `runtime/emit/pragma.ts` explicitly) — verified, so no new ticket. The tests
  validate through `db.setOption` to assert the real error text.
- **The `auto_analyze` default-on decision** carries an accepted-tradeoff `NOTE:` at its
  registration in `core/database.ts` with a stated revisit condition (a refresh measured
  interfering with foreground work despite the row limit, duty cycle and
  open-transaction deferral). That condition has not tripped — part 2 has not shipped —
  so it was not re-litigated.

### Empty categories

- **Major findings: none.** Nothing in the diff resolves at a site that would need a new
  `fix/`, `plan/` or `backlog/` ticket. The three forward-looking concerns all land on
  part 2's unwritten reset path and became arms on that ticket instead.
- **Blocked items: none.** No decision here needs a human, and nothing depends on
  anything outside this repo.
- **Pre-existing test failures: none observed.** The full suite is green, so
  `tickets/.pre-existing-error.md` was not written.

## Known limitations carried forward (intended, not defects)

- `analyzedRowCount` is written by nobody in part 1, so the "analyzed" branch of
  `knownRowCount` is exercised only by the pure-function tests. Part 2 populates it.
- `staleLogged` never clears in part 1 — no reset path exists. A table that crosses logs
  once and then stays stale with a monotonically growing counter. Entry count stays
  bounded by table count; only the number grows.
- Staleness does not survive a process restart.
