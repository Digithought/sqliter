---
description: Writing to a table that declares mutation-context variables without supplying them used to report a confusing "isn't a column" error; it now names the table and the variable, and variables declared NULL may be left out entirely.
files:
  - packages/quereus/src/planner/building/mutation-context.ts     # NEW — the one place context attributes/symbols/values are built
  - packages/quereus/src/planner/building/insert.ts               # ~735-760, registration + value build
  - packages/quereus/src/planner/building/update.ts               # ~125-128
  - packages/quereus/src/planner/building/delete.ts               # ~125-128
  - packages/quereus/src/planner/building/constraint-builder.ts   # ~70-140 (CHECK scope), ~237-270 (NOT NULL DEFAULT scope)
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # ~205-270 (child side), ~322-410 (parent side)
  - packages/quereus/src/runtime/emit/dml-executor.ts             # ~394-408, invariant assertion
  - packages/quereus/src/runtime/emit/constraint-check.ts         # ~30-45, invariant assertion (skip branch removed)
  - packages/quereus/test/logic/46-mutation-context.sqllogic      # Tests 16-25 added
  - packages/quereus/test/mutation-context.spec.ts                # exact error-message assertions
  - docs/sql-ddl.md                                               # § 2.6.2, new "Which variables a statement must supply"
  - docs/sql-dml.md                                               # `with context` bullets on INSERT / UPDATE / DELETE
  - docs/vu-mutation-context.md                                   # new "Forwarding: one envelope, many base tables"
difficulty: medium
---

# Mutation context: schema-driven diagnosis, and genuinely optional NULL variables

## What changed, in plain terms

A table can declare **mutation-context variables** — per-statement parameters its
column DEFAULTs and CHECK constraints read, written `context.<name>` or bare `<name>`.
A statement supplies them with a `with context <name> = …` clause.

Two problems, both fixed:

1. **Wrong diagnosis.** Writing to such a table without the clause failed with
   `context.OwnerKey isn't a column` — a *column resolution* message for what is really
   a *missing statement argument*, sending the reader to the table definition instead of
   to their own statement. It now reports:

   ```
   table 'main.Revocation' requires mutation context variable 'OwnerKey'; supply it with `with context OwnerKey = …`
   ```

2. **NULL-marked variables were not actually optional.** The docs said to "mark optional
   context variables as NULL", but once a statement carried an envelope at all, leaving
   *any* declared variable out threw `Missing mutation context value for '<name>'` with
   `StatusCode.INTERNAL` — an engine-invariant error for plain user input. A variable
   declared `null` may now be omitted and reads NULL.

Fail-closed behavior is unchanged: a NOT NULL variable that a default or constraint
actually reads is still mandatory, and the statement still fails at plan time.

## How it works now

`TableSchema.mutationContext` (the declaration), not `stmt.contextValues` (the
statement), drives everything. New module `planner/building/mutation-context.ts` is the
single place that builds attributes, registers symbols, and builds value expressions;
the three DML builders and both constraint/FK builders call into it instead of each
open-coding the same loop.

- **Registration** happens whenever the table declares context variables, envelope or
  not. So a CHECK reading `context.X` always binds.
- **Values**: one entry per declared variable, in declaration order — the supplied value
  expression, or a NULL literal when the statement omitted it. Alignment between the
  evaluated context row and `contextDescriptor` is therefore *structural*, not an
  external invariant, which is what let the runtime's two "missing value" branches
  become plain internal assertions.
- **The error fires at reference time, not registration time.** A NOT NULL variable with
  no supplied value registers a resolver that throws when an expression actually reads
  it. This is deliberate: a table may declare a variable that a given statement's
  defaults and constraints never touch (e.g. an INSERT-scoped CHECK on a DELETE
  statement), and those writes legitimately need no envelope.
- **Undeclared supplied names are still silently ignored**, as before. This is
  load-bearing for view-mediated writes: decomposition forwards one envelope verbatim to
  every member base table, and members disagree about what they declare.

## Use cases to exercise

All of these are in `test/logic/46-mutation-context.sqllogic` (Tests 16-25) and
`test/mutation-context.spec.ts`, but they are the shapes worth poking at by hand:

