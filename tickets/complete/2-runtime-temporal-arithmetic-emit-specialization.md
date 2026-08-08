description: Date and time arithmetic used to re-inspect its values on every row to work out which operation to run; it now decides once when the query is compiled, and runs about 12% faster on a 10,000-row scan.
files:
  - packages/quereus/src/runtime/emit/binary.ts                 # the three-arm temporal branch; generic arithmetic body extracted
  - packages/quereus/src/types/temporal-ops.ts                  # temporalOpCaseForTypes — the one declared-types → case route
  - packages/quereus/src/planner/nodes/scalar.ts                # generateType now goes through that same route
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts    # emitTemporalArithmetic deleted; "left alone, and why" note added
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/types/temporal-ops.spec.ts
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts
  - packages/quereus/test/runtime/scalar-fusion.spec.ts
  - packages/quereus/bench/suites/execution.bench.mjs
  - docs/runtime.md                                             # emit-time specialization table
  - docs/types.md                                               # the two routes into the operation table
difficulty: medium
---

# Pick the temporal case at emit time — completed

## What shipped

`buildNumericOpSpec`'s temporal branch used to have one body: call `tryTemporalArithmetic`
per row, which re-derives both operand kinds from the *values* (up to four regex/prefix
probes each) before looking the case up in `types/temporal-ops.ts`. It now looks the case
up **once at emit** from the operands' declared logical types and picks one of three
bodies:

| Arm | Selected when | Body | Note |
| --- | --- | --- | --- |
| 1 | both declared kinds resolve **and** the table has a case | one `runTemporalCase(entry, …)` call | `+(temporal-date-timespan)` etc. |
| 2 | both resolve, table has **no** case | NULL check, then constant throw | `+(temporal-unsupported)` |
| 3 | a declared type settles nothing (TEXT / ANY / NULL / TIMESTAMP / plugin type) | the pre-existing value-sniffing body | `+(temporal)` |

The throw in arm 2 stays at runtime deliberately: a guarded (`case when 0 then …`),
filtered-out (`where 1 = 0`), or empty-table occurrence must keep succeeding, and a
constant-throw closure costs nothing per row on the paths that never run it.

Also landed: `emitTemporalArithmetic` deleted (exported, referenced nowhere); a `NOTE:`
above `tryTemporalComparison` explaining why the comparison twin is deliberately *not*
given the same treatment; `docs/runtime.md` gained a table of every emit-time
specialization note and what selects it.

## Measurement

Bench entry `temporal-arith-scan-10k` (10K rows, `select d + s as a from bench_temporal_t`,
DATE + TIMESPAN per row over a full scan):

- **specialized (arm 1): median ≈ 90.6 ms** (implement run), **87.5 ms** (review run)
- **value-sniffed (the prior body): median ≈ 102.7 ms**

`full-scan-10k` measured 10.9–12.9 ms across every run, so ambient conditions were
comparable throughout. Roughly 12 ms over 10K rows, ~1.2 µs/row, ~12% of the statement.
The "before" number was obtained by temporarily forcing both arm conditions false so every
temporal pair fell into arm 3, which is behaviorally identical to the prior code; the
crippled build was reverted and `dist` rebuilt from a cleared `tsconfig.tsbuildinfo`.

Dispatch is only ~1.2 µs of the ~9 µs each row spends in this shape. The other ~8 µs is
temporal-polyfill parsing, re-done per row even for a constant operand — parked as a
`NOTE:` on the bench entry, not filed.

## Review findings

Read the implement diff (`6b192cb0`) before the handoff summary. Everything found resolved
at the two sites the change touches; **no new tickets were filed**, and the reason for each
category is given below rather than left silent.

### Fixed in this pass

- **The declared-types → case lookup was spelled twice, in two packages.**
  `planner/nodes/scalar.ts` (announcing `resultType`) and `runtime/emit/binary.ts`
  (emitting the body that runs `apply`) each derived both operand kinds and hit the table
  independently — the same three lines, copy-pasted. Their agreement is precisely the
  invariant the operation table exists to hold: if they ever select different entries, the
  announced type stops predicting the value, which is the exact class of bug the table was
  introduced to retire. This duplication was *introduced by this change* (before it, only
  the planner did the lookup). Replaced both with one `temporalOpCaseForTypes` in
  `types/temporal-ops.ts`, returning `{ kinds?, entry? }` — the three-way outcome both
  callers branch on. The invariant is now structural rather than maintained by hand.
- **Arm 3's body was a byte-for-byte duplicate of the generic non-temporal path's**
  (~23 lines, twice in one function). Extracted `buildCoercingArithmeticRun`, mirroring the
  `buildGenericComparisonRun` factory that already sits 150 lines below it in the same
  file. The two branches now differ only in the note they carry. `binary.ts` 613 → 609
  lines net (well under every entry in `debt-oversized-source-files`, so no arm appended
  there).
