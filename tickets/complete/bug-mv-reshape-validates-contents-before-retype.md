---
description: A maintained table rebuilt after one of its source columns changed type or text-sorting rule used to check the rebuilt rows against the table's OLD column definition, so a row breaking its own rule under the NEW definition was accepted and stored. The check now uses the final column definition, so such a row is rejected and nothing is written.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # previewReshapedColumns (~2467); validateDeclaredConstraintsOverContents (~938); rebuildBacking (~1568); attachMaintainedDerivation call site (~1296); reshapeBackingInPlace (~2602)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # 4 new tests added in review
  - docs/materialized-views.md                                       # § REFRESH MATERIALIZED VIEW, line 208
  - docs/runtime.md                                                  # § Strict physical-representation test mode, line 1074 (fixed in review)
  - package.json                                                     # root; `check` chain now ends `&& yarn test:repr-strict`
repro: verified
difficulty: medium
---

# What shipped

A **maintained table** derives its contents from a query over other tables. When a
source column changes its declared type (or its text-sorting rule, its *collation*),
the maintained table is **reshaped**: its own column takes the new attribute and its
contents are rebuilt from the query.

The rebuild validates the new contents against the table's declared `check (…)` and
foreign-key constraints. It used to do that while the catalog entry still carried the
**old** column attributes — and a SQL comparison takes its type affinity and its
collation from the column's *declared* attributes, so `check (v < '9')` on a column
moving TEXT → INTEGER compared lexicographically (`'10' < '9'` is true) instead of
numerically (`10 < 9` is false), and the offending row was committed and survived.

Nothing was reordered. The reshape's `retype` / `recollate` module ops still run last
(they convert *stored* rows; running them earlier would scan the about-to-be-discarded
contents and throw spuriously). The one validation scan is instead handed a **preview**
of the columns the reshape is about to land — `previewReshapedColumns`, the live
columns with only `logicalType` and `collation` overridden from the target shape — so
it resolves comparisons under the final attributes while running at exactly the same
point in the sequence, still before the commit. Both reshape call sites (refresh via
`reshapeBackingInPlace` → `rebuildBacking`, and attach via `attachMaintainedDerivation`)
pass the preview, so the two paths reject identically. `notNull` and
`defaultValue`/generated-column attributes are deliberately not previewed, each with a
comment at the site.

Rejection leaves the pre-refresh contents intact and the table stale; because the
post-reconcile ops never run on a rejected refresh, the catalog column keeps its old
type/collation. Correcting the offending source data and refreshing again completes the
reshape.

`yarn test:repr-strict` is now clean and was added to the root `check` chain.

# Review findings

Reviewed the implement diff (`e377f7a1`) first, then the handoff.

## Correctness — checked, nothing found

- **Both call sites verified by reading, not assumed.** `reshapeBackingInPlace` computes
  the preview from `live` *after* the pre-reconcile structural batch;
  `attachMaintainedDerivation` does the same after its own (differently-rolled-back)
  pre batch. The handoff's own checklist item — "confirm the by-name mapping holds on
  the attach arm" — holds: `backingColumnDef` (line 3187) carries both `dataType` and a
  `collate` constraint through a `rename`, and an `add` lifts the shape column's own
  attributes, so the live column list the preview maps from already agrees with the
  target on names, order, and every attribute the preview does not override.
- **`Object.freeze` on the array but not the cloned columns** — a non-issue, not a
  latent bug. The only in-place `ColumnSchema` mutation in this file is
  `buildBackingTableSchema` stamping `primaryKey`/`pkOrder` onto `shape.columns` at
  backing-*create* time (line 332); nothing mutates the columns of a record registered
  via `schema.addTable`, which is all the constraint-stripped clone ever is.
- **Undefined-when-unshifted cannot mis-report.** `previewReshapedColumns` uses the same
  two predicates (`backingTypeMatches` / `backingCollationMatches`) that
  `classifyBackingReshape.recordAttrShift` uses to *queue* the `retype` / `recollate`
  ops, so "shift detected" and "op will run" are the same test on the same inputs.
- **Physical-PK claim confirmed by reading `describePhysicalPkChange` (line 2341)**: a
  key column's type or collation change makes the reshape inexpressible, so a previewed
  attribute cannot desynchronize the key encoding.

## Test coverage — three gaps the handoff named, all closed