| Scenario | Expected |
|---|---|
| CHECK reads a NOT NULL variable; statement omits the whole `with context` clause | plan-time error naming table + variable |
| Same, but the envelope is present and omits just that one variable | identical message (not `INTERNAL`) |
| Omit a `null`-marked variable | succeeds; the variable reads NULL |
| CHECK comparing against an omitted `null`-marked variable | *unknown* ⇒ passes (ordinary SQL NULL comparison). `coalesce(<cmp>, 0)` to reject |
| Table declares a variable no default/constraint of this statement reads; no envelope | succeeds |
| DELETE against a table whose only CHECK is INSERT/UPDATE-scoped; no envelope | succeeds |
| Supply a name the table does not declare | ignored, no error |
| Write through a view whose member table declares a NOT NULL variable the envelope omits | error names the **member** table, not the view |
| NOT NULL column whose DEFAULT reads an omitted `null`-marked variable | ordinary `NOT NULL constraint failed: <table>.<col>` |
| Deferred CHECK + omitted `null`-marked variable, evaluated at COMMIT | NULL survives the capture |
| `insert … on conflict do update` on a table with an UPDATE-scoped CHECK reading context | same rules on the upsert arm |

## Behavior changes a reviewer should weigh

**1. Column shadowing now applies to envelope-less writes.** Context variables shadow
same-named columns — documented, and unchanged when an envelope is supplied. But since
symbols are now registered without an envelope too, a *bare* `foo` in a DEFAULT or CHECK
on a table declaring a context variable `foo` resolves to the **variable** (reading NULL
if it is optional) where it previously fell through to the **column**. `new.foo` /
`old.foo` still reach the column. Pinned by Test 22 in the sqllogic file. This is the
change most likely to surprise an existing schema.

**2. A latent duplicate-symbol crash was fixed along the way.** `buildConstraintChecks`
and both FK builders registered context variables and then registered the unqualified
column name *unconditionally* — so a table with a CHECK (or an FK) plus a context
variable sharing a column's name threw `Symbol 'x' already exists in the same scope.`
That was reachable *today* with an envelope supplied; the registration change would have
widened it to every write. Those three sites now skip the bare column form when a
context variable claims the name, matching what `buildNotNullDefaults` already did.
Worth confirming the fix is right rather than merely quieting the crash.

**3. Value expressions for undeclared supplied names are no longer built.** Previously
every assignment in the clause was planned (and then dropped at emit time if the table
did not declare it). Now only declared variables are planned. Upside: view decomposition
stops re-planning a forwarded subquery value expression once per member that doesn't
declare it. Downside: a *planning* error inside an undeclared assignment's expression
(e.g. an unresolvable column reference) is no longer surfaced. Given the contract is
"undeclared names are ignored", this seems right, but it is a real, if narrow, loss of
error reporting and is not covered by a test.

**4. Supplied names are now matched case-insensitively** against the declaration. Before,
`with context ownerkey = …` against a declared `OwnerKey` silently missed and threw the
INTERNAL "missing value" error. Now it matches, like every other identifier in the
language. No test pins this specifically.

## Known gaps

- **Nothing enforces NOT NULL on a *supplied* context value at runtime.** `with context
  OwnerKey = null` on a NOT NULL variable is accepted and reads NULL. Pre-existing, out
  of the ticket's scope, and recorded as a `NOTE:` tripwire at the attribute-construction
  site in `mutation-context.ts` (the attribute claims `nullable: false`, which is a
  static-type claim the runtime does not back). It only becomes a defect if an optimizer
  rule ever folds on a context attribute's nullability.
- **`test:store` was not run** — only `yarn test` (the agent default). The change is
  planner/emit-level with no storage-module surface, so the store path is not expected to
  differ, but that is reasoning, not evidence.
- **A typo'd context variable name reads as NULL** instead of being reported. That is the
  price of the ignore-undeclared-names contract that view forwarding depends on; the
  original ticket flagged it as separate work if it is worth fixing, and it still is.
- Test coverage for case-insensitive supplied-name matching and for change (3) above is
  absent — see the two bullets in *Behavior changes*.

## Validation run

- `yarn test` — full workspace suite, **0 failing** (9201 passing in `packages/quereus`
  alone, plus every other package). No pre-existing failures encountered.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `yarn build` — clean.
- `test/logic/46-mutation-context.sqllogic` grew from 15 to 25 tests; all pass.
- `test/mutation-context.spec.ts` grew from 1 to 7 tests; all pass.
