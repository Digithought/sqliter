---
description: Fixed a debugging helper (`execution_trace()`) that used to hang forever instead of returning results, guarded the deadlock class at the shared factory, and added tests covering all five SQL-taking diagnostic helpers.
files:
  - packages/quereus/src/func/builtins/explain.ts        # collectSchedulerProgram() extracted; scheduler_program + execution_trace share it; statement finalize moved to finally
  - packages/quereus/src/func/registration.ts             # NOTE on createIntegratedTableValuedFunction: TVF bodies run under the exec mutex
  - packages/quereus/test/core/diagnostic-tvfs.spec.ts    # all five SQL-taking diagnostic TVFs, happy + unplannable-SQL paths, short timeout
  - packages/quereus/test/runtime/scalar-fusion.spec.ts   # stale NOTE replaced with a real execution_trace() assertion; timeout 20s -> 5s
  - docs/runtime.md                                       # debug-introspection wording updated to the shared-helper reality
---

# `execution_trace()` no longer deadlocks

## What changed (implement stage)

`execution_trace('<sql>')` used to hang forever. Root cause: it ran a nested
`db.eval('SELECT * FROM scheduler_program(?)', [sql])` from inside its own
generator body. A table-valued function body executes *inside* the statement
that invoked it, under the same single exec mutex
(`Database._acquireExecMutex`) that statement already holds. The nested
`db.eval` queued behind that mutex and could never be granted — nothing
threw, it just sat forever.

Fix: the instruction-listing logic both `scheduler_program` and
`execution_trace` need was extracted into one in-process helper,
`collectSchedulerProgram(db, sql)`, in
`packages/quereus/src/func/builtins/explain.ts`. It calls `db.getPlan` →
`EmissionContext` → `emitPlanNode` → `Scheduler` directly (all mutex-free),
returning `SchedulerProgramEntry[]`. `scheduler_program()` maps those entries
to its six-column tuples; `execution_trace()` calls the helper directly
instead of going through SQL.

Class guards: a `NOTE:` on `createIntegratedTableValuedFunction` in
`packages/quereus/src/func/registration.ts` — the single factory every
integrated TVF body is defined through — stating the constraint and the
mutex-free alternatives, plus a shorter one at `collectSchedulerProgram`
itself. And `packages/quereus/test/core/diagnostic-tvfs.spec.ts`, exercising
all five SQL-taking diagnostic TVFs end-to-end with short per-test timeouts,
so a reintroduced nested query fails a named test instead of hanging an
unrelated caller.

`execution_trace`'s two `console.warn` calls were routed through the module's
`createLogger('func:builtins:explain')` logger. The stale NOTE in
`packages/quereus/test/runtime/scalar-fusion.spec.ts` — which said
`execution_trace()` couldn't be exercised end-to-end because of this
deadlock — was replaced with a real assertion, and that describe block's
timeout dropped from 20s to 5s.

An engine-level guard (make `db.eval` throw instead of hang when the mutex is
already held by the current call chain) was considered and rejected in the
original fix ticket: it needs `AsyncLocalStorage`-style async-context tracking
to distinguish "nested inside the holder" from "legitimately queued behind
it", which isn't available on the browser/React Native targets this engine
supports. Not revisited in review.

## Review findings

### Checked

Read the implement diff before the handoff summary. Verified the deadlock
class is actually gone repo-wide (`db.eval`/`db.exec` inside any TVF body:
grep across `src/func/` — the only two remaining hits are the NOTE prose
itself). Confirmed the `NOTE:` placement decision the implementer flagged for
review is correct rather than under-applied: only *integrated* TVFs receive a
`db` handle at all — `createTableValuedFunction`'s `jsFunc` signature has no
database parameter — so `createIntegratedTableValuedFunction` is the complete
seam, and no per-body duplication is warranted. Same reason `docs/plugins.md`
(the TVF-authoring doc, which covers plugin-registered non-integrated TVFs)
needs no note. Checked `docs/functions.md`, `docs/usage.md`,
`docs/sql-functions.md`, `docs/stability.md`, `docs/optimizer-retrieve.md`,
and `packages/quereus/README.md` against the new reality — all accurate as
written. Ran the diagnostics end-to-end under a probe spec (deleted
afterward) to see actual output rather than trusting the assertions.

### Fixed in this pass (minor)

- **Prepared statements leaked on the tracing failure path.** Both
  `executionTraceFunc` and `rowTraceFunc` called `stmt.finalize()` as the last
  line of a `try` whose `catch` swallows execution failures — so a query that
  failed mid-trace (exactly the case those catches exist for) left the
  statement unfinalized and registered with the database. Moved both to
  `finally { await stmt?.finalize(); }`; `finalize()` is idempotent, so the
  success path is unchanged. Pre-existing, but at the site under review and a
  one-line fix.
