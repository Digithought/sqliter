---
description: |
  When a transaction is open, the isolation layer asks the storage module "is there already a row
  with this key?" and believes the first row it gets back, without checking that the row actually
  has that key. A module is allowed to answer with more rows than were asked for, so the layer sees
  an unrelated row and either reports a duplicate-key error for a key that is not in the table, or
  silently drops the row being written.
files:
  - packages/quereus-isolation/src/isolated-table.ts   # getUnderlyingRow (~1577), getOverlayRow (~1516), keysEqual (~1557)
  - packages/quereus-isolation/src/flush.ts            # rowExistsInUnderlying (~111)
  - packages/quereus-isolation/src/filter-info.ts      # makePkPointLookupFilter, makeSecondaryIndexEqSeekFilter
  - packages/quereus/src/vtab/filter-info.ts           # makeIndexEqSeekFilterInfo (~127) — the `omit: true` assertion
  - packages/quereus-isolation/test/flush-probe-ordering.spec.ts  # template for the repro spec's scan-only module
  - docs/design-isolation-layer.md                     # § "Full-scan merge contract" (~line 633) — where the invariant belongs
difficulty: medium
repro: verified
---

# The isolation layer's PK probes must verify the rows they get back

## Root cause — one sentence

A hand-built `FilterInfo` passed straight to `VirtualTable.query()` is a **request for a seek, not
a contract**: the module never went through `getBestAccessPlan`, so it never claimed those
constraints, and it may legitimately answer with any superset of the requested rows — up to the
whole table. The isolation layer's three primary-key probes are the only callers in this repo that
consume such an answer **without re-checking it**.

## Why the module is within its rights

`docs/module-authoring.md` states the negotiation: a module applies a filter only if it marked that
filter handled in `getBestAccessPlan`; anything it declines "stays a residual above the boundary" —
applied by *the engine*, above the module. `IndexConstraintUsage.omit` is likewise an **output** of
that negotiation ("Quereus might skip re-checking this constraint"), i.e. the module's own claim.

The isolation layer's probes never run that negotiation. They build the `FilterInfo` themselves via
`makePkPointLookupFilter` → the engine's `makeIndexEqSeekFilterInfo`, which stamps
`aConstraintUsage: [{ argvIndex, omit: true }]` — asserting on the module's behalf something the
caller cannot know. And there is no engine above a direct `query()` call to reapply anything. So a
module that cannot seek those columns scans, returns every row, and the probe takes row #1.

Two in-repo modules happen to mask this and are not the point:

- **The store module** degrades a declined seek to `{ type: 'scan' }` and then re-applies
  `matchesFilters` itself (`store-table-scan.ts:116-150`), because it *claimed* the filters at plan
  time and only degraded at runtime. Belt-and-braces on its side, not an obligation on every side.
- **The memory module** seeks a semantic-ordering key fine (its BTree is typed).

A module that simply declines — the documented, correct behaviour when a column's logical type
orders by meaning rather than by stored bytes (`TIMESPAN`, `JSON`: `'PT120M'` and `'PT2H'` are one
value but two stored strings) — has no such fallback, and is what the original report hit.

Note the two places that already do this right, and are the pattern to copy:

- `findUnderlyingUniqueConflict` (`isolated-table.ts:1770`) seeks when it can, full-scans when it
  cannot, and re-applies `rowMatchesUniqueConstraint` per returned row either way — its doc comment
  says so explicitly: *"a module that ignores the index hint and returns extra rows stays correct"*.
- The engine's own `KeySetSemiJoin` stamps a multi-seek `FilterInfo` at runtime and keeps its key-set
  probe **unconditional** (`key-set-semi-join.ts:71-80`).

## The three probe sites

All three resolve at the same point and share one fix.

| site | current | consequence of a superset answer |
|---|---|---|
| `IsolatedTable.getUnderlyingRow` (~1577) | returns the first row yielded | `checkMergedPKConflict` reports `UNIQUE constraint failed: <table> PK.` for a key that is not in the table |
| `flush.ts` `rowExistsInUnderlying` (~111) | returns `true` on the first row yielded | commit flush classifies a fresh PK as an `update`, writes it against a key that does not exist, and **silently loses the row** |
| `IsolatedTable.getOverlayRow` (~1516) | returns the first row yielded | dormant with the default `MemoryTableModule` overlay, live the moment a host passes a scan-only module as `IsolationConfig.overlay` (a public option, `isolation-types.ts:27`): a bogus overlay hit makes `checkMergedPKConflict` return "no conflict" and misclassifies `insertTombstoneForPK` / `writeRelocatedRow` |

