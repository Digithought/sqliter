description: On INSERT, a computed column (GENERATED ALWAYS AS) and a DEFAULT expression are handed the values exactly as the caller typed them, while every other write path hands them the values after conversion to the column's declared type. So the same table with the same data can end up holding two different computed values depending on whether the row was inserted or updated — and simply touching an unrelated column silently rewrites the computed one.
files:
  - packages/quereus/src/planner/building/insert.ts               # createGeneratedColumnProjection + the DEFAULT projection — both run pre-conversion
  - packages/quereus/src/runtime/emit/insert.ts                   # buildRowCoercion runs AFTER those projections
  - packages/quereus/src/runtime/emit/update.ts                   # the correct two-phase shape to mirror
  - packages/quereus/src/planner/building/alter-table.ts          # ADD COLUMN backfill — also computes from the converted/stored row
  - packages/quereus/src/types/validation.ts                      # buildRowCoercion / buildCellCoercion
  - packages/quereus/test/logic/15.1.1-json-check-coercion.sqllogic   # already pins the CHECK half, for JSON only
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic
  - packages/quereus/test/logic/03.4-defaults.sqllogic
  - packages/quereus/test/dml-write-representation.spec.ts
  - docs/types.md                                                 # § Where coercion happens (and why exactly once)
  - docs/sql-alter.md                                             # line ~62 asserts backfill/INSERT parity that does not hold
  - docs/invariants.md                                            # `## RT — Runtime` is currently "Reserved."
repro: verified
difficulty: hard
----

# GENERATED and DEFAULT expressions see the unconverted row on INSERT

## Background: the rule this breaks

`docs/types.md` § "Where coercion happens (and why exactly once)" states the write-path
rule: a written value is converted to its column's declared logical type **once**, at the
top of the DML pipeline, and everything downstream sees that *declared form*. Conversion
cannot be repeated, because it is not idempotent — `'"Bob"'` into a `json` column parses
to the bare string `Bob`, and parsing `Bob` again throws.

Two spellings of the same value therefore exist at write time:

- **written form** — the value exactly as the statement supplied it (`'"Bob"'`,
  `'2099-01-01T00:00:00.000Z'`).
- **declared form** — the value after conversion to the column's declared type (`Bob`,
  `2099-01-01T00:00:00`).

CHECK constraints already see the declared form on every path. Computed columns do not.

## The defect

On INSERT, `GENERATED ALWAYS AS` and `DEFAULT` expressions are evaluated **before** the
conversion pass, so they read the written form. On UPDATE and on
`ALTER TABLE … ADD COLUMN` backfill they are evaluated **after** it, so they read the
declared form. Same table, same DDL, same input value — two answers.

### Verified reproductions

All four run on `main` at `v4.17.1`, against `packages/quereus/src` via
`yarn workspace @quereus/quereus run test:single`.

**1. Touching an unrelated column silently rewrites a computed column.** No column the
generated expression reads is changed, yet its value changes:

```sql
create table G (Id text primary key, V json, Note text,
                L integer generated always as (length(V)));
insert into G (Id, V, Note) values ('a', '"Bob"', 'n1');
select V, Note, L from G;          -- V='Bob', L=5   <- length of the written '"Bob"'
update G set Note = 'n2' where Id='a';
select V, Note, L from G;          -- V='Bob', L=3   <- length of the declared 'Bob'
```

**2. Same value, INSERT vs UPDATE, different computed result.**

```sql
insert into G (Id, V) values ('b', '"xx"');
update G set V = '"Bob"' where Id='b';
-- L = 3, where inserting the identical value gave L = 5
```

**3. `ALTER TABLE … ADD COLUMN … GENERATED` backfills one value and stores another for
rows inserted afterwards.**

```sql
create table V (id integer primary key, j json);
insert into V values (1, '"Bob"');
alter table V add column L integer generated always as (length(j));
select L from V where id = 1;      -- 3   (backfill: declared form)
insert into V (id, j) values (2, '"Bob"');
select L from V where id = 2;      -- 5   (INSERT: written form)
```

