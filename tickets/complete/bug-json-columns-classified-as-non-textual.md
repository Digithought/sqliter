----
description: Fixed a planner bug where a column declared as JSON was wrongly assumed to never hold a text string, which could let the query planner over-claim that a filter matches at most one row when it actually matches several.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # isNonTextualLogicalType (~291) delegates to logicalTypeCanHoldText
  - packages/quereus/test/planner/collation-soundness.spec.ts       # repro shape 5 + AST-gate describe block
  - packages/quereus-store/src/common/store-table.ts                # NOTE: tripwire on resolvePkKeyCollations
difficulty: easy
----

# Summary

`isNonTextualLogicalType` answered "can this logical type never hold a text
string?" and answered **yes** for `JSON`, because JSON's physical
representation is tagged `OBJECT`. That's false — `JSON_TYPE.parse` runs
input through `JSON.parse`, so a JSON scalar string round-trips to an
ordinary JS string (`'"Bob"'` stores as `Bob`). The predicate gates
`isValueDiscriminatingEquality` (and its AST twin
`isValueDiscriminatingAstComparison`), which decides whether an equality is
safe to mint plan-time value-level facts from (constant pins, equivalence
classes, mirror functional dependencies, join equi-pairs). With JSON wrongly
exempted, a `NOCASE` equality over two JSON operands could mint a false "at
most one row" claim even though `'Bob'` and `'bob'` are genuinely distinct
storage values that both match under `NOCASE`.

## The fix

Collapsed `isNonTextualLogicalType` into the negation of the already-correct,
already-exported `logicalTypeCanHoldText` (an allow-list over physical
representation: `INTEGER`/`REAL`/`BLOB`/`BOOLEAN` provably never hold a
string; everything else — including `OBJECT`/JSON — may):

```ts
function isNonTextualLogicalType(lt: LogicalType | undefined): boolean {
	return !logicalTypeCanHoldText(lt);
}
```

