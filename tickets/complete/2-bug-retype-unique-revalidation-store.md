----
description: On the persistent (LevelDB) storage backend, changing a column's data type used to rewrite the stored rows before checking whether the change breaks a uniqueness rule; now the check runs first over the would-be converted values, so a rejected change leaves the data, the declared type, and the open transaction untouched.
files:
  - packages/quereus-store/src/common/store-module.ts   # AlterColumnAttrChange.valueConvert; alterColumnChange probe → deferred rewrite ordering; rebuildSecondaryIndexes skipDuplicateCheck; convertRowsAtIndex
  - packages/quereus-store/test/alter-table.spec.ts     # new "SET DATA TYPE onto a key-transform type" describe (review-added)
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic       # now cross-module
  - packages/quereus/test/logic/41.7.3.1-alter-column-retype-staged-rows-memory.sqllogic  # memory-only sibling
  - packages/quereus/test/logic.spec.ts                 # MEMORY_ONLY_FILES adjustments
  - docs/store.md, docs/sql-ddl.md                      # validation-ordering prose
----

# Store defers the ALTER COLUMN value rewrite until after UNIQUE re-validation

## What shipped

`StoreModule.alterColumnChange` no longer lets a value-rewriting `ALTER COLUMN` mutate storage
before it knows the change is legal. `AlterColumnAttrChange.valuesRewritten` (a "already done"
flag) became `valueConvert?: (v: SqlValue) => SqlValue` (a deferred closure). The two
value-rewriting sub-helpers — `alterColumnSetDataType`'s physical conversion and
`alterColumnSetNotNull`'s null → DEFAULT backfill — now mutate nothing: each keeps its throw-only
probe and returns the conversion. The caller applies it via `ddlCommitPendingOps()` +
`StoreTable.mapRowsAtIndex` only after every throw-only check has passed.

The existing-row UNIQUE re-validation gate widened from `collationChanged || keyTransformChanged`
to also fire when a value rewrite is pending, and the probed row stream is mapped through the same
closure (module-level `convertRowsAtIndex`), so the probe judges the *converted* values while the
store still holds the old ones. Resulting order: sub-helper throw-only probe → schema build →
UNIQUE probe → primary-key re-key → deferred rewrite → secondary-index rebuild → persist. A
rejection now leaves stored values, persisted DDL and the enclosing transaction untouched.

A second fix was required for the effective-rows semantics to hold: `rebuildSecondaryIndexes`
gained `skipDuplicateCheck`, set from the value-rewrite / key-transform arm. That rebuild reads
this module's *committed* rows, which behind the isolation wrapper may still physically hold a row
the transaction has deleted; its in-pass uniqueness check would then reject a converted-value pair
the probe correctly accepted. The probe is now the sole guard on that arm — the same posture the
memory module documents.

Reviewer changes on top: three comment/naming corrections in `store-module.ts`, one stale sentence
in `docs/sql-ddl.md`, and two new store-package regression tests.

## Review findings

Read the implement diff (`git show 8a9aaf7e`) before the handoff. Verified claims by running code,
not by reading it. `yarn build`, `yarn lint`, `yarn test` (all workspaces), and `yarn test:store`
(7198 passing / 20 pending) are all green after every change.

**Incorrect claim in the handoff, and a wrong comment shipped with it — fixed inline.** The
handoff states "Confirmed: the store still does not reject a PK-column retype", and the diff left
a `NOTE:` at the deferred-rewrite site saying the store "does not yet reject a PK-column SET DATA
TYPE the way memory does", pointing at `bug-store-pk-column-set-data-type-corrupts-keys`. Both are
wrong. Running it directly throws `Cannot SET DATA TYPE on PRIMARY KEY column 'id'` from
`packages/quereus/src/runtime/emit/alter-table.ts:974` — an engine-level guard in front of every
module. The only other producer of a raw `alterColumn` module call is the materialized-view
reshape (`reshapeOpToChange`), and `describePhysicalPkChange` declares a key-column retype
inexpressible before it can get there. So `valueConvert` and `pkRekeyNeeded` cannot both be set,
which is what makes the new ordering safe. Replaced the NOTE with an accurate one naming both
upstream refusals plus the hazard if either is relaxed: the rewrite would have to move *in front
of* the `pkRekeyNeeded` block, since today `rekeyRows` and its index rebuild would run on
pre-rewrite values while the post-rewrite rebuild is skipped whenever `pkRekeyNeeded` is set.

Consequence for another ticket, flagged not acted on: `fix/bug-store-pk-column-set-data-type-corrupts-keys`
asserts "no shared/higher-level guard rejects a PK-column type change". That is false at HEAD. Its
agent should re-verify the premise before implementing; not this ticket's file to retire.

