---
description: Date and time arithmetic used to re-inspect its values on every row to work out which operation to run; it now decides once when the query is compiled, and runs about 12% faster on a 10,000-row scan.
files:
  - packages/quereus/src/runtime/emit/binary.ts                 # the three-arm temporal branch (~line 157)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts    # emitTemporalArithmetic deleted; "left alone, and why" note added
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts
  - packages/quereus/test/runtime/scalar-fusion.spec.ts
  - packages/quereus/bench/suites/execution.bench.mjs
  - docs/runtime.md                                             # emit-time specialization table
difficulty: medium
---

# Pick the temporal case at emit time — review handoff

## What changed

`buildNumericOpSpec`'s temporal branch (`runtime/emit/binary.ts:157`) used to have one body:
call `tryTemporalArithmetic` per row, which re-derives both operand kinds from the *values*
(up to four regex/prefix probes each) before looking the case up in
`types/temporal-ops.ts`. The branch now looks the case up **once at emit** from the operands'
declared logical types and picks one of three bodies:

| Arm | Selected when | Body | Note |
| --- | --- | --- | --- |
| 1 | both declared kinds resolve **and** the table has a case | one `runTemporalCase(entry, …)` call | `+(temporal-date-timespan)` etc. |
| 2 | both resolve, table has **no** case | NULL check, then constant throw | `+(temporal-unsupported)` |
| 3 | a declared type settles nothing (TEXT / ANY / NULL / TIMESTAMP / plugin type) | today's body, byte for byte | `+(temporal)` |

Also in this change:

- `emitTemporalArithmetic` deleted (exported, referenced nowhere), along with its now-unused
  `Instruction` / `RuntimeContext` / `asRun` / `BinaryOpNode` / `emitPlanNode` /
  `EmissionContext` imports.
- A `NOTE:` above `tryTemporalComparison` explaining why the comparison twin is deliberately
  *not* given the same treatment (one `startsWith` per operand, not four regexes; and
  `buildComparisonOpSpec` already routes the hot same-type case to `=(compare-typed)` without
  reaching it).
- `docs/runtime.md` gained a table of every emit-time specialization note and what selects it,
  replacing the one-line parenthetical.

The generic `(numeric)` / `(numeric-fast)` branches are untouched.

## What to exercise

**The three arms and their notes** — `test/runtime/scalar-op-spec.spec.ts`, three new rows in
the notes table. `select d1 + sp from d` → `+(temporal-date-timespan)`; `select d1 + d2 from d`
→ `+(temporal-unsupported)`; `select txt - d1 from d` → `-(temporal)`. The test table `d` gained
`sp timespan not null, txt text not null`.

**Behavior over columns** — `test/logic/107-…sqllogic`, new sections at the end. Everything
above them already passed unchanged; these run the same shapes *per row* rather than as
constant-folded literals, since the pre-existing cases all fold before a row is scanned:

- arm 1 values: `dt + sp`, `dt - dt2`, `sp2 * n`
- arm 3 value: `txt + sp` — a TEXT operand whose runtime value *does* look like a duration,
  so sniffing still finds the (timespan, timespan) case
- deep chain: `dt + sp - dt2 + sp2` specializes at every level
- arm 2 throws per row, and therefore **does not** throw when the expression is never
  evaluated — guarded by a never-selected `CASE`, filtered out by `where 1 = 0`, or over an
  empty table. These three are the reason the throw was not hoisted to emit time.
- NULL wins over the arm choice on all three arms, including arm 2 where a non-NULL pair throws
- `sp * big` / `sp / big` with a bigint on the number side: reaches arm 1, and the case's own
  `typeof n === 'number'` guard still raises `Unsupported temporal operation`. This is the one
  place that guard is reachable; dropping it would silently change the answer.

**Fusion parity** — `test/runtime/scalar-fusion.spec.ts`, two new tests: values across all
three arms fused vs unfused (with row 1 spot-checked against literal expectations, so two
identically-wrong paths cannot pass as parity), and the arm-2 error message identical fused or
unfused.

