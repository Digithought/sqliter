description: A table whose quoted name contains a dot (e.g. a table literally named "a.b") was mis-identified inside the SQL engine's change-tracking code, so materialized-view conflict checks and explain output looked up the wrong table or none; the name splitting is fixed so the full name survives.
prereq:
files:
  - packages/quereus/src/util/qualified-name.ts                # splitBaseKey helper
  - packages/quereus/src/core/database-watchers.ts             # :82 getRowCount
  - packages/quereus/src/core/database-assertions.ts           # :149 getRowCount, :303 pkIndicesByBase
  - packages/quereus/src/core/database-materialized-views.ts   # :979 plan.sourceBase
  - packages/quereus/src/func/builtins/explain.ts              # :1031 assertion-explain prepared params
  - packages/quereus/test/dotted-table-name.spec.ts            # regression spec
difficulty: medium

# Complete: core engine `schema.table` keys re-split on `.` for dotted table names

## What shipped

The core engine keys a base table as a flat lowercased string `` `${schema}.${table}` ``.
Five sites recovered the `(schema, table)` pair with `base.split('.')` taking the first
two elements, so a quoted table name containing a dot (`create table "a.b"` → key
`main.a.b`) truncated to table `'a'` and dropped the `.b` segment. Added
`splitBaseKey(base)` (`packages/quereus/src/util/qualified-name.ts`) — splits on the
**first** dot only — and routed all five recovery sites through it. Flat key format and
construction sites unchanged.

Sites changed: `database-watchers.ts:82`, `database-assertions.ts:149` and `:303`,
`database-materialized-views.ts:979`, `explain.ts:1031`.

## Review findings

Adversarial pass over commit `85508dbc`. Read the full source diff and spec with fresh
eyes before the handoff summary.

**Correctness — clean.** `splitBaseKey` splits on `indexOf('.')`: `main.a.b` → `('main',
'a.b')`, correct for single-dot table names, multi-dot table names (`main.a.b.c` →
`('main', 'a.b.c')`), and non-`main` schemas (`attached.a.b` → `('attached', 'a.b')`).
The no-dot defensive branch returns `('', base)`; `''` is falsy so `_findTable` falls to
its default main→temp search order (`schema/manager.ts:668`) — a benign default, and the
base key always carries a schema segment in practice so the branch is unreachable.

**Completeness of the fix — verified.** Grepped `\.split\('\.'\)` across
`packages/quereus/src`: the only remaining hits are `json-helpers.ts` (JSON-path) and
`scopes/{global,aliased}.ts` (symbol keys) — unrelated to base keys. All five base-key
recovery sites are covered. Construction sites (`mvKey`, `relationToBase`, `sourceBase`,
watcher `tables` sets, delta-executor keys) compare the whole key and were correctly left
untouched — the explain test asserts `base == 'main.a.b'` end-to-end, proving the dotted
name survives construction.

**Tests — floor is honest, extended coverage confirmed sufficient.** Three spec cases
over a table literally named `"a.b"`. Two are strict red→green discriminators
(materialized-view covering-conflict detection; `explain_assertion` prepared params). The
third (assertion rollback) is a correctness floor, not a discriminator — the handoff is
honest that the residual-dispatch site (`:303`) degrades *harmlessly* to global
re-evaluation via the `if (!pkIndices)` guard (`runtime/delta-executor.ts:210`), so it
does not flip across the fix; the GROUP explain case exercises the identical
`_findTable(splitBaseKey(base))` recovery strictly. Edge cases (multi-dot, non-main
schema) are covered by the split logic and no additional case is needed. Full suite
**6916 passing, 13 pending, 0 failing**; new spec 3 passing; lint exit 0. Verified this
run, not just trusted from the handoff.

**DRY — minor, intentionally not consolidated (tripwire).** Four pre-existing inline
first-dot splitters already exist and were already correct (not part of the bug):
`change-scope.ts:780`, `manager.ts:3079`, `materialized-view-helpers.ts:688` and `:2475`.
They duplicate `splitBaseKey`'s shape but default a missing schema to `'main'`, not `''`.
Routing them through `splitBaseKey` would silently change that default (empty schema →
different watch/lookup behavior), so consolidation is **not** a safe no-op and is out of
scope for a bugfix. Left as-is; noted here so a future DRY sweep knows the default
mismatch is the reason, not oversight.

**Tripwire — dotted *schema* names.** `splitBaseKey` is unambiguous only when the schema
name has no dot; a dotted schema name stays ambiguous. Documented in the helper's JSDoc
(`qualified-name.ts`) and matches the accepted convention already used by the
`@quereus/store` and `@quereus/sync` fixes for the same defect class. Not work now — only
if dotted schema names ever become reachable.

**Docs — no update required.** Internal bugfix, no user-facing behavior change; the
helper's contract and the dotted-schema limitation live in its JSDoc. No `docs/` file
describes base-key recovery, so nothing went stale.

**Not done (out of scope, deferred at fix stage).** The ideal fix — carrying `(schema,
table)` forward instead of re-splitting a joined key — was deferred: the flat key is
embedded across delta-executor Map keys, `mvKey`, and `relationToBase`. First-dot split
at recovery sites is the scoped fix and matches the store/sync fixes. Key representation
was not refactored. No follow-up ticket filed — the current representation is coherent and
the refactor is speculative, not owed.

## Verification

- `yarn workspace @quereus/quereus run test` — 6916 passing, 13 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus run test:single "packages/quereus/test/dotted-table-name.spec.ts"` — 3 passing.
