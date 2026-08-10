description: Fixed a bug where updating a row in a table with an auto-computed column defined by a sub-query stored a meaningless placeholder instead of the computed number; regression tests added and reviewed.
files:
  - packages/quereus/src/runtime/emit/update.ts                      # the fix (phase-2 generated-column recompute)
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic  # regression coverage, sections 6, 7, 8
  - docs/determinism.md                                              # "deterministic does not imply synchronous" note
  - docs/runtime.md                                                  # § Pattern 2 — when NOT to use the sync helper
repro: verified

# UPDATE stored a Promise in a generated column whose expression is a sub-query

## What was wrong

A generated column (`generated always as (…)`) whose expression contains a scalar
sub-query computed correctly on `insert`, but any later `update` of the same row replaced
it with a value that serialised as `{}` — a raw `Promise` object written straight into the
row and stored.

The generated-column recompute in `emitUpdate` (phase 2) called each assignment evaluator
*without* awaiting it, justified by a comment asserting that a deterministic generated
expression "cannot contain scalar subqueries and always return synchronously". That premise
was false: `validateDeterministicGenerated` only rejects `random()` / `now()`-style
non-determinism, and a sub-query over a table is perfectly deterministic within a
statement — so it passes the gate and its evaluator returns a `Promise`.

## What changed

`packages/quereus/src/runtime/emit/update.ts`:

- Phase 2 now uses `withAsyncRowContext` and awaits each evaluator.
- Added `generatedRowDescriptor` — a distinct descriptor object carrying the same
  attribute IDs as `sourceRowDescriptor`. `RowContextMap` is keyed by descriptor
  *identity*, so reusing `sourceRowDescriptor` meant the phase-2 teardown deleted the
  update emitter's own streaming slot registration. Hygiene, not the bug fix — it removes
  reliance on the underlying scan happening to backstop the lookup.
- Replaced the false comment; added a `NOTE:` tripwire that both phases use a bare `await`
  (a microtask per evaluator even when synchronous) and what to switch to if UPDATE row
  throughput ever shows up as hot.

`docs/determinism.md`: callout that deterministic does not imply synchronous.

`docs/runtime.md` § Pattern 2: `withAsyncRowContext` is the default; `withRowContext` only
when the callee is provably synchronous, which an emitted scalar evaluator is not. Added
during review — see findings.

`test/logic/41-generated-column-extras.sqllogic`: sections 6 and 7 (implement), section 8
(review).

- **§ 6** — `t_src` (3 rows) + `t_sub` with `g generated always as ((select count(*) from t_src))`.
  Pins `insert` (always worked); asserts `update t_sub set w = 5 where id = 1` leaves `g = 3`,
  not `{}` — the assertion that fails without the fix; asserts a later update recomputes to `5`
  after two more rows land in `t_src` (so the value is genuinely re-evaluated, not carried
  forward); and a multi-row `update` with no `where`.
- **§ 7** — chained across the async path: `g` from a sub-query, `g2 generated always as (g * 2)
  stored`. Confirms the topological-order recompute still feeds the freshly-awaited `g` into
  `g2`. Uses the `stored` spelling where § 6 uses the bare one.
- **§ 8** (added in review) — correlated sub-query generated column over a multi-row `update`.

Manual repro, unchanged:

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);
create table ug (id integer primary key, w integer,
                 g integer generated always as ((select count(*) from c)));
