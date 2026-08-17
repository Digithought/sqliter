description: The engine used to leave a table's identity columns unwritten when the author never named them, which quietly lost a "what to do on a duplicate row" setting. It now always writes them out.
files:
  - packages/quereus/src/schema/ddl-generator.ts (~113-154 — the two guards and their comments; `isSynthesizedAllColumnsKey` import gone from ~22)
  - packages/quereus/src/schema/table.ts (`isSynthesizedAllColumnsKey` deleted; `TableSchema.synthesizedPrimaryKey` doc ~42-67 rewritten; `findPKDefinition`'s closing comment ~1242 rewritten)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (header rule rewritten; `expectedClauses` all 1; `expectedConflictAfterRoundTrip` field deleted; `expectedNullability` field added; 4 new cases)
  - packages/quereus/test/no-pk-nullability.spec.ts (three DDL assertions flipped — NOT in the original ticket's file list)
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts (all-columns case 0 → 1; `expectedClauses` doc comment)
  - docs/schema.md (~332 omission paragraph replaced; ~336 "two gaps" → one gap; ~338 fixed point now unconditional)
difficulty: medium
---

# Every primary key emits its `PRIMARY KEY` clause

## What changed

Canonical `CREATE TABLE` DDL now names **every** primary key, with no exception —
including the all-columns key a table gets when it declares no `PRIMARY KEY`. Inline
on the column when the key is one column, table-level otherwise, exactly like a
declared key.

Previously that key emitted no clause at all and the re-parse re-synthesized it from
the absence. The omission existed for one reason: a declared `PRIMARY KEY` used to
promote its columns to `NOT NULL` while a synthesized one did not, so naming the key
would have silently tightened a nullable column on every persistence round-trip. The
prerequisite `feat-relax-declared-primary-key-not-null` removed that promotion
(verified in the tree before any code was written here — both blocker greps in the
original ticket miss, and `schema/manager.ts:1737` now carries the comment saying
membership does not force `NOT NULL`), so the two spellings are one key and the
omission had nothing left to justify it.

**This also fixed a live bug.** The old guard bailed out only on a *table-level*
`primary key (...) on conflict X`. An action declared on a key *column* left the guard
matching, so these two shapes emitted no clause and their action had nowhere to ride:

```sql
create table t (a integer primary key on conflict replace);
create table t (a integer not null on conflict replace, b text, primary key (a, b));
```

Both came back `ABORT` after a reopen and started throwing on a duplicate-key write.
The loss was stable (identical on the second emission), so the round-trip harness's
fixed-point assertion could not see it; it was pinned only by explicit
`expectedConflictAfterRoundTrip: '(none)'` entries. Those entries are gone and the
field with them — the action now survives, asserted both structurally and
behaviourally.

Code deleted: `isSynthesizedAllColumnsKey` (the shape predicate) and both
`!synthesizedKey &&` guards in the emitter. `TableSchema.synthesizedPrimaryKey` (the
stored flag) and `findPKDefinition`'s `synthesized` return member **stay** — they are
read by the sibling `../lamina` repo's `lamina-quereus` adapter and their retirement
needs cross-repo sequencing (`tickets/blocked/debt-retire-quereus-synthesized-primary-key-flag.md`).
The flag's doc block was rewritten so it no longer cites the deleted predicate; it now
says the flag is the *only* sound answer, because no test over the schema's shape can
distinguish the two.

## Use cases to exercise

The point of the change, in SQL:

```sql
-- 1. A no-PK table now names its key. Emitted DDL contains PRIMARY KEY ("a", "b").
create table t (a integer, b text);

-- 2. A one-column no-PK table takes the INLINE branch — exactly ONE clause, not two.
create table t (a integer);          -- "a" INTEGER NOT NULL PRIMARY KEY

-- 3. The whole point: naming the key must not tighten it.
pragma default_column_nullability = 'nullable';
create table t (a integer, b text);  -- emit → re-parse under stock not_null → still NULL

-- 4. The live bug. Both of these used to decay to ABORT on reopen.
create table t (a integer primary key on conflict replace);
create table t (a integer not null on conflict replace, b text, primary key (a, b));

-- 5. Untouched: the empty-key singleton keeps its own emission path.
create table t (a integer, b text, primary key ());   -- PRIMARY KEY ()

-- 6. Legacy catalogs. DDL written before this change has no clause and must still
--    rehydrate to the all-columns key:
CREATE TABLE "main"."t" ("a" INTEGER NOT NULL, "b" TEXT NOT NULL)
```

## Validation run

All four legs, from repo root, all green:

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn test` | all workspaces pass (quereus **9637 passing**, 25 pending; store 1802; sync 725; others green) |
| `yarn lint` | clean (`packages/quereus` eslint **+** `tsc -p tsconfig.test.json --noEmit`, confirmed separately) |
| `yarn test:store` | **9627 passing**, 33 pending — the leg that actually persists and re-parses this DDL |

Caveat, stated plainly: `yarn test:store` was run **before** the last two spec tests
were added. Those two live in `packages/quereus/test/table-ddl-round-trip.spec.ts`, a
Mocha spec — `test:store` only re-runs the `.sqllogic` logic tests against LevelDB, so
it does not execute them. Everything `test:store` does cover ran after the source
change. The full `yarn test` (which does run them) was re-run afterwards.

## Test coverage — what was added, and the floor

`test/table-ddl-round-trip.spec.ts` is the harness for this change (18 shapes now).
Changes to it:

- Every `expectedClauses: 0` → `1`, with labels and per-case comments rewritten from
  "clause omitted / guard bails" to what the shape actually pins.
- Header section replaced: the "one non-uniform case, and what will change" narrative
  is now a plain statement of the rule with the history in one paragraph.
- `expectedConflictAfterRoundTrip` deleted (field + both entries) — no shape loses its
  action any more.
- `expectedNullability` **added** as an optional field. Without it the nullability leg
  was only ever "re-parse equals original", which is satisfiable by two wrong answers;
  the new nullable shapes pin the absolute answer.
- Four new shapes: the nullable composite and nullable single-column no-PK cases (the
  ones the file's own header said it could not assert before), plus explicit
  `expectedText` on the two all-columns `ON CONFLICT` shapes that previously lost it.
- The `expectedText` / `no ON CONFLICT expected` assertions were **decoupled** — they
  used to be an if/else, so adding `expectedText` to a conflict-free shape would have
  silently dropped its "must not contain ON CONFLICT" check. Now `expectedText` is
  asserted when present and the negative is driven off `expectedConflict`.
- Two new behavioural tests at the end: an all-columns key's column-declared `REPLACE`
  still replaces after a DDL round-trip (the live bug, proven by an insert that used to
  throw), and applying a no-`PRIMARY KEY` declaration twice emits zero schema-change
  events (the differ-churn regression the ticket flagged as most likely).

**`test/no-pk-nullability.spec.ts` was not in the ticket's file list but had to change** —
it asserted `.to.not.match(/primary key/i)` in three places. Those are now positive
assertions naming the exact expected clause text, and its header bullet was rewritten.
Reviewers: this is the file most likely to hide a stale expectation, since nobody
listed it.

### Known gaps in what I asserted

- **Maintained tables / materialized views.** `generateMaintainedTableDDL` shares
  `generateTableDDLInternal`, so a backing table with an all-columns physical key now
  emits a clause it previously omitted. The existing MV suites
  (`mv-backing-module.spec.ts`, `view-mv-ddl-persistence.spec.ts`,
  `maintained-table-attach-detach.spec.ts`, `mv-rename-propagation.spec.ts`) all pass,
  but I added **no** new MV-specific case for this shape. If you want one more probe,
  that is where I would put it.
- **Zero-column tables.** The old guard had an `n === 0` early return that disappeared
  with it. A zero-column table falls to `primaryKeyDefinition.length === 0` and emits
  `PRIMARY KEY ()` — the same text as before, since the guard's early return also left
  `synthesizedKey` false. Reasoned, not asserted: I did not confirm the parser even
  admits a zero-column `CREATE TABLE`.
- **`findPKDefinition`'s `warnLog`.** It still logs "No PRIMARY KEY explicitly defined"
  on the synthesis path. After a round-trip the re-parsed DDL names the key, so the
  warning stops firing for a persisted table — an improvement, and no test asserts on
  the line. Unverified beyond a grep.
- **Cross-package.** `quereus-store` and `quereus-sync` suites pass unchanged, but I
  did not audit their sources for a place that assumes a no-PK table's DDL is
  clause-free. The passing `rehydrate-catalog.spec.ts` and
  `pk-conflict-action-reopen.spec.ts` are the evidence, not an audit.
- **`../lamina`.** Not built against this change. The flag it reads is untouched, and
  the deleted predicate was not exported from the package entry point (checked: only
  `ddl-generator.ts` imported it), so the surface lamina consumes is unchanged — but
  that is reasoning, not a lamina build.

## Review findings

- Nothing parked as a tripwire or accepted tradeoff by this ticket; every concern above
  is either asserted or listed as a gap.