**4. The same split for `DEFAULT (new.<col>)`, contradicting a documented guarantee.**
`docs/sql-alter.md` states "a backfilled row and a row inserted afterwards under the same
DEFAULT hold the same value". They do not, whenever conversion actually changes the value:

```sql
create table U (id integer primary key, j json);
insert into U values (1, '"Bob"');
alter table U add column k text default (new.j);
select k from U where id = 1;      -- 'Bob'    (backfill)
insert into U (id, j) values (2, '"Bob"');
select k from U where id = 2;      -- '"Bob"'  (INSERT)
```

`datetime` shows the same split with a shape users notice — a generated `text` column over
a `datetime` column keeps the trailing `.000Z` on INSERT and loses it on any later UPDATE.
The json-into-json case (`add column k json default (new.j)`) happens to agree, because the
written form gets converted on its way into the JSON target anyway; that coincidence is
part of why this has gone unnoticed.

### Root cause — one decision, made twice, opposite ways

The conversion pass sits at a different point in the INSERT pipeline than in every other
write path:

| path | order |
|---|---|
| INSERT (`planner/building/insert.ts` then `runtime/emit/insert.ts`) | expand source + evaluate DEFAULTs, evaluate GENERATED (`createGeneratedColumnProjection`), **then** `buildRowCoercion` in `emitInsert` |
| UPDATE (`runtime/emit/update.ts`) | evaluate regular assignments, **`coerceRegular`**, evaluate GENERATED against the converted row, `coerceGenerated` |
| ADD COLUMN backfill (`planner/building/alter-table.ts`) | read the already-stored (declared-form) row, evaluate, `buildCellCoercion` on the one cell |