insert into ug (id, w) values (1, 1);
update ug set w = 5 where id = 1;
select id, w, g from ug;   -- was [{"id":1,"w":5,"g":{}}], now [{"id":1,"w":5,"g":3}]
```

## Review findings

Read the implement diff (c18352fc) before the handoff summary. The core fix is correct and
minimal, the negative control the implementer ran is real (reverting phase 2 reproduces
`g: {}`), and the descriptor-identity reasoning about `RowContextMap` checks out against
`runtime/context-helpers.ts`.

### Fixed in this pass (minor)

- **Test gap: nothing exercised the phase-2 row context on the async path across more than
  one row.** Sections 6 and 7 both use an *uncorrelated* sub-query — its evaluation never
  reads the row context phase 2 installs, so the `generatedRowDescriptor` change had no
  coverage at all from § 6; § 7's `g2 = g * 2` does read it, but only for a single row, which
  is exactly the case where the old descriptor reuse was masked (the teardown only breaks
  iterations 2+). Added **§ 8**: a correlated generated column
  (`(select count(*) from t_src3 where t_src3.k <= id)`) over a three-row `update` with no
  `where`. Passes. The other table's column must be qualified — an unqualified name inside a
  generated expression is read as a reference to the declaring table and rejected at create
  time; the test comment says so and points at `docs/sql-alter.md`.
- **`docs/runtime.md` § Pattern 2 was the doc that invited this bug and was left untouched.**
  It presents `withRowContext` and `withAsyncRowContext` as interchangeable by shape, and
  names "DML context setup" as a `withRowContext` use case — the exact call this ticket had
  to convert. Added a paragraph: prefer the async helper; the sync one only when the callee
  is provably synchronous, which an emitted scalar evaluator is not, since a DDL-authored
  expression may embed a sub-query. Also records that `withRowContext` now has zero `src/`
  callers, which resolves the implementer's open question about deleting it — the doc
  documents it as a public helper, so it stays, now with an honest note.
- `docs/determinism.md` cross-reference updated from § 6–7 to § 6–8.

### Filed as a new ticket (major)

- **`tickets/fix/bug-upsert-do-update-ignores-generated-columns.md`** — found by probing
  neighbouring DML paths, which the handoff listed as "reasoned about, not all tested".
  `insert … on conflict … do update set …` **never recomputes generated columns at all**, and
  additionally **accepts an assignment to one**, which a plain `update` rejects. Both
  reproduce with a purely synchronous `g generated always as (w * 2)`, so this is not the
  async defect wearing a different hat — it is a separate, wholly missing behaviour.
  Root cause is one site: the upsert branch of `planner/building/insert.ts` builds only the
  user's SET list, inheriting neither the generated-column rejection nor the
  `generatedColumnTopoOrder` implicit assignments that `planner/building/update.ts` appends.
  Pre-existing — this ticket's diff never reaches that path. Verified by hand against the
  sqllogic runner; the board carries no other ticket touching that file.

### Investigated, no action

- **Self-referencing generated sub-query** (`g generated always as ((select count(*) from
  <own table>))`), listed as uninvestigated in the handoff. Probed insert and update on a
  two-row table: no hang, no Promise leak, no error — the sub-query consistently sees the
  pre-statement row set (`g = 0` for the first inserted row, `g = 2` when updating a row of a
  two-row table). Odd schema, but the semantics are self-consistent and no worse than any
  other read-your-own-writes question in the engine. Not pinned as a test, because doing so
  would freeze a semantic nobody has decided on.
- **`ALTER TABLE ADD COLUMN` backfill of a sub-query generated column**, the handoff's other
  open question. `runtime/emit/alter-table.ts:688` already uses
  `valueRaw instanceof Promise ? await valueRaw : valueRaw`, so the path is correct by
  construction; the missing test is a coverage nicety, not a defect, and the `docs/sql-alter.md`
  unqualified-column limitation recorded there is a separate pre-existing restriction that
  this ticket does not touch.
- **`generatedRowDescriptor!` non-null assertion.** Guarded by the same
  `generatedIndices.length > 0` condition that constructs it, and mirrors the existing
  `coerceGenerated` pattern three lines above. Left as is for consistency.
- **The `NOTE:` tripwire the implementer left** (bare `await` costs a microtask per
  synchronous evaluator; switch both phases to the `instanceof Promise` idiom if UPDATE
  throughput turns hot) was checked: the idiom it points at genuinely exists at
  `runtime/emit/constraint-check.ts:176` and elsewhere. Correctly parked as a comment rather
  than a ticket — it is conditional, not latent.
- **Source hygiene.** `runtime/emit/update.ts` is 145 lines with one exported function; no
  split warranted. Comment density in the phase-2 block is high but every line earns its
  place (the false comment that caused this bug is the argument for keeping the correction
  explicit).

### Not covered, deliberately

- **`yarn test:store` (LevelDB backend) not run**, same as the implement stage. The fix is in
  the emitter, above the storage layer, and the new § 8 test adds no storage-shaped
  behaviour. This is a standing gap in the agent-runnable validation set, not specific to
  this ticket.
- **Generated columns under UNIQUE / PRIMARY KEY on the async path** (§ 4–5 cover the
  synchronous case only). Still untested. A sub-query-valued UNIQUE column is a schema
  nobody writes; judged not worth a ticket. Recorded here so it is not mistaken for covered.
- **Sub-query generated column inside an explicit transaction.** Untested. The self-reference
  probe above is the nearest thing and behaved consistently; no reason found to suspect a
  transaction-specific defect, so no ticket.

## Validation

- `yarn lint` (repo-wide) — clean.
- `yarn typecheck` (repo-wide) — clean.
- `yarn test` — **8674 passing, 13 pending, 0 failing** in `@quereus/quereus`; all other
  workspaces green. Section 8 is inside the existing sqllogic file, so the count is unchanged
  from the implement stage by design.
- `node packages/quereus/test-runner.mjs --grep 41-generated-column` — passing.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