Behaviour changes, all conservative (the predicate only ever answers "non-
textual" *less* often than before, so every downstream gate becomes stricter):

- `JSON` is now potentially textual — the bug fix itself.
- `NULL` (the `NULL_TYPE` logical type, physical `NULL`) is now potentially
  textual, losing a theoretical optimization on an operand whose static type
  is exactly `NULL`. Nothing in the codebase mints such a comparison operand.
- `ANY` was previously special-cased by name; the allow-list catches it by
  physical representation (`NULL`) instead, so the name check is gone but the
  classification (potentially textual) is unchanged.

Stale `NOTE:` above `NEVER_TEXT_PHYSICAL_TYPES` (which forward-referenced this
ticket and predicted the collapse) removed. `columnCanHoldText` in
`packages/quereus-store/src/common/store-table.ts` untouched — it is a thin
`ColumnSchema`-shaped wrapper over the same `logicalTypeCanHoldText`, not a
divergent copy.

## Reproduction (fails before fix, passes after)

```sql
create table tj (j json, x integer, primary key (j, x)) using memory;
insert into tj values ('"Bob"',1), ('"bob"',1);
select * from tj where j = cast('"bob"' as json) collate nocase and x = 1;
```

Both rows are correctly returned either way — constant folding collapses the
`cast(... as json)` literal to a plain TEXT literal before the optimizer
rules consume the fact, so no query in the wild was ever observed returning
wrong **rows**. The bug lived in the logical plan's metadata: before the fix
`isAtMostOneRow(root)` was `true` and `keysOf(root)` contained an empty key
(claiming ≤1 row); after the fix `isAtMostOneRow(root)` is `false` and the
real composite key `[[0,1]]` is reported.

Reaching the bug needs a JSON-typed operand on **both sides** plus a
non-`BINARY` collation. A column-level `collate nocase` on a JSON column is
rejected at `CREATE TABLE` time (`JSON_TYPE.supportedCollations` is `[]`), so
the collation must arrive via an explicit `COLLATE` wrapper or the `json(...)`
function.

## Review findings

### What was checked

- **Read the implement diff cold** (`git show 9711741e`) before the handoff
  summary.
- **Every call site of the changed predicate**, exhaustively: `find_references`
  over `isNonTextualLogicalType` / `isStaticallyNonTextual` /
  `isValueDiscriminatingEquality` / `logicalTypeCanHoldText` across all
  packages. Four call sites — `isStaticallyNonTextual` (→
  `isValueDiscriminatingEquality`), and twice inside `astOperandContribution`
  (→ `isValueDiscriminatingAstComparison`). Case-by-case truth table over
  every `LogicalType` shape (`isTextual: true`; physical `TEXT`, `INTEGER`,
  `REAL`, `BLOB`, `BOOLEAN`, `OBJECT`, `NULL`; `undefined`) confirms the new
  predicate only ever *widens* "potentially textual". Every consumer treats
  "potentially textual" as the restrictive branch, so no call site can
  regress. This closes the implementer's second flagged gap.
- **`ANY_TYPE`/`NULL_TYPE` claim verified against source**
  (`types/builtin-types.ts`): both carry `physicalType: PhysicalType.NULL` and
  no `isTextual` marker, so the by-name `ANY` check really was redundant.
- **Sibling `isTextual` sites** swept for the same JSON hole:
  `expression.ts` (numeric↔textual cross-type coercion — JSON not coerced,
  no soundness impact), `emit/binary.ts` (fast-path *selection* only; both
  paths thread `collationFunc`, so no impact), `store-module.ts`
  `reconcilePkCollations`, `store-table.ts` `resolvePkKeyCollations`.
- **Docs**: `docs/optimizer-fd.md` (§ `extractEqualityFds`, § CHECK
  extraction) and `docs/types.md` (collation lattice) both describe the gate
  as "non-textual operands qualify" without enumerating which types are
  non-textual, so neither went stale. No doc edit needed.
- **Lint + tests**: `yarn workspace @quereus/quereus run lint` clean (exit 0);
  full suite **6736 passing, 9 pending**; `yarn workspaces foreach -A
  --no-private run build` clean.

### Minor findings — fixed in this pass

- **The AST-level gate had no test coverage at all.** `astOperandContribution`
  is where two of the three call sites live, and `isValueDiscriminatingAstComparison`
  had zero direct tests anywhere in the repo — the implementer's regression
  test only exercised the plan-node path. Added an `AST-level gate` describe
  block to `collation-soundness.spec.ts` with two tests: a NOCASE-declared
  JSON column is *not* collation-exempt (fails on pre-fix code, which returned
  `true`), and a NOCASE-declared INTEGER column still *is* (with TEXT as the
  negative control). This makes the fix's second half a real regression pin
  rather than a suite-wide "nothing broke".
- **Stale spec docstring.** The file header said it pins "the four reproduced
  unsoundness shapes"; there are now five. Corrected, and added a line naming
  what shape 5 is for.
- **Muddled doc comment.** The new comment on `isNonTextualLogicalType` said
  `NULL_TYPE` "covers `ANY` too", conflating two distinct logical types that
  merely share a physical representation. Reworded to name all three
  (`JSON` physical `OBJECT`; `ANY` and `NULL` physical `NULL`).

### Major findings — none

No new tickets filed. The fix is correct, minimal, and in the safe direction
at every call site; the truth-table sweep above found no consumer for which
widening "potentially textual" can lose a correct result.

### Tripwires — one, parked in code

`resolvePkKeyCollations` (`packages/quereus-store/src/common/store-table.ts`)
uses a bare `col.logicalType.isTextual` where its siblings use
`columnCanHoldText`, so a JSON primary-key column gets no key normalizer.
This is **sound today**: `reconcilePkCollations` skips the same column by the
same test, and JSON cannot declare a collation, so the column stays
BINARY-keyed *and* BINARY-compared — key bytes and enforced comparison agree.
It becomes a wrong-result bug the moment `JSON_TYPE.supportedCollations` (or
any other can-hold-text-but-not-`isTextual` type's) grows a non-BINARY entry.
Recorded as a `NOTE:` comment at that exact line, per the tripwire rule.

### Gaps the implementer flagged, and their disposition

- *"No test exercises actual wrong rows"* — accepted, and confirmed
  unreachable: constant folding collapses the only expressible JSON-typed
  constant operand before any rule consumes the fact. The new AST-gate tests
  pin the predicate directly instead, which is strictly the more durable
  assertion (it survives whatever constant folding does).
- *"I did not audit every other caller"* — done in this pass, see above.
- *"`NULL_TYPE` safety is asserted, not proven"* — the assertion is that
  nothing constructs a comparison operand whose static logical type is exactly
  `NULL_TYPE`. Even if one existed, the change makes the gate *stricter* for
  it (fewer facts minted), so the worst case is a lost optimization, never a
  wrong result. No test needed.
