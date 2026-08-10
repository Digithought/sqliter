import { expect } from 'chai';
import { Database, MemoryTableModule, FunctionFlags } from '../src/index.js';
import { createScalarFunction, createTableValuedFunction } from '../src/func/registration.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { Row, SqlValue } from '../src/common/types.js';
import type { BackingHost } from '../src/vtab/backing-host.js';
import type { TableSchema } from '../src/schema/table.js';

/**
 * The REPLICABLE determinism class (ticket `replicable-determinism-class`). A
 * derivation hosted on a backing that replicates across peers must additionally be
 * **bit-identical across platforms/app-versions** — strictly stronger than the engine's
 * per-database determinism gate. A function asserts this with `replicable: true`;
 * built-ins auto-qualify (Quereus owns its collation / case-folding / numeric formatting,
 * so a deterministic builtin cannot drift between peers' JS engines). The class is
 * **inert by default**: only a backing host that declares
 * `requiresReplicableDerivations` activates the create-time reject, so an ordinary
 * `using memory` MV sees zero behavior change.
 *
 * sqllogic cannot register UDFs or a custom backing host, so this focused spec defines a
 * `repl` host (the memory host with the requirement flipped on) and pins the gate.
 */

/** Wrap a memory {@link BackingHost} so it declares the replicable requirement, delegating
 *  every privileged operation to the inner host. */
function demandReplicable(inner: BackingHost): BackingHost {
	return {
		ownsConnection: conn => inner.ownsConnection(conn),
		connect: () => inner.connect(),
		applyMaintenance: (conn, ops) => inner.applyMaintenance(conn, ops),
		replaceContents: (rows, onDup) => inner.replaceContents(rows, onDup),
		scanEffective: (conn, req) => inner.scanEffective(conn, req),
		requiresReplicableDerivations: true,
	};
}

/** A memory module whose backing host demands REPLICABLE derivations — the future
 *  sync-store's behavior, modeled over the in-memory reference host. */
class ReplBackingModule extends MemoryTableModule {
	override getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const inner = super.getBackingHost(db, schemaName, tableName);
		return inner ? demandReplicable(inner) : undefined;
	}
}

/**
 * Models the synced-store shape for the ATTACH path: a module that materializes its
 * durable backing in the LATE `ensureBackingForAttach` seam (recorded via `ensured`)
 * BUT whose `getBackingHost` resolves EAGERLY and demands replicable — the contract
 * the demanding-host capability requires (the host capability surface exists at
 * plan-build time even though the physical store is built late). Because the host is
 * eager, the replicable gate fires at registration BEFORE the seam, so `ensured` stays
 * empty on a reject and is reached only on an accept.
 */
class EagerDemandWithSeamModule extends MemoryTableModule {
	readonly ensured: string[] = [];
	override getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const inner = super.getBackingHost(db, schemaName, tableName);
		return inner ? demandReplicable(inner) : undefined;
	}
	async ensureBackingForAttach(_db: Database, schemaName: string, tableName: string, _backingSchema: TableSchema): Promise<void> {
		this.ensured.push(`${schemaName}.${tableName}`);
	}
}

/**
 * The CONTRACT-VIOLATING combination the defensive guard exists to catch (and the
 * negative control when `demanding` is false): a module that is BOTH late — its
 * `getBackingHost` returns `undefined` until `ensureBackingForAttach` flips the
 * per-table ready flag — AND (optionally) demanding. With `demanding: true` the
 * replicable gate is skipped at registration (no host yet), so without the guard a
 * non-replicable body would slip through; the guard re-checks the now-present host and
 * raises a loud INTERNAL error. With `demanding: false` lateness alone is inert.
 */
class LateBackingModule extends MemoryTableModule {
	readonly ensured: string[] = [];
	private readonly ready = new Set<string>();
	private readonly demanding: boolean;
	constructor(demanding: boolean) { super(); this.demanding = demanding; }
	override getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const key = `${schemaName}.${tableName}`;
		if (!this.ready.has(key)) return undefined; // late: no host until the seam runs
		const inner = super.getBackingHost(db, schemaName, tableName);
		if (!inner) return undefined;
		return this.demanding ? demandReplicable(inner) : inner;
	}
	async ensureBackingForAttach(_db: Database, schemaName: string, tableName: string, _backingSchema: TableSchema): Promise<void> {
		this.ensured.push(`${schemaName}.${tableName}`);
		this.ready.add(`${schemaName}.${tableName}`); // host now resolves (eagerly, going forward)
	}
}

