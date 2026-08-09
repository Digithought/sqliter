---
description: Writing to a table that declares mutation-context variables without supplying them used to report a confusing "isn't a column" error; it now names the table and the variable, and variables declared NULL may be left out entirely.
files:
  - packages/quereus/src/planner/building/mutation-context.ts     # NEW — the one place context attributes/symbols/values are built
  - packages/quereus/src/planner/building/insert.ts               # ~735-760, registration + value build
  - packages/quereus/src/planner/building/update.ts               # ~125-128
  - packages/quereus/src/planner/building/delete.ts               # ~125-128
  - packages/quereus/src/planner/building/constraint-builder.ts   # CHECK scope, NOT NULL DEFAULT scope
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # child side, parent side
  - packages/quereus/src/runtime/emit/dml-executor.ts             # invariant assertion
  - packages/quereus/src/runtime/emit/constraint-check.ts         # invariant assertion, per-row concat tripwire
  - packages/quereus/test/logic/46-mutation-context.sqllogic      # Tests 16-25
  - packages/quereus/test/mutation-context.spec.ts                # exact error-message assertions
  - docs/sql-ddl.md                                               # § 2.6.2, "Which variables a statement must supply"
  - docs/sql-dml.md                                               # `with context` bullets on INSERT / UPDATE / DELETE
  - docs/vu-mutation-context.md                                   # "Forwarding: one envelope, many base tables"
---

# Mutation context: schema-driven diagnosis, and genuinely optional NULL variables

A table can declare **mutation-context variables** — per-statement parameters its column
DEFAULTs and CHECK constraints read, written `context.<name>` or bare `<name>`. A
statement supplies them with a `with context <name> = …` clause.

Two problems were fixed:

1. **Wrong diagnosis.** Writing to such a table without the clause failed with
   `context.OwnerKey isn't a column` — a *column resolution* message for what is really a
   *missing statement argument*. It now reports
   `table 'main.Revocation' requires mutation context variable 'OwnerKey'; supply it with
   \`with context OwnerKey = …\``.

2. **NULL-marked variables were not actually optional.** Leaving a declared variable out
   of a supplied envelope threw `Missing mutation context value for '<name>'` with
   `StatusCode.INTERNAL` — an engine-invariant error for plain user input. A variable
   declared `null` may now be omitted and reads NULL.

Fail-closed behavior is unchanged: a NOT NULL variable that a default or constraint
actually reads is still mandatory, and the statement still fails at plan time.

## How it works

`TableSchema.mutationContext` (the declaration), not `stmt.contextValues` (the
statement), drives everything. `planner/building/mutation-context.ts` is the single place
that builds attributes, registers symbols, and builds value expressions; the three DML
builders and both constraint/FK builders call into it instead of open-coding the loop.

- **Registration** happens whenever the table declares context variables, envelope or
  not, so a CHECK reading `context.X` always binds.
- **Values**: one entry per declared variable, in declaration order — the supplied value
  expression, or a NULL literal when the statement omitted it. Alignment between the
  evaluated context row and `contextDescriptor` is therefore *structural*, which is what
  let the runtime's two "missing value" branches become plain internal assertions.
- **The error fires at reference time, not registration time.** A table may declare a
  variable that a given statement's defaults and constraints never touch (an
  INSERT-scoped CHECK on a DELETE statement), and those writes legitimately need no
  envelope.
- **Undeclared supplied names are still silently ignored.** This is load-bearing for
  view-mediated writes: decomposition forwards one envelope verbatim to every member base
  table, and members disagree about what they declare.

## Behavior changes

- **Column shadowing now applies to envelope-less writes.** A *bare* `foo` in a DEFAULT
  or CHECK on a table declaring a context variable `foo` resolves to the **variable**
  (reading NULL if optional) where it previously fell through to the **column**.
  `new.foo` / `old.foo` still reach the column. Pinned by Test 22.
- **A latent duplicate-symbol crash was fixed.** `buildConstraintChecks` and both FK
  builders registered context variables and then registered the unqualified column name
  unconditionally, so a table with a CHECK (or FK) plus a context variable sharing a
  column's name threw `Symbol 'x' already exists in the same scope.` Reachable *today*
  with an envelope supplied. Those three sites now skip the bare column form when a
  context variable claims the name, matching `buildNotNullDefaults`.