`emit/update.ts` carries an explicit comment for its ordering ("a generated column derives
from … the CONVERTED values of the regular assignments"). The INSERT path never made that
choice — the generated projections were built where the rest of the row expansion happens,
in the planner, and the conversion pass later landed downstream of them.

## Scope of the ticket

### Arm A — make INSERT match the other write paths

Evaluate `DEFAULT` and `GENERATED ALWAYS AS` expressions against the **converted** row on
INSERT, so all write paths agree.

Direction is not in doubt — UPDATE and ADD COLUMN backfill already do it, two of the three
paths, and it is what `docs/types.md` describes. Flipping those two to match INSERT would
instead mean a generated column recomputed by an UPDATE changes value, which is the bug in
reproduction 1.

The structural obstacle: on INSERT the DEFAULT and GENERATED expressions are *plan-level
projections* built in `planner/building/insert.ts`, while conversion is a *runtime* pass in
`emitInsert`. Two shapes to weigh:

- **Interleave in the planner.** Split the current single expansion projection into
  (supplied columns), then a new conversion step, then (DEFAULT projection), then
  (GENERATED projections), leaving `emitInsert`'s `buildRowCoercion` to cover only the
  DEFAULT and GENERATED cells. Needs a plan node for the conversion; none exists today.
- **Mirror `emitUpdate` in the emitter.** Move DEFAULT/GENERATED evaluation out of the
  projection chain and into `emitInsert` as phase 2 and phase 3, exactly as `emitUpdate`
  does. More faithful to the existing precedent, larger change to INSERT building.

Whichever shape is chosen, the "convert exactly once" rule must hold: a cell converted in
the first pass must be identity-skipped by the second, the way `emitUpdate`'s
`generatedCellTypes` arranges. Getting this wrong re-parses JSON and throws — that is the
failure mode `docs/types.md` warns about, so it is the first thing to test.

Also check the fourth site while in here: the `on conflict … do update` generated recompute
(`appendGeneratedRecomputes` in `planner/building/insert.ts`, evaluated by the DML
executor). Confirm which form it sees and bring it into line; if it already agrees, say so
in the handoff.

Behaviour change: some existing stored values change. Not a compatibility concern per
`AGENTS.md`, but the release note (Arm C) should name it.

### Arm B — pin the contract

The originating ticket assumed nothing pinned any of this. Not quite true — check the
existing coverage before adding:

- `test/logic/15.1.1-json-check-coercion.sqllogic` **already** covers immediate CHECK,
  deferred (subquery-bearing) CHECK, and UPDATE for JSON, and documents why the
  `OR REPLACE` NOT NULL DEFAULT substitution deliberately reads the written form and
  converts its own cell afterwards. Do not duplicate it.
- `test/dml-write-representation.spec.ts` pins what *storage* receives, not what an
  expression sees.
- `test/logic/06.9.1-json-coerce-once.sqllogic` pins that conversion happens once.

The genuine gaps:

- **Nothing at all covers `GENERATED` or `DEFAULT` value form** — that is why Arm A's
  defect survived.
- **No non-JSON type is covered.** `datetime` is the type the downstream report
  ([GH #28](https://github.com/gotchoices/quereus/issues/28)) was about and is the sharpest
  witness (`'2099-01-01T00:00:00.000Z'` becomes `2099-01-01T00:00:00`).

Add one sqllogic file that states the whole contract in one place — every expression
evaluated against a row being written sees the declared form — across immediate CHECK,
deferred CHECK, DEFAULT, and GENERATED, for INSERT and for UPDATE, on `datetime`. Include
the INSERT-vs-UPDATE and backfill-vs-INSERT *agreement* assertions above, since those are
the ones that actually caught this. For `test/logic/` numbering: the CHECK-coercion
neighbour is `15.1.1`, and generated columns live around `41`.

### Arm C — write down what the tests now guard

- **`docs/types.md` § Where coercion happens.** Its bullet list enumerates `emitInsert`,
  `emitUpdate`, the two post-pass single-cell injectors, and the ADD COLUMN backfill — and
  never says where DEFAULT and GENERATED evaluation sits in that order. That omission is
  what let the two paths diverge. State the contract positively: *every* expression
  evaluated against a row being written — CHECK, DEFAULT, GENERATED — sees the declared
  form, and name the guarding test.
- **`docs/sql-alter.md`** (line ~62) claims backfill/INSERT parity for expression DEFAULTs.
  Once Arm A lands the claim is true; leave the text, but make sure the new test guards it.
- **`docs/invariants.md`** — `## RT — Runtime` is currently just "Reserved.". This is a
  good first entry: it states a property the code upholds, violating it is a bug, it fits
  in 120 words, and it names concrete code sites. Follow the register's format exactly
  (`code:` / `guard:` / `doc:`) and check it with `yarn docs:check`.
- **A release note** for the 4.3.1 to 4.4.1 change described in GH #28: an immediate CHECK
  used to be handed the written form and now gets the declared form, the change was
  deliberate, and it is what fixed [GH #25](https://github.com/gotchoices/quereus/issues/25)
  (a deferred CHECK subquery comparing an unconverted `new.<col>` against an
  already-converted stored value, which therefore never matched). See `docs/releasing.md`
  for where release notes live.

## Out of scope

Whether a `datetime` column should preserve a `Z` suffix at all — i.e. whether the
downstream `like('%Z', Ts)` check could ever have been meaningful — is the
canonical-spelling question tracked in
`bug-datetime-literal-with-timezone-never-matches`. This ticket pins *when* conversion
happens relative to expression evaluation, and is independent of how that one lands.

## TODO

- Reproduce all four cases above in a scratch spec before changing anything, so the fix has
  a before/after.
- Decide the Arm A shape (planner-interleave vs emitter two-phase); mirror
  `emit/update.ts`'s identity-skip discipline so no cell converts twice.
- Move DEFAULT and GENERATED evaluation to the converted row on INSERT.
- Check the `on conflict … do update` generated recompute and bring it into line, or record
  that it already agrees.
- Add the contract sqllogic file: CHECK (immediate + deferred), DEFAULT, GENERATED, across
  INSERT and UPDATE, on `datetime`, plus the INSERT/UPDATE and backfill/INSERT agreement
  assertions.
- Update `docs/types.md` § Where coercion happens to state the contract and name the test.
- Add the `RT-001` entry to `docs/invariants.md`; run `yarn docs:check`.
- Add the 4.3.1 to 4.4.1 release note covering the immediate-CHECK form change.
- Run `yarn build`, `yarn test`, `yarn lint`.