describe('Materialized view replicable-determinism gate', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('repl', new ReplBackingModule());
		// A non-replicable but DETERMINISTIC scalar UDF — deterministic so the determinism
		// gate passes and the *replicable* gate is the one that bites (the two are orthogonal).
		db.createScalarFunction('nonrepl', { numArgs: 1, deterministic: true }, (x) => Number(x) + 1);
		// A non-replicable custom collation (opt-in defaults to false), for the collation gate.
		// It carries a normalizer so it is usable as a GROUP BY key at all (a comparator-only
		// collation is refused earlier, by the key normalizer resolver) — `replicable` is
		// orthogonal to the normalizer, and the gate flags it whenever it governs the body.
		db.registerCollation('MYLOCALE', (a, b) => (a < b ? -1 : a > b ? 1 : 0), { normalizer: (s) => s });
		await db.exec(`
			create table t (id integer primary key, k integer, v integer, c text);
			insert into t values (1, 10, 100, 'alpha'), (2, 20, 200, 'beta');
		`);
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	/** Assert the create rejected for the replicable reason, naming the function. */
	function expectReplicableReject(err: Error, fnName: string, mvName: string): void {
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain(mvName);
		expect(err.message).to.contain(fnName);
		expect(err.message).to.contain('replicable');
		expect(db.schemaManager.getMaintainedTable('main', mvName), `${mvName} must not register`).to.be.undefined;
	}

	/** Assert the create rejected for the replicable-COLLATION reason, naming the collation. */
	function expectReplicableCollationReject(err: Error, collationName: string, mvName: string): void {
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain(mvName);
		expect(err.message).to.contain(collationName);
		expect(err.message).to.contain('collation');
		expect(err.message).to.contain('replicable');
		expect(db.schemaManager.getMaintainedTable('main', mvName), `${mvName} must not register`).to.be.undefined;
	}

	it('accepts a builtin-only body on a demanding host (builtins auto-qualify)', async () => {
		// `abs` is a built-in → stamped replicable → the gate passes.
		await db.exec('create materialized view m_ok using repl as select id, abs(v) as av from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_ok'), 'builtin-only body registers').to.not.be.undefined;
	});

	it('rejects a non-replicable scalar UDF in a projection on a demanding host', async () => {
		const err = await captureError('create materialized view m_proj using repl as select id, nonrepl(v) as nv from t;');
		expectReplicableReject(err, 'nonrepl', 'm_proj');
	});

	it('accepts the same UDF once it is declared replicable', async () => {
		// A deterministic UDF declared replicable: true qualifies, so the demanding host accepts it.
		db.createScalarFunction('repl_udf', { numArgs: 1, deterministic: true, replicable: true }, (x) => Number(x) + 1);
		await db.exec('create materialized view m_repl using repl as select id, repl_udf(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_repl'), 'replicable UDF body registers').to.not.be.undefined;
	});

	it('is inert on a non-demanding host: the non-replicable UDF creates `using memory`', async () => {
		// The load-bearing zero-behavior-change property: memory declares no requirement.
		await db.exec('create materialized view m_mem using memory as select id, nonrepl(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_mem'), 'inert host accepts a non-replicable UDF').to.not.be.undefined;
	});

	it('rejects a non-replicable UDF in a WHERE predicate', async () => {
		const err = await captureError('create materialized view m_where using repl as select id, v from t where nonrepl(v) > 0;');
		expectReplicableReject(err, 'nonrepl', 'm_where');
	});

	it('rejects a non-replicable UDF in a GROUP BY key', async () => {
		const err = await captureError('create materialized view m_group using repl as select nonrepl(k) as gk, count(*) as c from t group by nonrepl(k);');
		expectReplicableReject(err, 'nonrepl', 'm_group');
	});

	it('rejects a non-replicable UDF in an aggregate argument', async () => {
		const err = await captureError('create materialized view m_agg using repl as select k, sum(nonrepl(v)) as s from t group by k;');
		expectReplicableReject(err, 'nonrepl', 'm_agg');
	});

	it('rejects a non-replicable UDF in a lateral TVF argument', async () => {
		const err = await captureError('create materialized view m_tvf using repl as select t.id, f.value from t cross join lateral generate_series(1, nonrepl(t.id)) f;');
		expectReplicableReject(err, 'nonrepl', 'm_tvf');
	});

	it('rejects a non-replicable UDF nested inside a built-in call (the walk recurses into builtin args)', async () => {
		// `abs(nonrepl(v))`: the OUTER node is a replicable builtin, the offending UDF is its
		// argument. A walk that stops at the first qualifying function would miss it — confirm
		// it recurses through builtin args and names the inner UDF.
		const err = await captureError('create materialized view m_nested using repl as select id, abs(nonrepl(v)) as nv from t;');
		expectReplicableReject(err, 'nonrepl', 'm_nested');
	});

	it('rejects a non-replicable aggregate UDF, and accepts it once declared replicable', async () => {
		// Pins the createAggregateFunction(replicable) plumbing behaviorally, not just by type:
		// the aggregate node itself carries the (non-)replicable functionSchema. DETERMINISTIC so
		// the orthogonal determinism gate (full-rebuild floor) never bites the accept case.
		const detFlags = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;
		const step = (acc: unknown, x: SqlValue) => (acc as number) + Number(x);
		const final = (acc: unknown) => acc as number;
		db.createAggregateFunction('nonrepl_agg', { numArgs: 1, flags: detFlags, initialState: 0 }, step, final);
		db.createAggregateFunction('repl_agg', { numArgs: 1, flags: detFlags, replicable: true, initialState: 0 }, step, final);

		const err = await captureError('create materialized view m_agg_udf using repl as select k, nonrepl_agg(v) as s from t group by k;');
		expectReplicableReject(err, 'nonrepl_agg', 'm_agg_udf');

		await db.exec('create materialized view m_agg_ok using repl as select k, repl_agg(v) as s from t group by k;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_agg_ok'), 'replicable aggregate UDF body registers').to.not.be.undefined;
	});

	it('rejects a non-replicable TVF UDF, and accepts it once declared replicable', async () => {
		// Pins the createTableValuedFunction(replicable) plumbing behaviorally: the TVF reference
		// node itself carries the (non-)replicable functionSchema (distinct from a non-replicable
		// scalar UDF sitting in a *builtin* TVF's argument, which the m_tvf case covers).
		const returnType = {
			typeClass: 'relation' as const,
			isReadOnly: true,
			isSet: false,
			columns: [{
				name: 'a',
				type: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
				generated: true,
			}],
			keys: [],
			rowConstraints: [],
		};
		const gen = async function* (n: SqlValue): AsyncIterable<Row> {
			for (let i = 1; i <= Number(n); i++) yield [i];
		};
		db.registerFunction(createTableValuedFunction({ name: 'nonrepl_tvf', numArgs: 1, deterministic: true, returnType }, gen));
		db.registerFunction(createTableValuedFunction({ name: 'repl_tvf', numArgs: 1, deterministic: true, replicable: true, returnType }, gen));

		const err = await captureError('create materialized view m_tvf_udf using repl as select t.id, f.a from t cross join lateral nonrepl_tvf(t.id) f;');
		expectReplicableReject(err, 'nonrepl_tvf', 'm_tvf_udf');

		// The replicable TVF passes the replicable gate. The body is a keyless bag (a TVF
		// fanned-out join with no provable unique key), so it is rejected by the *separate*
		// cannotMaterialize gate — which is itself proof the replicable gate let it through.
		// Assert only that: the failure (if any) is NOT a replicable reject.
		const okErr = await captureError('create materialized view m_tvf_ok using repl as select t.id, f.a from t cross join lateral repl_tvf(t.id) f;');
		expect(okErr.message, 'replicable TVF UDF is not rejected for replicability').to.not.contain('non-replicable');
	});

	it('is NOT lifted by `pragma nondeterministic_schema` (orthogonal to the determinism gate)', async () => {
		// The pragma lifts the per-database determinism gate; the replicable class is a separate,
		// non-waivable concern, so the reject stands even with the pragma on.
		await db.exec('pragma nondeterministic_schema = true;');
		const err = await captureError('create materialized view m_pragma using repl as select id, nonrepl(v) as nv from t;');
		expectReplicableReject(err, 'nonrepl', 'm_pragma');
	});

	it('honors replicable on a hand-built schema via registerFunction', async () => {
		// The direct-schema registration path: a replicable: true field on a schema passed to
		// registerFunction is honored with no createScalarFunction-options plumbing.
		db.registerFunction(createScalarFunction(
			{ name: 'direct_repl', numArgs: 1, deterministic: true, replicable: true },
			(x) => Number(x) + 1,
		));
		await db.exec('create materialized view m_direct using repl as select id, direct_repl(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_direct'), 'direct-schema replicable body registers').to.not.be.undefined;
	});

	/**
	 * The REPLICABLE collation class (ticket `replicable-collation-class`). A second gate of
	 * the same shape under the SAME host capability: a custom collation whose sort/fold governs
	 * derived bytes (comparison / ORDER BY / GROUP BY / DISTINCT / backing key) can diverge
	 * derived bytes across peers' platforms, so on a demanding host every collation in the body
	 * must be built-in or declared `replicable: true`. The collation name rides each scalar
	 * node's resolved type (source 1, the body walk) plus the maintained table's declared
	 * backing-key collations (source 2, the closure). Built-ins (`BINARY`/`NOCASE`/`RTRIM`)
	 * auto-qualify; orthogonal to the determinism gate.
	 */
	describe('replicable-collation gate', () => {
		it('rejects a non-replicable custom collation in ORDER BY', async () => {
			const err = await captureError('create materialized view m_ord using repl as select id, c from t order by c collate MYLOCALE;');
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_ord');
		});

		it('rejects a non-replicable custom collation in a WHERE comparison', async () => {
			const err = await captureError("create materialized view m_where using repl as select id, c from t where c collate MYLOCALE = 'alpha';");
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_where');
		});

		it('rejects a non-replicable custom collation on a column projected into the body', async () => {
			// A bare COLLATE projection (the deliberately conservative over-reject — the value
			// is byte-copied, but the gate biases hard toward soundness: any non-builtin
			// collation name on any body scalar rejects).
			const err = await captureError('create materialized view m_proj using repl as select id, c collate MYLOCALE as ck from t;');
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_proj');
		});

		it('rejects a non-replicable custom collation in a GROUP BY key', async () => {
			const err = await captureError('create materialized view m_grp using repl as select c collate MYLOCALE as g, count(*) as n from t group by c collate MYLOCALE;');
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_grp');
		});

		it('accepts the same body once the collation is declared replicable', async () => {
			// Re-register MYLOCALE replicable: true (overwrites the beforeEach non-replicable
			// entry) — the demanding host then accepts the body the ORDER BY case rejected.
			db.registerCollation('MYLOCALE', (a, b) => (a < b ? -1 : a > b ? 1 : 0), { normalizer: (s) => s, replicable: true });
			await db.exec('create materialized view m_ord_ok using repl as select id, c from t order by c collate MYLOCALE;');
			expect(db.schemaManager.getMaintainedTable('main', 'm_ord_ok'), 'replicable-collation body registers').to.not.be.undefined;
		});

		it('accepts a built-in collation (NOCASE auto-qualifies)', async () => {
			await db.exec("create materialized view m_nocase using repl as select id, c from t where c collate NOCASE = 'alpha';");
			expect(db.schemaManager.getMaintainedTable('main', 'm_nocase'), 'builtin-collation body registers').to.not.be.undefined;
		});

		it('is inert on a non-demanding host: a custom-collation body creates `using memory`', async () => {
			// The load-bearing zero-behavior-change property for collations: memory declares no
			// requirement, so a custom collation in the body is untouched.
			await db.exec('create materialized view m_mem_coll using memory as select id, c from t order by c collate MYLOCALE;');
			expect(db.schemaManager.getMaintainedTable('main', 'm_mem_coll'), 'inert host accepts a custom-collation body').to.not.be.undefined;
		});

		it('rejects a backing-key collation the SELECT body never names (the second source)', async () => {
			// A maintained table whose backing key folds under a custom collation declared on a
			// secondary UNIQUE index — the body `select id, code from src` carries no MYLOCALE,
			// so ONLY the backing-key source can catch this (the body walk alone would miss it).
			await db.exec(`
				create table src (id integer primary key, code text);
				insert into src values (1, 'alpha');
				create table mt_key (id integer primary key, code text) using repl;
				create unique index mt_key_ix on mt_key (code collate MYLOCALE);
			`);
			const err = await captureError('alter table mt_key set maintained as select id, code from src;');
			expect(err.message).to.contain('MYLOCALE');
			expect(err.message).to.contain('collation');
			expect(err.message).to.contain('replicable');
			expect(db.schemaManager.getMaintainedTable('main', 'mt_key'), 'mt_key must not attach as maintained').to.be.undefined;
		});

		it('accepts a built-in backing-key collation (second-source NOCASE auto-qualifies)', async () => {
			// The negative control for the second source: a NOCASE secondary UNIQUE index
			// attaches fine, proving the reject above is the custom collation, not the index.
			await db.exec(`
				create table src2 (id integer primary key, code text);
				insert into src2 values (1, 'alpha');
				create table mt_key2 (id integer primary key, code text) using repl;
				create unique index mt_key2_ix on mt_key2 (code collate NOCASE);
				alter table mt_key2 set maintained as select id, code from src2;
			`);
			expect(db.schemaManager.getMaintainedTable('main', 'mt_key2'), 'builtin backing-key collation attaches').to.not.be.undefined;
		});

		it('does NOT lift the collation gate via `pragma nondeterministic_schema`', async () => {
			// The collation class is orthogonal to (and not waivable by) the determinism gate.
			await db.exec('pragma nondeterministic_schema = true;');
			const err = await captureError('create materialized view m_coll_pragma using repl as select id, c from t order by c collate MYLOCALE;');
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_coll_pragma');
		});

		it('rejects a non-replicable custom collation in a DISTINCT key', async () => {
			// DISTINCT dedup folds under the projected scalar's collation; the CollateNode
			// rides the projection so the body walk reaches it.
			const err = await captureError('create materialized view m_dist using repl as select distinct c collate MYLOCALE as ck from t;');
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_dist');
		});

		it('rejects a non-replicable custom collation buried in a subquery leg', async () => {
			// The collation appears ONLY inside a correlated/uncorrelated subquery — confirms
			// the `getChildren()` walk recurses through relational subtrees, not just the
			// top-level projection/WHERE (gap #4 in the handoff: previously unpinned).
			const err = await captureError("create materialized view m_subq using repl as select id from t where id in (select id from t t2 where t2.c collate MYLOCALE = 'alpha');");
			expectReplicableCollationReject(err, 'MYLOCALE', 'm_subq');
		});
	});

	/**
	 * Attach-path coverage for the LENIENT `tryResolveBackingHost` gate resolution and the
	 * defensive guard that backs its soundness claim (ticket
	 * `mv-replicable-gate-late-host-coverage`). The create-MV path is covered above; the
	 * `alter table … set maintained` ATTACH path runs the SAME gate at registration but
	 * resolves the host LENIENTLY — a module materializing its backing late has no host at
	 * gate time. These pin: (1) the attach-path gate rejects a non-replicable FUNCTION
	 * (existing attach coverage was collation-only); (2) the gate fires for an eager host
	 * that ALSO has a late seam, regardless of the seam; (3) the defensive guard converts
	 * the late+demanding contract violation into a loud INTERNAL error; (4) lateness alone
	 * (non-demanding) is inert.
	 */
	describe('attach-path gate + late-host defensive guard', () => {
		/** Assert the INTERNAL defensive-guard reject — the late+demanding contract violation. */
		function expectGuardReject(err: Error, mvName: string): void {
			expect(err.message).to.contain(mvName);
			expect(err.message).to.contain('requiresReplicableDerivations');
			expect(err.message).to.contain('plan-build time');
			expect(db.schemaManager.getMaintainedTable('main', mvName), `${mvName} must not register`).to.be.undefined;
		}

		it('rejects a non-replicable FUNCTION on the attach path (gate, host present at gate time)', async () => {
			// Existing attach coverage is collation-only; this pins the FUNCTION arm over the
			// `alter table … set maintained` ATTACH verb. `repl`'s host resolves eagerly, so the
			// gate fires at registration exactly as on the create path.
			await db.exec('create table mt_fn (id integer primary key, nv integer) using repl;');
			const err = await captureError('alter table mt_fn set maintained as select id, nonrepl(v) as nv from t;');
			expectReplicableReject(err, 'nonrepl', 'mt_fn');
		});

		it('gate fires for an eager host with a late-backing seam, and the seam runs only on accept', async () => {
			// Models the synced-store: host eager + demanding, durable store built in the late
			// `ensureBackingForAttach` seam. The gate must fire at registration BEFORE the seam, so
			// a reject never reaches `ensureBackingForAttach` — proving the gate firing does not
			// depend on the absence of a late seam.
			const mod = new EagerDemandWithSeamModule();
			db.registerModule('eager_seam', mod);

			await db.exec('create table mt_eager (id integer primary key, nv integer) using eager_seam;');
			const err = await captureError('alter table mt_eager set maintained as select id, nonrepl(v) as nv from t;');
			expectReplicableReject(err, 'nonrepl', 'mt_eager');
			expect(mod.ensured, 'the gate fires before the late seam on a reject').to.be.empty;

			// Accept control: a builtin-only body passes the gate, so the seam IS reached.
			await db.exec('create table mt_eager_ok (id integer primary key, av integer) using eager_seam;');
			await db.exec('alter table mt_eager_ok set maintained as select id, abs(v) as av from t;');
			expect(db.schemaManager.getMaintainedTable('main', 'mt_eager_ok'), 'builtin-only attach registers').to.not.be.undefined;
			expect(mod.ensured, 'the late seam ran on the accept').to.deep.equal(['main.mt_eager_ok']);
		});

		it('defensive guard: a late+demanding host rejects a BUILTIN-only body (INTERNAL, isolated from the gate)', async () => {
			// The canonical guard proof. The host resolves NO host until the late seam AND demands
			// replicable, so the gate at registration is skipped (no host). The body is builtin-only
			// (`abs`), so the ONLY thing that can reject is the GUARD, not the replicable gate. This
			// test FAILS if the guard is removed: the late host would silently register a maintained
			// table whose gate never ran — and a non-replicable body would then slip through.
			const mod = new LateBackingModule(/*demanding*/ true);
			db.registerModule('late_demand', mod);

			await db.exec('create table mt_late (id integer primary key, av integer) using late_demand;');
			const err = await captureError('alter table mt_late set maintained as select id, abs(v) as av from t;');
			expectGuardReject(err, 'mt_late');
			// The late seam was reached (it is where the host becomes resolvable); the guard fired
			// AFTER it, on the now-present demanding host.
			expect(mod.ensured, 'the late seam ran before the guard fired').to.deep.equal(['main.mt_late']);
		});

		it('defensive guard: the same late+demanding host also rejects a NON-replicable body (the hole is real)', async () => {
			// Proves the hole the guard closes: a `nonrepl` body on a late+demanding host SKIPS the
			// replicable gate (no host at gate time), so only the guard catches it — the same
			// INTERNAL error as the builtin-only case, NOT the replicable-function diagnostic.
			const mod = new LateBackingModule(/*demanding*/ true);
			db.registerModule('late_demand2', mod);

			await db.exec('create table mt_late2 (id integer primary key, nv integer) using late_demand2;');
			const err = await captureError('alter table mt_late2 set maintained as select id, nonrepl(v) as nv from t;');
			expectGuardReject(err, 'mt_late2');
		});

		it('negative control: a late but NON-demanding host attaches a non-replicable body fine (lateness alone is inert)', async () => {
			// Lateness is not the trigger — only late+demanding is. A non-demanding late host leaves
			// `requiresReplicableDerivations` undefined, so the guard is a no-op and the `nonrepl`
			// body attaches (mirrors the existing "inert on a non-demanding host" tests).
			const mod = new LateBackingModule(/*demanding*/ false);
			db.registerModule('late_inert', mod);

			await db.exec('create table mt_late_ok (id integer primary key, nv integer) using late_inert;');
			await db.exec('alter table mt_late_ok set maintained as select id, nonrepl(v) as nv from t;');
			expect(db.schemaManager.getMaintainedTable('main', 'mt_late_ok'), 'non-demanding late host attaches').to.not.be.undefined;
			expect(mod.ensured, 'the late seam ran (the host resolved through it)').to.deep.equal(['main.mt_late_ok']);
		});
	});
});