- **`row_trace`'s `console.warn` routed through the module logger,** matching
  the two `execution_trace` calls the implement stage converted. The
  implementer left it as out-of-scope; it is the same failure path, in the
  same file, and leaving one of three un-migrated is the kind of split that
  gets re-discovered.
- **Stale column-name comment.** `scheduler_program`'s third yielded value was
  commented `// instruction_id`; the declared column is `description`. The
  comment misdirects anyone writing a query against the function — confirmed
  by writing one and getting `Column not found: instruction_id`.
- **The new spec's assertion was too weak to catch what it was aimed at.**
  All five diagnostic TVFs answer failure by *yielding a row* rather than
  throwing (`Failed to compile SQL: …`, `NO_TRACE_DATA`, `NO_ROW_DATA`), so
  "returned at least one row" passes on a fully broken function. Added a
  check that no returned row carries any of those markers.
- **No coverage of the error/degraded paths** — a gap the implementer named
  honestly in the handoff. Added a second case per TVF driving unplannable
  SQL (`select missing_column from no_such_table`), asserting each reports the
  failure as a row instead of throwing or hanging. 10 tests total, all
  passing; this also pins the current "diagnostics don't throw" contract,
  which was previously unstated anywhere.
- **`docs/runtime.md`** described `execution_trace()` as one that "joins the
  former by instruction index", phrasing that dates from the nested-SQL
  implementation. Reworded to say both build the listing from one shared
  in-process helper.

### Filed as new ticket (major)

`tickets/backlog/bug-execution-trace-conflates-nested-instructions.md` —
`severity: wrong-result`, `likelihood: normal-use`, `repro: verified`.

Now that `execution_trace()` actually runs, what it returns is wrong for any
query containing a scalar expression. Two incompatible ways of numbering an
instruction are joined by integer equality: `collectSchedulerProgram` invents
a flat address space (`mainCount + programIndex * 1000 + localIndex` for
nested instructions), while `InstructionTraceEvent.instructionIndex` is the
index *within whichever scheduler is running* — and a nested scalar program
runs on its own `Scheduler` (via `emitCall`), so its indices restart at 0.

Verified by grouping raw trace events for `select n + 1 from t where n > 2`:
index 0 carries both `IndexScan(t)` and `column(n)`; index 2 carries
`filter(n > 2)`, `>(compare-fast)`, and `+(numeric-fast)`. Each such row is
labelled with the main-program operation while its duration and values may
come from the nested instruction, and the nested addresses
`scheduler_program()` lists match no event at all.

Filed at the representation rung rather than as a point fix: the ticket asks
for one composite instruction identity (program + local index) carried by
both sides, which also retires the `* 1000` collision that appears once any
program exceeds 1000 instructions. Site-claim grep over the board found only
`tickets/backlog/debt-relation-key-branded-type.md` touching `explain.ts`,
and that is about `explain_assertion`'s relation key — unrelated site, so a
fresh ticket rather than an appended arm.

This is out of scope for an inline fix: it changes the `InstructionTracer`
interface and threads program identity through `Scheduler`'s tracing hooks
and `emitCall`.

### Tripwires

None recorded separately. The one candidate — the `programIndex * 1000`
address encoding colliding above 1000 instructions — is not conditional in
isolation: it sits at the same code site as the reachable defect above and is
retired by the same representation change, so it is an arm of that ticket
rather than a standing note.

### Considered and not filed

`explain.ts` is 1093 lines (`wc -l`), which is large for one module, but this
ticket added ~10 lines net and the file is a flat registry of ten independent
diagnostic TVFs — the shape that makes size a problem (tangled shared state)
isn't present. Not filed; noted here so the next reviewer doesn't spend the
same time on it.

The implementer flagged that `execution_trace` reports a scalar sub-program
instruction as `callback(+(numeric-fast))` rather than the bare
`+(numeric-fast)` that `scheduler_program` reports, and asked whether the
wrapping itself deserved attention. It does not: `callback(…)` is the
main-program instruction's own note, set by `emitCall`, and it is a truthful
description of that instruction. The `.includes(...)` assertion is the right
call. (The nested instruction's *own* events are a separate matter — that is
the filed ticket above.)

The implementer also flagged `collectSchedulerProgram`'s placement in
`explain.ts` rather than a shared module. Correct as-is: both consumers live
in that file, and hoisting it would separate the helper from the NOTE
explaining why it exists.

## Verification

Full test suite from repo root (`yarn test`, all workspaces): green, zero
failures. `packages/quereus` alone: **9779 passing, 25 pending** — the 25 are
pre-existing skips, untouched; the +5 over the implement stage's 9774 are the
new unplannable-SQL cases.

`yarn workspace @quereus/quereus run lint` (eslint **+** `tsc -p
tsconfig.test.json --noEmit`, so the spec changes are type-checked): exit 0,
clean.

Targeted: `node test-runner.mjs --grep "diagnostic table-valued functions"` —
10/10 passing.
