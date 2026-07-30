description: Added the missing test coverage for the "a JSON value that looks like JSON text survives being written back unchanged" guarantee — more value shapes and more ways a row can get rewritten — so a future regression in that guarantee gets caught instead of passing silently.
files:
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic          # extended: 3 more text-scalar shapes + 9 write-path scenarios + repeated-write check
  - packages/quereus/test/logic/06.9.1.1-json-coerce-once-index.sqllogic  # new: CREATE INDEX case, gated behind requires-capability: standalone-index-ddl
  - docs/types.md                                                        # § "Where coercion happens (and why exactly once)" — added pointer to the two files above
difficulty: easy
---

# Review: JSON native-form write-path coverage

## What this was

Prior ticket `json-coerce-once-at-dml-source` fixed a real bug: writing a row
converts each cell to its column's declared type exactly once, at the DML
emitters, driven by the static type of the producing expression. A cell that
already holds the declared type (e.g. a JSON value read back out of storage)
is skipped, because JSON's conversion is **not idempotent** — re-running it on
an already-converted JSON string scalar can silently change its value (`"9"`
→ the number `9`) or throw.

This ticket (`json-native-form-write-path-coverage`) is pure test-coverage
follow-up. A prior investigation manually verified 14 row-rewriting scenarios
against both backends (in-memory and the LevelDB-backed store) and found
everything intact — **no production code changed here or in the
investigation.** This ticket converts that manual verification into standing
regression coverage, plus fills in three value shapes the original fix's test
file never exercised.

## What changed

`packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic`:

1. **Value shapes** — added `jco_shapes`: the JSON text scalars `"true"`,
   `"null"`, `"[1,2]"` (source text that would land as a *boolean*, *SQL
   NULL*, and a *list* respectively if ever re-parsed), each surviving an
   `UPDATE` of a sibling column, asserted via `json_quote` (which distinguishes
   the text scalar from the same-looking native value — a bare `select` does
   not, for the boolean/list cases in particular).

2. **Write paths** — nine new tables (`jco_wp_*`), each: create a table with a
   JSON column holding text scalars, run one row-rewriting path, then
   `json_quote` the value back:
   - `alter table … add column … default <literal>`
   - `alter table … add column … not null default <literal>`
   - `alter table … add constraint … check (…)`
   - `alter table … alter column <sibling> set data type …`
   - `insert or replace` onto an existing JSON primary key
   - `delete` then re-`insert` of the same JSON key
   - two `update`s inside one transaction, then `commit`
   - `update` / `savepoint` / `update` / `rollback to savepoint` / `commit`
   - primary-key relocation (`update` the JSON PK column itself), then
     `update` the relocated row's sibling column

3. **Repeated writes** (`jco_wp_repeat`) — three successive `update`s of a
   sibling column, checking `json_quote` of three differently-shaped keys
   after *each* update. Non-repeatable conversion decays progressively, so a
   single post-write check is a weaker test than three.

New file `packages/quereus/test/logic/06.9.1.1-json-coerce-once-index.sqllogic`:

- `CREATE INDEX` on a JSON column, gated behind
  `-- requires-capability: standalone-index-ddl` (the directive is
  whole-file, so this one case had to move to its own file rather than
  gating the much larger parent file). Mirrors the existing pattern from
  `05.0.1-vtab-memory-unique-index-collation.sqllogic` /
  `105.1-vtab-memory-index-mutation-kills.sqllogic`.

`docs/types.md` § "Where coercion happens (and why exactly once)" — added one
paragraph (just before `### Explicit Conversion`) naming both sqllogic files
as the standing regression coverage, so the next reader finds the tests
instead of re-deriving the analysis. The existing explanation of *why*
conversion cannot be re-run is untouched.

Neither new file uses `-- using memory`, so both run on the store leg too
(the isolation overlay's own conversion decisions are what the store leg
actually exercises for several of these paths — e.g. the transaction and
savepoint scenarios).

## How to validate

```
cd packages/quereus
node test-runner.mjs --grep "06.9.1"           # memory backend, both files
node test-runner.mjs --store --grep "06.9.1"   # store (LevelDB) backend, both files
node test-runner.mjs                            # full memory suite
node test-runner.mjs --store                    # full store suite
```

All four ran clean during implementation:
- `06.9.1` filtered run: 2/2 passing on both memory and store.
- Full memory suite: 8073 passing, 13 pending (pre-existing pending count, unrelated to this ticket).
- Full store suite: 8064 passing, 22 pending (pre-existing; store legitimately skips a few memory-only files — see `MEMORY_ONLY_FILES` in `test/logic.spec.ts`).
- No new failures, no pre-existing failures encountered.

## Known gaps / things the reviewer should weigh

- **Scalar choice in write-path tests.** The nine `jco_wp_*` write-path tables
  mostly use `'"9"'` and `'"null"'` as the two representative text scalars
  (not the full six-shape set from the value-shapes test) — enough to catch a
  numeric-reparse or an NULL-vanish regression on each path without
  6×9 = 54 near-duplicate blocks. If a reviewer wants every path to cover
  every shape, that's a mechanical expansion, not a design question.
- **No production code touched.** If any of the new assertions had failed, the
  ticket's brief was explicit: don't weaken it, report and file a bug instead.
  None failed.
- **PK-relocation test** (`jco_wp_reloc`) covers relocating the key via a
  literal assignment (`update … set j = '"null"' …`), not via a `key`
  auto-increment or multi-column PK path — the original investigation's
  "relocate the JSON primary key" scenario was itself just a single-column PK
  update, so this matches what was actually verified by hand.
- This ticket's scope was explicitly test-only per the source ticket; no
  tripwires were identified during this work (no new conditional-risk code
  paths were touched).