- **`docs/types.md` was stale in a way the change should have caught.** Its "Temporal
  arithmetic: one table" section described the evaluator as classifying operands "by the
  shape of the runtime value" — true of arm 3 only after this change. Rewritten as the two
  routes into the table (declared types via `temporalOpCaseForTypes`, values via
  `tryTemporalArithmetic`), including what the declared-type route trusts and why. The
  file-list line at the bottom of the doc was updated to match.
- **Arm-1 coverage of the operation table was partial per row** (the implementer flagged
  this). The new column-based cases reached four of the table's eighteen entries; the rest
  were pinned only by literal expressions, which constant-fold before a row is scanned.
  Added a per-row section covering the remainder: TIME and DATETIME shifts both ways, all
  three commuted TIMESPAN-first forms, TIME − TIME, the three mixed DATE/DATETIME
  differences, TIMESPAN ± TIMESPAN, TIMESPAN / TIMESPAN, TIMESPAN / NUMBER, and
  NUMBER * TIMESPAN. Every table entry now runs over a column.
- **The implementer's two suggested pokes, both untested, both now covered.** Temporal
  arithmetic inside a view body and inside a CHECK constraint — added to the sqllogic file;
  both pass, including a CHECK that rejects a row because a negative shift moves the date
  backwards. (`%` on temporal operands beyond the one literal case was the third suggestion;
  every `%` pair routes to arm 2 by construction, and arm 2 is covered.)
- Added four unit tests for `temporalOpCaseForTypes` in `test/types/temporal-ops.spec.ts`,
  including a sweep asserting the planner and the emitter get the same case for **every**
  key in the table — a generalized test for the whole class, not one instance.

### Checked and found sound

- **Arm 2 against the prior behavior, for every reachable declared pair.** Under write-side
  coercion the declared kind and the sniffed value kind coincide, so where the old body
  raised `Unsupported temporal operation` the new one does too. NULL short-circuits ahead
  of the arm choice on all three arms, including arm 2 where a non-NULL pair throws — the
  sqllogic file pins each.
- **The bigint-on-the-number-side guard** (`timespan * 9007199254740993`): reachable only
  via arm 1, and the case's own `typeof n === 'number'` check raises the same error the
  value-sniffed path did. Pinned for both `*` and `/`.
- **A prepared statement re-executed after a schema change that alters an operand's
  declared type** — the implementer listed this as unpinned. It is covered by an existing
  engine invariant: plans are invalidated on schema-change events
  (`packages/quereus/src/core/statement.ts:254`), so re-planning re-picks the arm. The same
  invariant is what `+(numeric-fast)` has always depended on; this change adds no new
  exposure, so nothing was filed.
- **Note-string cardinality** (`+(temporal)` → up to 17 distinct `<op>(temporal-<lk>-<rk>)`
  strings). Re-verified across the repo: nothing outside this ticket's own tests greps the
  old string.
- **`emitTemporalArithmetic` deletion**: no remaining references in any package's `src` or
  `test`.
- **`tryTemporalComparison` left unspecialized**: the `NOTE:` explaining why is accurate —
  `buildComparisonOpSpec` does route two same-semantic-ordering operands to
  `=(compare-typed)` before reaching it, and what remains is the mixed TIMESPAN-vs-TEXT
  shape that declared types cannot settle anyway.

### Considered and declined (not re-filed)

- **The declared-type-trust divergence.** Arm 1 trusts the declaration, so a DATE-typed
  operand holding a non-parseable string would return NULL where sniffing raised an error.
  Both SQL routes to such a value are closed and pinned in the sqllogic file (a bad INSERT
  is rejected by write-side coercion; a failed CAST yields NULL). The remaining route is a
  misbehaving virtual table. This is an accepted tradeoff, documented at the code site and
  in both docs — left alone.
- **`temporalOpCase`'s string-concat key, still paid per row on arm 3.** The existing
  `NOTE:` in `types/temporal-ops.ts` already names it and its remedy.

### Tripwires

None new. What was noticed during the pass was already parked: the per-row
temporal-polyfill parse (on the bench entry), the concat key (in `temporal-ops.ts`), and
the DATE/DATETIME difference dropping time of day (`bug-datetime-difference-drops-time-of-day`,
open in `backlog/`). `date + timespan('PT30M')` returning the same date looked like a
fourth instance of that theme but is not a defect — a DATE has no time of day to carry
sub-day units into, and SQLite behaves the same way; it is now pinned with a comment saying
so rather than filed.

### Major findings

None. Every finding resolved at one of the two sites the diff touches, so nothing climbed
to a separate ticket.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — **9194 passing, 25 pending, 0 failing** across all workspaces (9190 after
  implement; +4 are the new `temporalOpCaseForTypes` unit tests, the sqllogic additions
  counting inside the file's single test).
- `yarn bench` — `temporal-arith-scan-10k` 87.45 ms with `full-scan-10k` at 11.36 ms; no
  regression from the review-stage refactor, which is emit-time only.
- `yarn test:store` was **not** run; nothing here touches the store path.
