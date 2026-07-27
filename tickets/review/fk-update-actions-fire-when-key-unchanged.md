---
description: Added the regression tests that lock in a fix (already landed) for a bug where updating any column of a parent row wrongly rewrote or deleted its child rows, even when the column the children actually point at never changed.
files:
  - packages/quereus/src/runtime/foreign-key-actions.ts        # gate at line ~280 (fix, landed previously); NOTE tripwire added at ~642
  - packages/quereus/test/logic/41-foreign-keys.sqllogic       # new value-level regression block, ~line 889 onward (fkgd_/fkgn_/fkgnn_/fkgc_ prefixes)
  - packages/quereus/test/runtime/fk-action-key-change-gate.spec.ts   # new event-level regression spec (all 4 tests)
difficulty: easy
---

# Regression coverage for the parent-update foreign-key action gate

## What this ticket added

The engine fix itself landed in a prior ticket (`fk-update-actions-fire-when-key-unchanged`,
fix stage) — `executeForeignKeyActions` in `packages/quereus/src/runtime/foreign-key-actions.ts`
now skips an ON UPDATE action (CASCADE / SET NULL / SET DEFAULT) entirely when the parent
column the FK references didn't actually change value, via the same
`anyReferencedColumnChanged` short-circuit every other enforcement site in that file already
used. This ticket's job was only to add the regression tests specified in the ticket body, so
the fix can't silently regress.

Two additions, mirroring the ticket's two-modality split:

**`test/logic/41-foreign-keys.sqllogic`** (value-level, appended after the existing `crcd_`
block): four new table groups —
- `fkgd_*` — SET DEFAULT: untouched referenced column ⇒ child untouched; genuine re-key ⇒
  child re-points to the (live) default parent key.
- `fkgn_*` — SET NULL, nullable child column: untouched ⇒ child untouched; re-key ⇒ child
  nulled.
- `fkgnn_*` — SET NULL, **non-nullable** child column (bare `p_id integer`, NOT NULL by
  Quereus's default): untouched referenced column must now **succeed** as a no-op, where it
  previously raised `NOT NULL constraint failed: c.p_id`. Only the untouched case is
  exercised here — a real re-key on this shape would violate NOT NULL by design, so there's
  no meaningful positive-direction assertion for it.
- `fkgc_*` — CASCADE: untouched ⇒ child value unchanged (value-only test — see below for
  why this alone can't prove the phantom write is gone); re-key ⇒ child follows.

**`test/runtime/fk-action-key-change-gate.spec.ts`** (event-level, new file, modeled on
`fk-cascade-reentry.spec.ts`): one `describe` with 4 `it`s, one per action shape above,
subscribing via `db.onDataChange` and asserting on the emitted event stream. This is the
modality that actually catches the CASCADE phantom-write bug: CASCADE rewrites the child
column to the value it already holds, so a value-only check sees no difference before/after
the fix — only the *absence of a child data-change event* proves the write didn't happen.
Each test asserts:
- an update to an unrelated parent column emits **zero** events for the child table;
- a genuine re-key emits **exactly one** child event, `type: 'update'`,
  `changedColumns: ['p_id']`, and the expected `newRow`.

Also added one `NOTE:` code comment (not a behavior change) in `executeSingleFKAction`
(`foreign-key-actions.ts` ~line 642), recording the ticket's optional Phase 3 observation:
the cascade branch decides DELETE-vs-UPDATE purely from `newRow === undefined`, which is
dormant today (every caller in `dml-executor.ts` passes a defined `newRow` on the update
path) but would silently issue a child DELETE if some future caller ever called
`executeForeignKeyActions('update', ...)` with no `newRow`. Recorded as a tripwire per the
ticket's own suggestion ("skip if it reads as noise") rather than adding an unreachable-path
guard, which the project's general guidance (AGENTS.md: don't validate scenarios that can't
happen) argues against turning into actual code.

## Validation performed

- `yarn test --grep "FK action gate"` (new spec only): 4 passing.
- `yarn test --grep "41-foreign-keys"` (new sqllogic file only): 1 passing (the whole file is
  one mocha `it()` — don't read "1 passing" as "only one assertion ran"; the new blocks live
  inside it and were confirmed by editing an expectation locally before finalizing).
- `yarn workspace @quereus/quereus run test` (full suite): **7347 passing / 13 pending / 0
  failing** — up from the ticket's stated 7343 baseline by exactly the 4 new spec tests (the
  sqllogic additions don't add to the flat count, per above).
- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run typecheck`: clean.
- Did not run `yarn test:store` (LevelDB path) — the ticket didn't call for it and the fix
  site is backend-agnostic (operates on in-memory `Row` arrays before any vtab call), but a
  reviewer who wants the store path exercised for this specific case should say so.

## Behavior to exercise

Quickest manual check of the gate itself:

```sql
create table p (id integer primary key, other integer);
create table c (cid integer primary key, p_id integer,
    foreign key (p_id) references p(id) on update cascade);
insert into p values (1, 100);
insert into c values (10, 1);
update p set other = 999 where id = 1;   -- must NOT touch c at all
select p_id from c;                       -- still 1
update p set id = 7 where id = 1;         -- must cascade
select p_id from c;                       -- now 7
```

Subscribing `db.onDataChange` around the first `update` is the only way to see the
before-fix bug directly — the value never moved, only a phantom event did.

## Known gaps / things a reviewer should push on

- The four sqllogic table groups (`fkgd_`, `fkgn_`, `fkgnn_`, `fkgc_`) each use a single
  child row and a single parent update. No multi-row / batched-RESTRICT-adjacent variant is
  tested here — the existing `crc_`/`crcj_` blocks right above already cover the "mixed
  RESTRICT + CASCADE on the same parent forces the per-row transitive pre-walk instead of
  the batched accumulator" interaction, and the fix under test lives in a function upstream
  of that split (`executeForeignKeyActions`, not the batch accumulator), so it wasn't
  duplicated here. Worth a second look if the reviewer isn't convinced the two code paths
  can't diverge.
- The event spec asserts `newRow` as a bare array (`[10, 99]` etc.), matching the
  `DatabaseDataChangeEvent.newRow: Row` shape used by the existing
  `database-events.spec.ts` — not re-verified against a second harness.
- Lens/logical-FK coverage for this same gate was explicitly audited (not tested) in the fix
  ticket — `resolveLensFkParentReferencedValues` already shares `anyReferencedColumnChanged`
  and was judged not to need its own regression test. This ticket did not add one either; if
  the reviewer wants a belt-and-suspenders lens-level event test, that's new scope, not a gap
  in what was asked for.

## Tripwires recorded

- `packages/quereus/src/runtime/foreign-key-actions.ts` ~line 642 — `NOTE:` above the
  `case 'cascade':` branch in `executeSingleFKAction`: the DELETE-vs-UPDATE decision rides
  `newRow === undefined` alone; dormant today, would misfire only if a future caller passed
  `operation: 'update'` with no `newRow`.