The implementer flagged these honestly; all four new tests were **verified to fail when
the preview is disabled** (temporarily forced `previewReshapedColumns` to return
`undefined`, ran the spec, reverted), so they pin the fix rather than merely passing.

- **The attach arm had no direct test.** Added two: `alter table … set maintained as`
  over a body whose column retypes (TEXT → INTEGER) and recollates (BINARY → NOCASE),
  each rejecting an attribute-sensitive CHECK violator. Both assert the state the
  code comment claims — the rejection precedes the attach's eager `conn.commit()`, so
  `reconcileCommitted` is false and the table reverts to an ordinary, untouched table
  at its original attributes — then re-attach after correcting the source and assert the
  attribute flip as proof the reshape arm ran.
- **FK constraints across a reshape were untested.** Added: a declared child-side FK
  still rejects a genuine orphan across a retype reshape of a *different* column.
- **Multi-column / mixed reshapes were untested.** Added: a reshape mixing a
  pre-reconcile `add` with a `retype` on another column, exercising the by-name mapping
  over a live column list the structural batch has already grown.

Remaining gap, deliberately not chased: an FK whose *match outcome* flips under a
previewed collation. Which side's collation should govern an FK comparison is a
separate, unsettled semantics question — inventing an assertion for it here would pin a
guess. The added FK test covers the plumbing (the FK validator runs and rejects on the
reshape arm) without asserting on that.

## Docs — one stale claim found and fixed

The handoff grepped `docs/` for the *old limitation* wording and correctly found
nothing. It missed a second staleness in the opposite direction: `docs/runtime.md:1074`
still read "This harness is **not** yet in the root `yarn check` chain — it has three
known failures, all one root cause (`tickets/fix/bug-mv-reshape-validates-contents-before-retype`)",
naming this very ticket, while the same commit added `test:repr-strict` to that chain.
Rewritten to state it runs in the chain alongside `test:fork-strict` /
`test:context-strict`. `docs/materialized-views.md` line 208 and `docs/types.md` were
re-read and are accurate.

## Source hygiene — two stale comments fixed

Both attribute-**insensitive** control tests still described themselves as scoping "the
limitation" — language left over from when these blocks characterized a known-open
corner. Rewritten to say what they now pin: the preview cannot change a
type/collation-independent CHECK's outcome, so the ordinary validation path is
undisturbed.

`materialized-view-helpers.ts` is 3214 lines (`wc -l`). Not filed — the site is already
claimed by `tickets/backlog/debt-oversized-source-files.md`.

## Tripwire parked (not a ticket)

One added, at `previewReshapedColumns` in
`packages/quereus/src/runtime/emit/materialized-view-helpers.ts`: the preview
**re-derives** the attribute shift from live-vs-shape rather than reading
`ReshapePlan.postReconcileOps`, the authoritative list of ops that will actually run.
The two agree today because every pre-reconcile structural op preserves attributes
exactly; if one ever stops, the preview would declare an attribute no op lands and the
scan would reject rows the finished reshape accepts. Build the preview from
`postReconcileOps` then.

The implementer's two existing `NOTE:` tripwires (value-rewriting conversions; the
representation checker now firing at this scan) were re-read and left as-is — both are
correctly conditional and correctly sited.

## New tickets filed: none

Every finding was minor and fixed in this pass. Nothing rose to a class of defect
needing a type change, a property test, or a boundary invariant, so nothing was filed
at a higher rung either.

# Validation

All from repo root:

| command | result |
| --- | --- |
| `maintained-table-refresh-revalidation.spec.ts` under `QUEREUS_REPR_STRICT=1` | **27 passing, 0 failing** (23 before review, 4 added) |
| same spec with the preview forced off (mutation check, reverted) | 8 failing — including all 4 new tests |
| `yarn test` (all workspaces) | pass, 0 failing (6m 27s); quereus 9082 passing / 25 pending |
| `yarn test:repr-strict` | **9091 passing, 0 failing**, 16 pending |
| `yarn lint` | clean |
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn docs:check` | `Docs OK` |

`yarn test:store` was not re-run in review — the implement stage ran it clean (9070
passing, 0 failing) and this pass changed no source behaviour, only comments, docs, and
tests. The `[TransactionCoordinator] … savepoint depth out of range` lines that run
emits are pre-existing log noise on that backend, not failures.
