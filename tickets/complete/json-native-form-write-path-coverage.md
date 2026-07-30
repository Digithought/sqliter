description: Added and reviewed the missing test coverage for the "a JSON value that looks like JSON text survives being written back unchanged" guarantee — more value shapes and more ways a row can get rewritten — so a future regression gets caught instead of passing silently.
files:
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic          # text-scalar shapes + 13 write-path scenarios + repeated-write check
  - packages/quereus/test/logic/06.9.1.1-json-coerce-once-index.sqllogic  # index-DDL cases, gated behind requires-capability: standalone-index-ddl
  - docs/types.md                                                        # § "Where coercion happens (and why exactly once)" — pointer to both files
difficulty: easy
---

# Complete: JSON native-form write-path coverage

## What this was

The earlier fix (`json-coerce-once-at-dml-source`) established that a write
converts each cell to its column's declared type exactly once, at the DML
emitters, driven by the static type of the producing expression. A cell that
already holds the declared type — a JSON value read back out of storage — is
skipped, because JSON conversion is not repeatable: re-parsing the stored
JSON string scalar `"9"` yields the *number* 9, and re-parsing `"abc"` throws.

This ticket was test-only: turn a prior manual verification into standing
regression coverage and fill in value shapes the original fix never exercised.
No production code was changed in either the implement or the review pass.

## What landed

`06.9.1-json-coerce-once.sqllogic` — value shapes `"true"` / `"null"` /
`"[1,2]"` surviving an UPDATE of a sibling column (asserted through
`json_quote`, which distinguishes a text scalar from the same-looking native
value where a bare `select` does not), plus write-path scenarios that each
rewrite existing rows through a distinct code path:

- `alter table … add column` with a plain default and with a `not null` default
- `alter table … add constraint … check (…)`
- `alter table … alter column <sibling> set data type …`
- `alter table … drop column` (row reshaped, JSON cell moves position) *(review)*
- `alter table … alter column … set not null` default backfill *(review)*
- `alter table … rename column` *(review)*
- `insert or replace` onto an existing JSON primary key
- `delete` then re-`insert` of the same JSON key
- two updates inside one transaction, then `commit`
- update / savepoint / update / `rollback to savepoint` / `commit`
- whole-transaction `rollback` *(review)*
- primary-key relocation, then an update of the relocated row's sibling
- three successive updates with a `json_quote` check after each (non-repeatable
  conversion decays progressively, so one post-write check is weaker)

`06.9.1.1-json-coerce-once-index.sqllogic` (new file, `-- requires-capability:
standalone-index-ddl`; the directive is whole-file, so gating the much larger
parent file was not an option) — `create index` on a JSON column, plus
`create unique index` over `"9"` / `"9.0"` and `drop index` *(review)*. The
unique case is the sharpest of the three: a re-parse would collapse those two
text scalars to the numbers 9 and 9.0 and raise a false UNIQUE violation.

Neither file uses `-- using memory`, so both run on the LevelDB store leg too.

`docs/types.md` § "Where coercion happens (and why exactly once)" names both
files as the standing coverage, with the path list kept current.

## Review findings

**Verified the tests have teeth (not vacuously green).** Temporarily forced
`buildRowCoercion` (`src/types/validation.ts`) to convert every cell — the
exact regression the fix prevents — and confirmed the file fails; reverted, and
confirmed the working tree was clean afterwards. Separately confirmed one of
the newly added blocks fails when its expectation is falsified, so the added
scenarios are genuinely executed by the harness rather than parsed and skipped.

**Minor — fixed in this pass (coverage gaps).** The implement pass covered nine
row-rewriting paths but missed five more that also rebuild rows or reissue the
schema: `drop column`, `set not null` backfill, `rename column`,
whole-transaction `rollback`, and `create unique index` / `drop index`. All
five added (marked *(review)* above) and passing on both backends. `drop
column` and `create unique index` were the two worth having: the first moves
the JSON cell's position during a row reshape, the second compares stored JSON
keys against each other.

**Minor — fixed in this pass (docs/comments).** The parent file's header did
not mention its capability-gated sibling, so a reader landing there would not
know index cases exist elsewhere; added a pointer. The sibling's header said
"CREATE INDEX … kept minimal on purpose", now stale; retitled to index DDL
generally. The `docs/types.md` path list was extended to match the scenarios
that actually exist.

**Not a finding — scalar choice.** The implement handoff flagged that most
write-path tables use `'"9"'` and `'"null"'` rather than all six shapes. That
is the right call: the shapes are already pinned once against UPDATE, and the
two chosen scalars cover both failure modes (numeric re-parse, value
vanishing). Expanding to 6×14 near-duplicate blocks would add cost, not signal.

**Not a finding — capability-annotation registry.** `logic-capabilities.spec.ts`
has a `subjectFiles` list asserting that files whose subject is index DDL carry
the directive; the new file was not added to it. The list is a snapshot of an
earlier corpus sweep, and the two closest precedents
(`05.0.1-vtab-memory-unique-index-collation`,
`105.1-vtab-memory-index-mutation-kills`) are likewise absent, so adding only
this one would make the list less coherent, not more. Left as-is deliberately.

**Tripwires — none.** Nothing conditional surfaced; the change touches only
`.sqllogic` fixtures and one docs paragraph, with no code site whose cost or
correctness turns on a future condition.

**Pre-existing failures — none.** The store leg prints
`[TransactionCoordinator] … savepoint depth … out of range` warnings during the
full run; these are log noise present before this ticket and unrelated to the
JSON coercion path — no test fails on them, so nothing was filed.

## Validation

From `packages/quereus`, all green:

```
node test-runner.mjs --grep "06.9.1"           # 2 passing
node test-runner.mjs --store --grep "06.9.1"   # 2 passing
node test-runner.mjs                            # 8073 passing, 13 pending
node test-runner.mjs --store                    # 8064 passing, 22 pending
yarn lint                                       # clean (repo root)
```

Pending counts match the pre-ticket baseline (the store leg legitimately skips
the memory-only files listed in `test/logic.spec.ts`).