**`skipDuplicateCheck` widening — the handoff's flagged unknown; checked, sound, now covered by
tests.** Two things had to hold and both do. *(a) No uniqueness structure loses its only guard.*
Every `CREATE UNIQUE INDEX` synthesizes a `derivedFromIndex` entry in `uniqueConstraints`, and the
synthetic `_uc_*` indexes from `withImplicitUniqueIndexes` never set `unique: true` — so the
suppressed in-pass check only ever applied to explicit unique indexes, all of which the probe's
`uniqueConstraints` walk reaches. An index not covering the altered column cannot gain duplicates
(its dedupe signature spans its own columns only). *(b) The probe judges under the same rules the
suppressed check used.* `assertNoDuplicateRows` derives key transforms from
`tableSchema.columns[i].logicalType` on the passed post-ALTER schema — the same source
`resolveIndexKeyTransforms` uses. The one divergence is collation source (probe: table column;
suppressed check: index column), which would need a `create unique index … collate X` differing
from its column *and* a collision the conversion introduces; conversions never change case, and
the colliding pair cannot be inserted in the first place (tried it — the index rejects it at
insert). Added two regression tests to `packages/quereus-store/test/alter-table.spec.ts` pinning
the transform-only arm end to end: `text → timespan` rejects an equal-elapsed pair (`'PT1H'` /
`'PT60M'`) leaving values, declared type and writability intact, and a non-colliding one leaves a
seekable index that still enforces.

**Naming — fixed inline.** `valuesRewritten` was read by two gates that both run *before* the
rewrite, asserting a completed act at a point where nothing has been written. Renamed
`rewritesValues` with a comment saying so.

**Documentation drift — fixed inline.** `docs/store.md` was updated but `docs/sql-ddl.md:617` still
carried "(The LevelDB store does not yet honor this — see `bug-retype-unique-revalidation-store`.)"
— the very ticket that landed. Rewritten to state the store's deferred-rewrite guarantee. Read the
other five docs mentioning `SET DATA TYPE` (`memory-table.md`, `module-authoring.md`,
`design-isolation-layer.md`, `mv-schema-change.md`, `store.md`); all read correctly post-change,
no further edits needed.

**New ticket filed — one.** `backlog/bug-store-pk-collate-rejects-deleted-row-collision`. The
handoff asked for a judgment on the primary-key arm's still-enforcing rebuild; it is a real defect,
reachable in the engine's normal configuration. `rekeyRows`' duplicate pass *and* the rebuild that
follows both read committed rows only, so `SET COLLATE` on a primary-key column can be refused over
a row the transaction has already deleted — and the rebuild's refusal lands after the data store
has been re-keyed and the transaction committed, leaving the table mid-change. Pre-existing and
untouched by this diff, so it is not a blocker; filed rather than fixed here because the repair
needs a probe arm for the primary key (which never appears in `uniqueConstraints`), not a filter
change.

**Tripwire — recorded, not filed.** The UNIQUE probe re-scans the row stream once per covering
constraint, and its gate now fires on the *common* retype/backfill path rather than only the rare
collation/transform ones. Fine while tables with several UNIQUE constraints over one column are
rare. Parked as a `NOTE:` at the probe gate in `store-module.ts`, with the fix sketched (judge all
covering constraints in one pass).

**Already-tracked divergence — verified, deliberately not re-reported.** `text → timespan` on a
column under a unique index: the store rejects an equal-elapsed pair (its pre-existing
`keyTransformChanged` probe gate), memory accepts it and lands a duplicate. Confirmed by running
the case in memory mode. Owned by `fix/bug-retype-to-semantic-type-unique-and-query`. This is why
the new coverage lives in the store package rather than the shared `.sqllogic` file — a
cross-module fixture would fail on memory for an unrelated reason.

**Test split — checked, legitimate.** Section 10 of `41.7.3` lost its staged-insert half to the new
memory-only `41.7.3.1`. Verified `fix/bug-isolation-retype-leaves-staged-rows-unconverted` exists
and describes exactly that overlay gap, and that `41.7.3.1`'s header commits to removing its
`MEMORY_ONLY_FILES` entry when that lands. Not a test being weakened to get a green run.

**Empty categories, stated explicitly.** No resource-cleanup findings: the diff adds no handles,
timers or stores — `convertRowsAtIndex` is a pass-through generator over a stream the caller owns.
No error-handling findings: the one place that could swallow (`convertRowsAtIndex` re-running a
conversion the pre-pass already proved) deliberately propagates, and the diff's doc comment says
why. No type-safety findings: `valueConvert` is a concrete `(v: SqlValue) => SqlValue`, no `any`,
and the single `as Row` is a narrowing of `Array.map`'s return. No file-size finding filed —
`store-module.ts` is well past comfortable at ~4000 lines, but this diff is net-neutral on it and
`backlog/debt-memory-alter-column-method-too-long` already tracks the analogous split on the memory
side; splitting the store module is its own piece of work, not a review fix.