- **Value expressions for undeclared supplied names are no longer built.** Upside: view
  decomposition stops re-planning a forwarded subquery value expression once per member
  that doesn't declare it. Downside: a *planning* error inside an undeclared assignment's
  expression is no longer surfaced.
- **Supplied names are matched case-insensitively** against the declaration.
- **Duplicate supplied names are rejected** (added in review — see below).
- **A context value that reads a context variable is now an unresolved-column error on
  INSERT too** (added in review — see below).

## Known gaps carried forward

- **Nothing enforces NOT NULL on a *supplied* context value at runtime.** `with context
  OwnerKey = null` on a NOT NULL variable is accepted and reads NULL. Pre-existing;
  recorded as a `NOTE:` tripwire at the attribute-construction site in
  `mutation-context.ts`. Confirmed still true in review (probe: a NOT NULL `cap` supplied
  as `null` reaches the CHECK as NULL).
- **A typo'd context variable name reads as NULL** instead of being reported — the price
  of the ignore-undeclared-names contract that view forwarding depends on.
- **`test:store` was not run**, in implement or in review. The change is planner/emit
  level with no storage-module surface, but that is reasoning, not evidence.

---

# Review findings

Reviewed the implement diff (`d47a1284`) before the handoff summary, then read every
touched source file plus the sites the change *should* have touched
(`derived-row-validator.ts`, `createRowExpansionProjection`, `RegisteredScope`,
`deferred-constraint-queue.ts`, the emitters that consume `contextDescriptor`). Behaviors
were probed against a live `Database` — a scratch spec was used for exploration and
deleted; the findings worth keeping became permanent tests.

Note: commit `d47a1284` also contains unrelated in-flight work (constraint-name
disambiguation across `schema/table.ts`, `schema/catalog.ts`, `schema/manager.ts`,
`runtime/emit/alter-table.ts`, and `test/logic/41.7-…`, plus four ticket files). That is
another ticket's diff swept into the same commit; it was not reviewed here.

## Fixed in this pass (minor)

- **`with context cap = 1, cap = 2` silently took the last value.** Both sibling
  assignment lists already reject duplicates (`column 'a' specified more than once in
  INSERT into …`, `duplicate assignment to column 'a' in UPDATE on …`); the third one did
  not, so a typo picked a value instead of being reported. Now rejected with
  `mutation context variable '<name>' supplied more than once`, case-folded, and checked
  for every DML statement including tables that declare no context at all. The
  case-folded index it builds is now shared by the attribute builder and the value
  builder, which had two copies of the same loop.
- **A context value reading a context variable failed at runtime with an opaque
  message.** `insert … with context base = 5, cap = base` resolved `base` into the
  context scope and then died at runtime with `No row context found for column base` — a
  context value expression is evaluated to *build* the context row, so it cannot read
  that row, in either declaration order. UPDATE and DELETE already reported the ordinary
  `Column not found: base`. INSERT's value expressions now build against the
  produced-row NEW context (still threaded for synthetic member inserts) rather than
  against `contextScope`, so all three agree. This also corrects the comment the
  implementer left at that site, which claimed the context scope was there "so one
  context value can be written in terms of another" — that never worked.
- **Docs.** `docs/sql-ddl.md` § 2.6.2 gained the case-insensitive-matching rule, the
  duplicate-name rejection, the no-cross-reference rule, and an explicit note that a
  planning error inside an unread assignment goes unreported. The rest of the
  implementer's doc changes were verified against the code rather than trusted — the
  `default_column_nullability` claim added to the nullability bullet is correct (the
  option defaults to `not_null` and `mutationContextVarToSchema` takes it).

## Filed as a new ticket (major)

- **`tickets/backlog/bug-maintained-table-context-vars-unresolvable.md`** — a maintained
  table (`create table … maintained as …`) may declare `with context (…)`, but its rows
  are engine-derived, so no statement can ever supply the envelope. `derived-row-validator.ts`
  builds the table's CHECK / FK expressions with no context attributes, so a constraint
  reading one fails with `Column not found: cap` — the exact misdiagnosis this ticket set
  out to kill, in the one path the fix did not reach. Verified by repro. Filed at the
  representation rung rather than as a message fix: the ticket asks for the combination
  to be rejected at DDL time, which retires CHECK, FK, and DEFAULT together. No open
  ticket claimed those sites (`debt-maintained-validator-rebuild-fallbacks-untested`
  touches the same file but a different concern).

