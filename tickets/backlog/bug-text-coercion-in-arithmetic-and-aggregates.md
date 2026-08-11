description: Text that looks like a number is turned into a number differently by arithmetic and by summarising functions than it is everywhere else in the engine — so a very large number stored as text loses its last digits when added up, and min()/max() over a text column can pick a different row than sorting the same column would.
prereq: debt-sqllogic-bigint-assertions-lossy
files:
  - packages/quereus/src/util/coercion.ts                     # coerceToNumberForArithmetic / tryCoerceToNumber (both return `number`); coerceForAggregate — the numeric-string conversion
  - packages/quereus/src/runtime/emit/binary.ts               # mixedBigIntArithmetic — consumer of the arithmetic coercion
  - packages/quereus/src/runtime/emit/aggregate-setup.ts      # computeAggregateSkipCoercion — which call sites skip the conversion
  - packages/quereus/src/runtime/emit/aggregate.ts            # stream aggregate — applies coerceForAggregate per value
  - packages/quereus/src/runtime/emit/hash-aggregate.ts       # hash aggregate — same
  - packages/quereus/src/types/builtin-types.ts               # INTEGER_TYPE.parse / NUMERIC_TYPE.parse — the already-correct sibling path
  - packages/quereus/test/logic/03.6-type-system.sqllogic     # where the CAST-side regression tests live
difficulty: medium
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Both arms change results that some application may already be relying on (a numeric min() over a text column, a rounded sum), and the arithmetic arm means threading arbitrary-precision values through the arithmetic path, which costs performance on the overwhelmingly common small-number case.
----

# One coercion module, two wrong answers

`packages/quereus/src/util/coercion.ts` holds the text→number conversions used by
arithmetic and by aggregates. Both of them differ from the conversion every *other* path in
the engine uses, and both differences are visible as wrong answers. They are one ticket
because they are one file and one decision: what does "this text is a number" mean here,
and does it have to agree with comparison, storage and `ORDER BY`.

## Arm A — large whole numbers held as text lose precision in arithmetic (verified)

JavaScript's plain number type holds whole numbers exactly only up to 9,007,199,254,740,991
(2^53 − 1). Quereus already handles this everywhere it converts text to a number *for
comparison or for storage* — those paths produce an exact arbitrary-precision value
(`INTEGER_TYPE.parse` / `NUMERIC_TYPE.parse`). Arithmetic and aggregation were never given
the same treatment, so the same text value silently rounds there:

```sql
select cast('9007199254740993' as integer);   -- 9007199254740993  (exact, correct)
select '9007199254740993' = 9007199254740993; -- true              (exact, correct)
select '9007199254740993' + 0;                -- 9007199254740992  (WRONG, rounded)
select sum(x) from (select '9007199254740993' as x);
                                              -- 9007199254740992  (WRONG, rounded)
```

The `sum` case is the more dangerous: the rounded value is then promoted back to an exact
big integer on the way out, so the result *looks* exact.

`coerceToNumberForArithmetic` and `tryCoerceToNumber` both return `number`, which is where
the precision is dropped; `mixedBigIntArithmetic` in `emit/binary.ts` is the consumer.

**Prerequisite:** the `.sqllogic` harness cannot currently tell a correct large result from
a wrong one — see `debt-sqllogic-bigint-assertions-lossy`. Any test written for this arm in
that harness will pass either way until that lands.

## Arm B — `min`/`max` over a text column coerce number-like strings (verified)

Before an aggregate steps a value, the engine converts a number-looking string to an actual
number so `sum`/`avg` accept `'12'`. That conversion is applied to every aggregate that is
not `count`, `group_concat`, or a `json_*` function — so `min` and `max` get it too.

```sql
create table t (id integer primary key, v text);
insert into t values (1, '5'), (2, '10');

select min(v) from t;                    -- 5      (a NUMBER, compared numerically)
select v from t order by v limit 1;      -- '10'   (text order)
```

Two problems in one:

- **Wrong row.** `min(v)` disagrees with `order by v limit 1`, which is how every other part
  of the engine orders a text column.
- **Wrong type out.** The column holds text; the aggregate hands back a number.

`computeAggregateSkipCoercion` (`emit/aggregate-setup.ts`) is the list of aggregates that
opt out of the conversion, and both the stream and hash aggregate paths apply it per value.

### Arm B is also blocking a permanent guard (added 2026-08 from the scalar-type-inference fix)

Re-verified at `61637588` with a third value present, so the wrong row and the wrong type are
separable:

```sql
create table m (id integer primary key, val text null);
insert into m values (1,'10'), (2,'20'), (3,'hello');
select min(val) from m;                    -- the NUMBER 10
select val from m order by val limit 1;    -- the STRING '10'
select min(val) from n;                    -- 'aa' — a non-numeric column is untouched
```

Beyond disagreeing with `ORDER BY`, this is a violation of rule R2 in `docs/types.md`
§ Physical representation at statement output: a TEXT-typed result column hands back a JS
number. Ticket `4-remaining-scalar-result-types-and-repr-net` (now complete) reconciled
every other announced-type/value disagreement and left the statement-egress representation
check (`QUEREUS_REPR_STRICT=1`, `Statement._iterateWithSignal`) at R1-only **solely because
of this arm** — the seam comment there says exactly how to widen it to full R2 once this
lands (two suite sites: `test/logic/25-aggregate-edge-cases.sqllogic` `mn`, and
`test/logic/14-utilities.sqllogic` `min(amount)`; announcing TEXT for `min(val)` is
*correct*, the value is what is wrong). That raises this arm's priority: it is the last
blocker for a permanent regression net, not only its own wrong answer.

Also: the `NOTE:` at `src/util/coercion.ts` (above `coerceAggregateValue`) still cites the
pre-garden slug `bug-text-minmax-numeric-coercion`. Repoint it at this ticket while you are
in the file.

## Notes for whoever picks this up

- The two arms pull in opposite directions on the same helper: arm A wants the conversion
  to be *more* faithful, arm B wants some callers not to convert at all. Settle the split
  between "what does this text mean as a number" and "which aggregates want a number" first.
- Whatever lands, `min`/`max` must agree with `ORDER BY`, which is the invariant to write a
  test against — not the specific values above.
- **Arm A's target representation is already settled and shipped.**
  `integer-canonical-representation` (landed) wrote down the rule for which JavaScript
  form a whole number takes — `number` inside the safe-integer range, exact `bigint`
  outside — in `docs/types.md` § "Physical representation", and canonicalized the
  arithmetic paths, `mixedBigIntArithmetic` included. It deliberately did **not** touch
  `coerceToNumberForArithmetic` / `tryCoerceToNumber`, which is this ticket's arm A:
  those still return `number` and still round. So arm A is now "widen the text→number
  coercion's return type to `number | bigint` and produce the canonical form
  (`util/numeric-canonical.ts`)", with the rule already decided and documented.