**Suggested extra pokes for the reviewer** (not covered by the tests above):
- Temporal arithmetic inside a materialized view body or a CHECK constraint — the specialized
  bodies run wherever a scalar op runs, but only projections/filters/joins are exercised here.
- A prepared statement re-executed after a schema change that alters an operand's declared
  type — re-planning should re-pick the arm, but nothing pins it.
- `%` on temporal operands beyond the one literal case already in the file.

## Measurement

New bench entry `temporal-arith-scan-10k` (10K rows, `select d + s as a from bench_temporal_t`,
DATE + TIMESPAN per row over a full scan). No `ratioGuards` entry — those bound pathological
plan regressions, not constant factors.

- **specialized (arm 1): 90.3, 90.4, 90.7, 93.1 ms → median ≈ 90.6 ms**
- **value-sniffed (today's body): 96.5, 101.6, 103.7, 105.3 ms → median ≈ 102.7 ms**

`full-scan-10k` measured 10.9–12.9 ms across all eight runs, so ambient conditions were
comparable. Roughly 12 ms over 10K rows, ~1.2 µs/row, ~12% of the statement.

**How the "before" number was obtained, since it is not a plain `--baseline` run:** the
committed history was not checked out. Instead the two arm conditions were temporarily forced
false (first in `src` + rebuild, then by patching the built `dist/.../binary.js` for the last
two samples), so every temporal pair fell into arm 3 — behaviorally identical to the prior
code. `dist` was rebuilt from a cleared `tsconfig.tsbuildinfo` afterwards and verified free of
the patch. One additional "before" run (665 ms, with `full-scan-10k` simultaneously at 46 ms)
was discarded as machine noise; it is mentioned here rather than quietly dropped. Scratch
result JSONs from the crippled builds were deleted; one clean post-change run was kept in
`bench/results/`.

Worth knowing: dispatch is only ~1.2 µs of the ~9 µs each row spends in this shape. The other
~8 µs is temporal-polyfill parsing, re-done per row even for a constant operand. Parked as a
`NOTE:` on the bench entry.

## Known gaps and judgement calls

- **The declared-type-trust divergence is untested because it appears unreachable through
  SQL.** Arm 1 trusts the declaration: a DATE-typed operand holding a non-parseable string
  returns NULL (via `runTemporalCase`'s catch) where sniffing raised `Unsupported temporal
  operation`. Both SQL routes to such a value were probed and both are closed —
  `insert into t(dt) values ('garbage')` is rejected by write-side coercion
  (`Cannot convert 'garbage' to DATE`), and `cast('garbage' as date)` yields NULL, not the
  garbage string. Both are pinned in the sqllogic file so the closure is a tested fact rather
  than an assumption. A custom virtual table returning raw rows could still produce one; no
  harness was built for that, per the ticket's instruction not to invent one.
- **Arm-1 coverage of the operation table is partial.** The new column-based cases cover
  (date,timespan), (date,date), (timespan,number) and (timespan,timespan). The other table
  entries — TIME and DATETIME shifts, the commuted forms, mixed DATE/DATETIME differences —
  are covered only by the pre-existing literal cases, which constant-fold. They still route
  through the same emitter during folding, so the values are pinned; but they are not pinned
  *as per-row scans*. A reviewer wanting belt-and-braces could widen the `arms` table.
- **`temporalOpCase`'s string-concat key is still paid per row on arm 3.** The existing
  `NOTE:` in `types/temporal-ops.ts` already names this and its remedy; no new tripwire filed.
- **Note-string cardinality went up** (`+(temporal)` → up to 17 distinct
  `<op>(temporal-<lk>-<rk>)` strings). Nothing outside the ticket greps for the old string —
  verified across the repo — but it is a visible `EXPLAIN` / `scheduler_program()` surface.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — 9190 passing, 25 pending, 0 failing across all workspaces (9185 before; +5 is
  3 note assertions and 2 fusion tests, the sqllogic file counting as one test).
- `yarn bench` — see above.
- `yarn test:store` was **not** run; nothing here touches the store path.