## Recorded as tripwires, not tickets

- **Per-row context concatenation widened.** Once a context row exists, the constraint
  checker's row getter concatenates it onto the visible row on each lookup. Because
  attributes now come from the declaration rather than the envelope, that applies to
  *every* write to a context-declaring table, not only ones carrying `with context`.
  Cheap at realistic declaration sizes; `NOTE:` at
  `runtime/emit/constraint-check.ts:113` says what to do if a bulk envelope-less write
  ever profiles slow.
- **`nullable: false` on a context attribute is a static claim the runtime does not
  back.** The implementer's existing `NOTE:` in `mutation-context.ts` was verified live
  (a NOT NULL variable supplied as `null` is accepted) and left in place — it states the
  revisit condition correctly.

## Coverage added

Filling the two holes the handoff named as absent, plus the two new rules:

- case-insensitive supplied-name matching (`ownerkey` supplying a declared `OwnerKey`,
  and a wrong-cased value reaching the CHECK)
- the undeclared-assignment contract: `junk = no_such_column` alongside a valid
  assignment is accepted, pinning that its expression is never planned
- duplicate supplied name rejected, exact message
- context value reading a context variable → `Column not found` on all three of INSERT,
  UPDATE, DELETE

`test/mutation-context.spec.ts` is now 11 tests (was 7 after implement, 1 before).

## Checked and found clean

- **Descriptor alignment.** `contextDescriptor[attr.id] = index` against a context row
  built in `plan.contextAttributes` order — one slot per declared variable, always
  filled. The two emit-time branches are now genuine assertions rather than the external
  invariant the old comment admitted to.
- **No vtab surface change.** The context row reaches constraint evaluation and the
  deferred-constraint queue only; it is never part of the row handed to `vtab.update`.
- **Shadowing skips.** `buildConstraintChecks`, both FK builders, and
  `buildNotNullDefaults` now agree on skipping the bare column form for a name a context
  variable claims, and only the bare form — `new.<col>` / `old.<col>` stay registered, so
  the shadowed column stays reachable. Verified for the DELETE/OLD side as well as
  INSERT/UPDATE.
- **`RegisteredScope` never enumerates its callbacks during resolution**, so the
  throw-on-reference resolver for an unsupplied NOT NULL variable cannot fire
  spuriously from a wildcard expansion.
- **`alter table … add constraint check (…)` reading a context variable** builds and
  enforces correctly (probed) — the schema-driven registration reaches that path.
- **A NOT NULL variable read only by an op the statement is not performing** stays
  optional (probed: `check on insert` + `delete` needs no envelope).
- **Envelope forwarding through view decomposition** never synthesizes `contextValues`;
  every one of the ~30 sites forwards `stmt.contextValues` verbatim, so the duplicate
  rejection added above can only fire on user-written text.
- **Lint, tests, build.** `yarn workspace @quereus/quereus run lint` clean (eslint +
  `tsc -p tsconfig.test.json --noEmit`); `yarn test` 0 failing across the workspace
  (9205 passing in `packages/quereus`); `yarn build` clean. No pre-existing failures
  encountered, so `tickets/.pre-existing-error.md` was not written.

## Considered and not pursued

- **Rejecting a NULL value supplied for a NOT NULL context variable at runtime.** The
  site carries an accepted-tradeoff-shaped `NOTE:` with a stated revisit condition (an
  optimizer rule folding on a context attribute's nullability) that has not tripped.
  Left alone.
- **Reporting a typo'd (undeclared) context variable name.** Directly contradicts the
  ignore-undeclared-names contract that view forwarding depends on; the original ticket
  already flagged it as separate work, and it still is.
- **The INSERT-only `contextScope` parenting on `defaultRowContextScope`.** UPDATE and
  DELETE build context values in the plain base scope and have no member-insert analogue
  to thread, so the asymmetry is structural rather than an oversight. It no longer
  affects diagnostics now that the cross-reference case is unified.
