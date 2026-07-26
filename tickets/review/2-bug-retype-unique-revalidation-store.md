----
description: On the persistent (LevelDB) storage backend, changing a column's data type used to rewrite the stored rows before checking whether the change breaks a uniqueness rule; now the check runs first over the would-be converted values, so a rejected change leaves the data, the declared type, and the open transaction untouched.
files:
  - packages/quereus-store/src/common/store-module.ts   # AlterColumnAttrChange (~237); alterColumnChange UNIQUE probe + deferred rewrite (~2177-2280); alterColumnSetNotNull (~2296); alterColumnSetDataType (~2378); rebuildSecondaryIndexes skipDuplicateCheck (~1246); convertRowsAtIndex (~3945)
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic       # now cross-module
  - packages/quereus/test/logic/41.7.3.1-alter-column-retype-staged-rows-memory.sqllogic  # new memory-only sibling
  - packages/quereus/test/logic.spec.ts                  # MEMORY_ONLY_FILES: 41.7.3 removed, 41.7.3.1 added
  - docs/store.md                                        # "DDL that implicitly commits" validation sentence updated
----

# Review: store defers ALTER COLUMN value rewrite until after UNIQUE re-validation

## What was done

Mirrors the memory backend's fix (`bug-retype-unique-revalidation-memory`) in
`StoreModule.alterColumnChange`, per the ticket's design:

- `AlterColumnAttrChange.valuesRewritten` replaced with a deferred
  `valueConvert?: (v: SqlValue) => SqlValue` closure. The two value-rewriting sub-helpers
  (`alterColumnSetDataType`, `alterColumnSetNotNull`) no longer mutate anything — each keeps
  its throw-only probe (convertibility scan / NULL probe) and returns the conversion as a
  closure. The caller applies it via `ddlCommitPendingOps()` + `StoreTable.mapRowsAtIndex`
  only after every throw-only check has passed.
- The existing-row UNIQUE re-validation gate widened from
  `collationChanged || keyTransformChanged` to also fire on `valueConvert`, and the probed
  row stream is mapped through the closure (new module-level async generator
  `convertRowsAtIndex`), so the probe judges the CONVERTED values while the store still holds
  the old ones. Wrapper-supplied `EffectiveRowSource` (`rows`) is honored, so the probe sees
  the isolation overlay's pending inserts and skips its deletes.
- Resulting order: sub-helper (throw-only) → schema build → UNIQUE probe → PK re-key →
  **deferred rewrite** → secondary-index rebuild → persist. A rejection now throws with the
  stored rows, the persisted DDL, and the enclosing transaction all untouched (previously the
  rows were already converted under a still-TEXT catalog when the rebuild threw).

**A second, discovered-during-work fix was required to make the effective-rows semantics
hold:** `rebuildSecondaryIndexes` gained a `skipDuplicateCheck` parameter, set `true` from the
value-rewrite / key-transform rebuild arm. The rebuild reads this module's *committed* rows,
which under the isolation wrapper may still physically hold a row the transaction has deleted;
its in-pass UNIQUE check would then spuriously reject a converted-value duplicate pair the
probe (correctly, over effective rows) accepted. Fixture § 8 caught this. The probe is now the
sole enforcement on that arm — the same "deliberately non-enforcing rebuild" posture the
memory module documents. The PK re-key arm's rebuild call is left enforcing (unchanged).

## Test / validation status

- `41.7.3-alter-column-retype-unique.sqllogic` removed from `MEMORY_ONLY_FILES`; passes in
  both modes. Extended with post-rejection `table_info()` declared-type assertions (§ 1) and a
  post-accept one (§ 5), per the ticket.
- § 10 (rejected-then-retried retype inside a transaction) had to be split: the shared version
  now commits without a surviving staged insert; the original full scenario — where the
  transaction's own staged insert must come out converted — moved to new memory-only
  `41.7.3.1-alter-column-retype-staged-rows-memory.sqllogic`. In store mode that assertion
  hits the isolation layer's known staged-row conversion gap, already tracked as
  `fix/bug-isolation-retype-leaves-staged-rows-unconverted` (that ticket's fix should remove
  the new `MEMORY_ONLY_FILES` entry — its comment says so). Not re-reported.
- Suites: quereus memory (7205 pass), quereus store mode (7198 pass), @quereus/store package
  (1018 pass), @quereus/isolation package (258 pass), `yarn build`, `yarn lint` all green.

## Interaction with `bug-store-pk-column-set-data-type-corrupts-keys` (ticket asked)

Confirmed: the store still does **not** reject a PK-column retype (memory throws `Cannot
change the data type of primary key column …`). **No conflict** — the restructure makes that
ticket easier: its rejection is a throw-only check that slots with the others, before the
deferred rewrite. A `NOTE:` at the rewrite site (store-module.ts ~2245) marks the slot and
names the ticket. Until it lands, a PK-member retype with a key-transform change would re-key
from pre-rewrite values — exactly the corruption that ticket tracks; nothing here worsens it.

## Reviewer attention points (honest gaps)

- **`skipDuplicateCheck` also covers the transform-only arm.** The step-7 rebuild fires for
  `keyTransformChanged` without a value rewrite (e.g. text → timespan); it now skips the
  in-pass check there too. Sound by the same argument (the probe gate includes
  `keyTransformChanged`, so the probe always ran when this rebuild runs), but it is a
  behavior widening beyond the minimal bug — worth an independent look.
- **Pre-existing sibling of the § 8 failure, PK arm:** the `pkRekeyNeeded` rebuild (SET
  COLLATE / key-transform on a PK member) still runs an *enforcing* rebuild over committed
  rows. Under the isolation wrapper, an overlay-deleted row colliding under the new collation
  in a covering UNIQUE index would spuriously throw there — after `ddlCommitPendingOps` and
  `rekeyRows`, i.e. mid-mutation. Pre-existing, untouched here, narrow (needs wrapper +
  PK-member collate/transform change + committed-but-overlay-deleted duplicate). Judge
  whether it merits a fix ticket.
- **Convertibility probe scope (pre-existing):** `alterColumnSetDataType`'s throw-only
  convert pass scans `table.iterateEffectiveValuesAtIndex` (this module's own effective rows)
  and ignores the wrapper's `rows` — an unconvertible *staged* value is not caught by the
  store. The isolation-layer ticket above owns staged-row conversion/validation end to end.
- Per-constraint probe re-scans the row stream (fresh generator each time) — same cost shape
  as the pre-existing SET COLLATE path; the isolation module already carries a NOTE tripwire
  about many-constraint DDL scan cost.