`IsolatedTable.keysEqual` (~1557) already spells exactly the comparison all three need — per PK
column's declared collation, and a semantic-ordering type's own comparator — and is not called by
any of them.

## Reproduction (verified 2026-08-15, in this repo)

No JSON or TIMESPAN needed: an `integer` primary key reproduces it. The trigger is the *module*, not
the type. Against an underlying that declines every filter and answers every `query()` with a full
scan — a legal scan-only module — inserting a second, distinct primary key fails:

```
1) autocommit: a second insert with a distinct PK is not a conflict:
   ConstraintError: UNIQUE constraint failed: t PK.
2) explicit transaction: a fresh PK is inserted, not swallowed:
   ConstraintError: UNIQUE constraint failed: t PK.
```

With `getUnderlyingRow` patched to verify (arm 1 only), both tests still fail — now as **silent row
loss**, no error at all:

```
AssertionError: expected [ [ 1, 'one' ] ] to deeply equal [ [ 1, 'one' ], [ 2, 'two' ] ]
```

That is arm 2 (`rowExistsInUnderlying`), which is *masked today* because arm 1 raises first. **Both
arms must land together** — fixing only the conflict check converts a loud false error into quiet
data loss.

The repro spec, verified and then removed from the tree so it does not sit red across other tickets.
Add it back as `packages/quereus-isolation/test/pk-probe-unfiltered.spec.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray, makeFullScanFilterInfo } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, SqlValue, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/**
 * A module that declines every pushed filter and answers every `query()` with a
 * full scan — the legal shape for a module that cannot seek the requested column.
 */
class ScanOnlyMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(_db: Db, _tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const rows = request.estimatedRows ?? 1000;
		return { handledFilters: request.filters.map(() => false), rows, cost: rows };
	}

	private wrap(table: UnderlyingTable): UnderlyingTable {
		return new Proxy(table, {
			get(target, prop) {
				if (prop === 'query') {
					return () => target.query!(makeFullScanFilterInfo());
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
		return this.wrap(await super.create(...args));
	}

	override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
		return this.wrap(await super.connect(...args));
	}
}

describe('isolation PK probe vs an underlying that scans', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new ScanOnlyMemoryModule() }));
		await db.exec('create table t (k integer primary key, v text) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval('select k, v from t order by k'));
		return out.map((r: any) => [r.k, r.v]);
	}

	it('autocommit: a second insert with a distinct PK is not a conflict', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two']]);
	});

	it('explicit transaction: a fresh PK is inserted, not swallowed', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two']]);
	});

	it('sanity: a genuine duplicate PK still conflicts', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		let threw = false;
		try {
			await db.exec(`insert into t values (1, 'again')`);
		} catch {
			threw = true;
		}
		expect(threw, 'a real duplicate must still be rejected').to.be.true;
	});
});
```

Worth adding beyond the above (all cheap on the same harness): a PK-relocating `update`, a compound
PK, and a `text` PK under `NOCASE` — the last one proves the verification is the *collation-aware*
`keysEqual` and not a binary compare, i.e. that a case-only PK rewrite is still recognised as the
same key rather than turned into a false miss. A false miss is the one new failure mode this fix
could introduce, so it deserves a test rather than an argument.

## Shape of the fix

One helper, three call sites, so the trust decision exists in exactly one place.

```ts
// packages/quereus-isolation/src/pk-probe.ts (new)

/** Equality over a PK tuple: each column under its declared collation, and a
 *  semantic-ordering type through its own comparator. */
export type PkEquals = (a: readonly SqlValue[], b: readonly SqlValue[]) => boolean;

/** Builds a PkEquals for `schema`'s primary key. Memoize per schema — this is
 *  on the per-write path. */
export function makePkEquals(schema: TableSchema, resolveCollation: CollationResolver): PkEquals;

/**
 * Finds the row of `table` carrying `pk`, driving the PK index when the module can
 * serve it.
 *
 * A hand-built FilterInfo is a REQUEST, not a contract: the module never negotiated
 * these constraints through getBestAccessPlan, so it may answer with any superset —
 * and there is no engine above this call to reapply a residual. Every yielded row is
 * therefore checked against `pk` before it is believed.
 */
export async function probeRowByPk(
	table: VirtualTable,
	pkIndices: readonly number[],
	pk: readonly SqlValue[],
	pkEquals: PkEquals,
): Promise<Row | undefined>;
```

