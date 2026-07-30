---
description: Storing a piece of JSON text that itself looks like JSON (the word true, a number, a list) and then writing the row again used to corrupt it; that is fixed, but only three of the affected value shapes and a handful of the write paths are covered by tests, so add the rest before the guarantee quietly rots.
files:
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic   # existing coverage; extend here
  - packages/quereus/src/types/json-type.ts                        # JSON_TYPE.parse — the non-repeatable conversion
  - packages/quereus/src/types/validation.ts                       # buildRowCoercion (static-type mask) / coerceRowToSchema
  - docs/types.md                                                  # § "Where coercion happens (and why exactly once)"
difficulty: easy
---

# Pin JSON native-form survival across the remaining write paths

## Background — what was investigated, and what was found

The source ticket (`fix/bug-json-text-scalar-reparsed-on-write`) reported that

```sql
create table m (j json primary key, v int);
insert into m values ('"9"', 1), ('"9.0"', 2);
update m set v = 99 where v = 1;   -- the key silently became the NUMBER 9
```

corrupted the primary key. **It does not reproduce.** The completed ticket
`json-coerce-once-at-dml-source` fixed it: a write's cells are converted to the
declared column types exactly once, at the DML emitters, and a cell is converted
only when the static type of the expression that produced it is not already the
column's type. Values that came out of storage skip conversion, and the storage
layers are told `preCoerced` so they do not convert a second time.

Verified by running the reported statements, plus eleven more row-rewriting
scenarios, against **both** backends (in-memory and the LevelDB-backed store
behind the isolation layer). Every JSON text scalar survived every scenario
byte-identical, on both backends:

| scenario | outcome |
| --- | --- |
| `update` of a non-JSON column (the reported repro, `v int`) | intact |
| repeated `update`s of the same row (2×, 3×) | intact |
| `alter table … add column x int default 5` | intact |
| `alter table … add column x text not null default 'z'` | intact |
| `alter table … add constraint c check (v > 0)` | intact |
| `create index ti on t (j)` | intact |
| `alter table … alter column v set data type text` (sibling column retype) | intact |
| `insert or replace` onto an existing JSON key | intact |
| `insert … on conflict (j) do update set v = …` | intact |
| `delete` then re-`insert` the same JSON key | intact |
| two `update`s inside one transaction, then `commit` | intact |
| `update`, `savepoint`, `update`, `rollback to savepoint`, `commit` | intact |
| relocate the JSON primary key, then `update` the relocated row | intact |
| materialized view over a JSON column (create, then insert/update the source) | intact |

The source ticket's stated *expected behaviour* — "a marker on parsed values, or a
distinct entry point for already-native values", so that conversion becomes
repeatable — is **not achievable and should not be attempted.** A JSON value that
is a piece of text is stored as a plain JavaScript string. Once it is in that
form it is indistinguishable from unconverted JSON source text: the string `9` is
both "the JSON text scalar nine" and "JSON source for the number nine". Marking it
would mean wrapping every JSON text value in an object, which ripples into
comparison, ordering, storage keys, the function library, and the sync wire format.
The engine instead solves the problem one level up, by tracking whether a row has
already been converted (the `preCoerced` flag plus the static-type mask), which is
already documented in `docs/types.md` § "Where coercion happens (and why exactly
once)".

## What this ticket is for

The guarantee is real but under-tested, and it is the kind of guarantee that breaks
silently — a corrupted value still reads back as a valid JSON value, just the wrong
one. Two gaps:

**Gap 1 — value shapes.** `06.9.1-json-coerce-once.sqllogic` covers the JSON text
scalars `"9"`, `"9.0"` and `"abc"`. The source ticket also named `"true"`,
`"null"` and `"[1,2]"` — text that would re-parse into a *boolean*, into SQL NULL,
and into a *list*. Those cross different branches of the conversion (and `"null"`
would turn a present value into a missing one), so they are worth their own rows
rather than being assumed covered by `"9"`.

**Gap 2 — write paths.** The existing file covers `update` of a sibling column,
`insert … select`, self-assignment, upsert and generated columns. None of the
whole-row-rewriting paths in the table above — the `alter table` forms, index
creation, savepoint rollback, primary-key relocation — is pinned anywhere. Those
are exactly where a future regression would land, because they rebuild rows rather
than passing them through.

Both were confirmed working by hand during this investigation; this ticket only
converts that manual check into standing coverage. No production-code change is
expected. If any added case *does* fail, that is a real bug — do not weaken the
assertion; report it and file it.

## Note on `create index`

`create index` as a standalone statement is gated by the
`-- requires-capability: standalone-index-ddl` directive (see
`packages/quereus/test/logic-capabilities.ts` and `test/README.md`). The directive
is whole-file, so putting the index case into `06.9.1-json-coerce-once.sqllogic`
would make the *entire* file skippable for downstream harnesses that lack it. Split
it into a sibling file instead — the repo already does this for
`05.0.1-vtab-memory-unique-index-collation.sqllogic` and
`105.1-vtab-memory-index-mutation-kills.sqllogic`.

## TODO

- Extend `packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic` with the
  three uncovered JSON text scalars — `'"true"'`, `'"null"'`, `'"[1,2]"'` — on a
  JSON primary key alongside a plain column, asserting via `json_quote` that each
  survives an `update` of the sibling column unchanged. (`json_quote` is the
  assertion of choice: it distinguishes the text scalar `"9"` from the number `9`,
  which a bare `select` of the column does not.)
- Add the missing write paths to the same file, each as: create a table with a JSON
  primary key holding text scalars, run the path, then `json_quote` the keys back.
  Cover `alter table … add column` (with a plain default and with a
  `not null` default), `alter table … add constraint … check`,
  `alter table … alter column <sibling> set data type`, `insert or replace` onto an
  existing JSON key, `delete` then re-`insert` of the same JSON key, two `update`s
  in one transaction then `commit`, an `update`/`savepoint`/`update`/`rollback to
  savepoint`/`commit` sequence, and a primary-key relocation followed by an `update`
  of the relocated row.
- Add a sibling `06.9.1.1-json-coerce-once-index.sqllogic` carrying
  `-- requires-capability: standalone-index-ddl` in its leading comment block, for
  the `create index` on a JSON column case. Keep it minimal — it exists only so the
  capability gate does not cost the parent file.
- Also assert repeated writes: two or three successive `update`s of the sibling
  column, checking the JSON keys after each. Non-repeatable conversion shows up as
  progressive decay, so one write is a weaker test than three.
- Do **not** add `-- using memory`; these must run on the store leg too. Verify with
  `yarn test` and `yarn test:store` (the store leg is where the isolation overlay's
  own conversion decisions get exercised).
- In `docs/types.md` § "Where coercion happens (and why exactly once)", add one
  sentence naming the sqllogic file(s) as the standing regression coverage for the
  invariant, so the next reader finds the tests instead of re-deriving the analysis.
  Keep the existing explanation of *why* conversion cannot be re-run — it is
  accurate.