Two points the implementation must not get wrong:

- **Scan the whole iteration for a match; do not check only row #1.** Checking row #1 and stopping
  turns today's false *positive* into a false *negative* — a real duplicate key would slip through
  and corrupt the table. For a module that seeks, the iteration is one row and nothing changes.
- **`IsolatedTable.keysEqual` must become the same code**, not a second copy. It already resolves
  collations and semantic comparators memoized per schema (`getPkCollations`,
  `getPkSemanticComparators`); the factory should preserve that memoization.

`flush.ts` needs no signature change: `VirtualTable.db` is public, so `applyOverlayToUnderlying` can
build the `PkEquals` once per flush from `underlyingSchema` + `underlyingTable.db.getCollationResolver()`.

## The `omit: true` question, settled

The source ticket asked whether `query(filterInfo)` obliges a module to apply unconsumed equality
constraints as a residual. **It does not** — see *"Why the module is within its rights"* above. So
`makeIndexEqSeekFilterInfo`'s `omit: true` asserts something its caller cannot know, and should
become `omit: false` with a comment saying why. This is safe: nothing in the repo reads the flag
(`grep -rn "\.omit" packages/*/src --include=*.ts` returns nothing; `table-access-nodes.ts:138`
counts `aConstraintUsage.length` for EXPLAIN only), and `rule-select-access-path` builds its own
`aConstraintUsage` inline rather than going through this helper — so the negotiated path, where
`omit: true` *is* earned, is untouched.

While there: `makeSecondaryIndexEqSeekFilter`'s doc comment
(`quereus-isolation/src/filter-info.ts:41-42`) claims "a module that ignores the `idxStr` index hint
still applies the equalities as a residual filter rather than returning the whole table". That is the
same false belief, written down. Its one caller is safe for a different reason — it re-checks every
returned row — and the comment should say that instead.

## TODO

- [ ] Add `packages/quereus-isolation/src/pk-probe.ts` with `PkEquals` / `makePkEquals` / `probeRowByPk`, matching over the whole iteration rather than the first row.
- [ ] Re-point `IsolatedTable.keysEqual` at `makePkEquals` so there is one definition, keeping the per-schema memoization.
- [ ] Route `IsolatedTable.getUnderlyingRow` and `IsolatedTable.getOverlayRow` through `probeRowByPk`.
- [ ] Route `flush.ts` `rowExistsInUnderlying` through `probeRowByPk`, building the `PkEquals` once per flush from `underlyingTable.db.getCollationResolver()`.
- [ ] Flip `makeIndexEqSeekFilterInfo`'s `aConstraintUsage` to `omit: false` and say why in the doc comment.
- [ ] Correct `makeSecondaryIndexEqSeekFilter`'s doc comment to state the real reason its caller is safe (per-row re-check in `findUnderlyingUniqueConflict`).
- [ ] Add `packages/quereus-isolation/test/pk-probe-unfiltered.spec.ts` (above), plus the PK-relocating update, compound-PK, and `NOCASE` text-PK cases.
- [ ] Add a `NOTE:` tripwire at `probeRowByPk`: a module that cannot seek now pays a full scan per probe instead of a wrong answer; if a scan-only backend ever shows up as slow on write-heavy transactions, cache the probe per statement rather than restoring the trust.
- [ ] `docs/design-isolation-layer.md` § "Full-scan merge contract" (~line 633) — the paragraph that lists "PK point lookups" among the layer's internal scans. State the invariant next to it: a hand-built FilterInfo is a seek *request*, the answer may be a superset, and every probe verifies before it believes.
- [ ] `docs/module-authoring.md` — one line where the `handledFilters` contract is stated, noting that a caller driving `query()` directly (outside the planner) has no engine residual and owns the re-check itself.
- [ ] Validate: `yarn workspace @quereus/isolation test`; `yarn build`; `yarn test` (the engine's `filter-info.ts` is touched, so the quereus suite must run too).
