/**
 * Row-local logical CHECK enforcement when the written value is NULL
 * (docs/lens.md § Constraint Attachment; ticket
 * `lens-row-local-checks-skipped-when-value-is-null`).
 *
 * A logical row-local CHECK is a predicate over the LOGICAL row, but the write
 * side historically attached it to the per-member physical write — which may
 * legitimately not happen for a row whose value is NULL (an optional member's
 * presence gate suppresses the member insert; an all-null assignment lowers to a
 * member DELETE; an omitted column plans no member op at all). This suite pins
 * the repaired seam: the CHECK is evaluated once per logical row written through
 * the lens, on the logical row image, regardless of which member relations the
 * row happens to touch and regardless of whether any written value is NULL.
 *
 * Table-driven over `(written value shape) × (insert | update)` so a future
 * write shape that bypasses the seam fails loudly rather than being discovered
 * by hand. The value-violating shapes double as controls: they were enforced
 * before this fix and must keep rejecting with the same constraint name.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type { MappingAdvertisement, LogicalColumnMapping } from '../src/vtab/mapping-advertisement.js';
import type { ModuleCapabilities } from '../src/vtab/capabilities.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, matcher: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		const msg = e instanceof Error ? e.message : String(e);
		expect(msg, `error message should match ${matcher}`).to.match(matcher);
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

/** A memory module that advertises whatever decomposition a test assigns. */
class AdvertisingModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
}

/**
 * The grandfathered-basis duals: a module declaring
 * `permitsGrandfatheredNotNullViolators` demotes `lens.nullability-mismatch` to
 * an advisory, so a `not null` logical column over a nullable-derived expression
 * DEPLOYS — and its NOT NULL obligation classifies `enforced-row-local`, the
 * shape the NOT NULL write-enforcement suites below exercise.
 */
class GrandfatheredAdvertisingModule extends AdvertisingModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsGrandfatheredNotNullViolators: true };
	}
}
class GrandfatheredMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsGrandfatheredNotNullViolators: true };
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

/**
 * Columnar split over main.W_core (anchor: id, name) and main.W_tag (optional:
 * tag), keyed by the logical PK `id` — the minimal decomposition shape of the
 * observed bug: the checked column lives on an optional member, so a NULL value
 * means "no member row".
 */
function split(): MappingAdvertisement {
	return {
		id: 'W_core',
		logicalTable: 'W',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'W_core',
			members: [
				{ relationId: 'W_core', relation: { schema: 'main', table: 'W_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('name', 'name')] },
				{ relationId: 'W_tag', relation: { schema: 'main', table: 'W_tag' }, presence: 'optional', columns: [colMap('tag', 'tag')] },
			],
			sharedKey: {
				kind: 'logical-tuple',
				keyColumnsByRelation: new Map<string, readonly string[]>([['W_core', ['id']], ['W_tag', ['id']]]),
			},
		},
	};
}

/**
 * Deploys the decomposition lens with the ticket's CHECK
 * (`tag is not null and tag <> 'bad'` on a *declared-nullable* column — the
 * check, not the declaration, carries the rule) and seeds one satisfying row.
 */
async function setup(db: Database): Promise<void> {
	const mod = new AdvertisingModule();
	mod.ads = [split()];
	db.registerModule('admod', mod);
	await db.exec('create table W_core (id integer primary key, name text) using admod');
	await db.exec('create table W_tag (id integer primary key, tag text) using admod');
	await db.exec("declare logical schema x { table W { id integer primary key, name text, tag text null constraint tag_rule check (tag is not null and tag <> 'bad') } }");
	await db.exec('apply schema x');

	await db.exec("insert into main.W_core values (1, 'alpha')");
	await db.exec("insert into main.W_tag values (1, 'seed')");
}

/** One write shape of the table-driven matrix. */
interface WriteCase {
	readonly label: string;
	readonly sql: string;
	/** `true` ⇒ the write must be rejected naming the constraint. */
	readonly rejected: boolean;
}

const CONSTRAINT = /lens:tag_rule/i;

const INSERT_CASES: readonly WriteCase[] = [
	{ label: 'A: explicit NULL', sql: "insert into x.W (id, name, tag) values (4, 'delta', null)", rejected: true },
	{ label: 'B: column omitted', sql: "insert into x.W (id, name) values (5, 'epsilon')", rejected: true },
	{ label: 'D (control): violating value', sql: "insert into x.W (id, name, tag) values (7, 'eta', 'bad')", rejected: true },
	{ label: 'satisfying value', sql: "insert into x.W (id, name, tag) values (8, 'theta', 'ok')", rejected: false },
];

const UPDATE_CASES: readonly WriteCase[] = [
	{ label: 'C: set to NULL', sql: 'update x.W set tag = null where id = 1', rejected: true },
	{ label: 'E (control): violating value', sql: "update x.W set tag = 'bad' where id = 1", rejected: true },
	{ label: 'satisfying value', sql: "update x.W set tag = 'fine' where id = 1", rejected: false },
	{ label: 'sibling column only (row image stays valid)', sql: "update x.W set name = 'renamed' where id = 1", rejected: false },
];

describe('lens row-local CHECK on a NULL write — decomposition', () => {
	for (const c of INSERT_CASES) {
		it(`insert — ${c.label} ${c.rejected ? 'rejects' : 'succeeds'}`, async () => {
			const db = new Database();
			try {
				await setup(db);
				if (c.rejected) {
					await expectThrows(() => db.exec(c.sql), CONSTRAINT);
				} else {
					await db.exec(c.sql);
				}
			} finally {
				await db.close();
			}
		});
	}

	for (const c of UPDATE_CASES) {
		it(`update — ${c.label} ${c.rejected ? 'rejects' : 'succeeds'}`, async () => {
			const db = new Database();
			try {
				await setup(db);
				if (c.rejected) {
					await expectThrows(() => db.exec(c.sql), CONSTRAINT);
					// The rejected update must not have overwritten the stored value.
					expect(await rows(db, "select tag from main.W_tag where id = 1")).to.deep.equal([{ tag: 'seed' }]);
				} else {
					await db.exec(c.sql);
				}
			} finally {
				await db.close();
			}
		});
	}

	it('a rejected explicit-NULL insert leaves no partial member rows behind', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec("insert into x.W (id, name, tag) values (4, 'delta', null)"), CONSTRAINT);
			expect(await rows(db, 'select id from main.W_core where id = 4')).to.deep.equal([]);
			expect(await rows(db, 'select id from main.W_tag where id = 4')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('`or ignore` skips the whole logical row, not just the violating member', async () => {
		const db = new Database();
		try {
			await setup(db);
			// The envelope seam evaluates before any member op, so an ignored row leaves
			// NOTHING behind — the pre-fix member-riding seam could skip only the violating
			// member's row and still write its siblings (a partial-row hazard).
			await db.exec("insert or ignore into x.W (id, name, tag) values (4, 'delta', null), (8, 'theta', 'ok')");
			expect(await rows(db, 'select id from main.W_core order by id')).to.deep.equal([{ id: 1 }, { id: 8 }]);
			expect(await rows(db, 'select id from main.W_tag order by id')).to.deep.equal([{ id: 1 }, { id: 8 }]);
		} finally {
			await db.close();
		}
	});

	it('a grandfathered violating row stays readable but is not writable through the lens', async () => {
		const db = new Database();
		try {
			await setup(db);
			// Seeded straight into the basis, so the lens never gated it: id 9 has no W_tag
			// row at all ⇒ its logical `tag` is NULL ⇒ the stored image violates the CHECK.
			await db.exec("insert into main.W_core values (9, 'iota')");
			expect(await rows(db, 'select id, tag from x.W where id = 9')).to.deep.equal([{ id: 9, tag: null }]);
			// Assigning an UNRELATED column still re-reads the whole logical row, whose
			// post-write image is still violating — standard CHECK-on-UPDATE semantics, and
			// the boundary of read-side grandfathering.
			await expectThrows(() => db.exec("update x.W set name = 'renamed' where id = 9"), CONSTRAINT);
			expect(await rows(db, 'select name from main.W_core where id = 9')).to.deep.equal([{ name: 'iota' }]);
		} finally {
			await db.close();
		}
	});

	it('the read path is untouched — a stored violating row stays readable', async () => {
		const db = new Database();
		try {
			await setup(db);
			// Direct basis write bypasses the lens (grandfather-style seed).
			await db.exec("insert into main.W_core values (9, 'iota')");
			expect(await rows(db, 'select id, tag from x.W where id = 9')).to.deep.equal([{ id: 9, tag: null }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens row-local CHECK on a NULL write — single-source', () => {
	/**
	 * The same rule over a single-source (non-decomposition) lens. Here the base
	 * op always carries every basis column (an explicit NULL / omitted column
	 * still produces the one write row), so the routed basis-term check sees the
	 * NULL and rejects — this spine had no hole. Pinned so the decomposition fix
	 * cannot regress it and so the boundary between the two spines stays visible.
	 */
	async function setupSingle(db: Database): Promise<void> {
		await db.exec('declare schema y { table W { id integer primary key, name text, tag text null } }');
		await db.exec('apply schema y');
		await db.exec("declare logical schema x { table W { id integer primary key, name text, tag text null constraint tag_rule check (tag is not null and tag <> 'bad') } }");
		await db.exec('declare lens for x over y { }');
		await db.exec('apply schema x');
		await db.exec("insert into y.W values (1, 'alpha', 'seed')");
	}

	const SINGLE_CASES: readonly WriteCase[] = [
		{ label: 'A: explicit NULL insert', sql: "insert into x.W (id, name, tag) values (4, 'delta', null)", rejected: true },
		{ label: 'B: column omitted insert', sql: "insert into x.W (id, name) values (5, 'epsilon')", rejected: true },
		{ label: 'C: update to NULL', sql: 'update x.W set tag = null where id = 1', rejected: true },
		{ label: 'D (control): violating insert', sql: "insert into x.W (id, name, tag) values (7, 'eta', 'bad')", rejected: true },
		{ label: 'E (control): violating update', sql: "update x.W set tag = 'bad' where id = 1", rejected: true },
		{ label: 'satisfying insert', sql: "insert into x.W (id, name, tag) values (8, 'theta', 'ok')", rejected: false },
	];

	for (const c of SINGLE_CASES) {
		it(`${c.label} ${c.rejected ? 'rejects' : 'succeeds'}`, async () => {
			const db = new Database();
			try {
				await setupSingle(db);
				if (c.rejected) {
					await expectThrows(() => db.exec(c.sql), CONSTRAINT);
				} else {
					await db.exec(c.sql);
				}
			} finally {
				await db.close();
			}
		});
	}
});

describe('lens row-local CHECK seam routing — subquery-bearing checks defer to commit', () => {
	/**
	 * A relation-reading row-local CHECK must take the DEFERRED (commit-time)
	 * logical-row re-read, not the row-time envelope — the timing every
	 * relation-reading check gets from the constraint pipeline. The two shapes
	 * below differ only in where the subquery sits in the AST, so they pin that
	 * the subquery-detection walk descends through container nodes that carry no
	 * `type` discriminant of their own (a CASE's when/then pairs) rather than
	 * stopping at them and mis-routing the check to the envelope.
	 */
	async function setupSubquery(db: Database, checkSql: string): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [split()];
		db.registerModule('admod', mod);
		await db.exec('create table W_core (id integer primary key, name text) using admod');
		await db.exec('create table W_tag (id integer primary key, tag text) using admod');
		await db.exec('create table Allowed (name text primary key) using admod');
		await db.exec(`declare logical schema x { table W { id integer primary key, name text, tag text null, ${checkSql} } }`);
		await db.exec('apply schema x');
	}

	const SUBQUERY_SHAPES: ReadonlyArray<{ label: string; check: string }> = [
		{
			label: 'bare exists(…)',
			check: "constraint tag_rule check (exists (select 1 from Allowed where Allowed.name = tag))",
		},
		{
			label: 'exists(…) nested in a CASE',
			check: "constraint tag_rule check (case when exists (select 1 from Allowed where Allowed.name = tag) then 1 else 0 end = 1)",
		},
	];

	for (const shape of SUBQUERY_SHAPES) {
		it(`${shape.label}: a row made legal later in the same transaction is accepted`, async () => {
			const db = new Database();
			try {
				await setupSubquery(db, shape.check);
				// The allow-list entry lands AFTER the lens write, in the same transaction:
				// only a commit-time evaluation sees it. A row-time evaluation rejects here.
				await db.exec('begin');
				await db.exec("insert into x.W (id, name, tag) values (1, 'alpha', 'late')");
				await db.exec("insert into main.Allowed values ('late')");
				await db.exec('commit');
				expect(await rows(db, 'select id, tag from x.W')).to.deep.equal([{ id: 1, tag: 'late' }]);
			} finally {
				await db.close();
			}
		});

		it(`${shape.label}: a non-ABORT conflict clause is refused rather than silently skipped`, async () => {
			const db = new Database();
			try {
				await setupSubquery(db, shape.check);
				await db.exec("insert into main.Allowed values ('ok')");
				// A non-ABORT OR clause forces the deferred re-read to row time, where the
				// written row is not yet in the logical image and the check cannot see the
				// violation. Refuse the statement instead of accepting a violating row.
				for (const clause of ['or ignore', 'or fail', 'or rollback', 'or replace']) {
					await expectThrows(
						() => db.exec(`insert ${clause} into x.W (id, name, tag) values (2, 'beta', 'nope')`),
						/non-ABORT conflict clause forces row-time evaluation/i);
				}
				expect(await rows(db, 'select id from x.W')).to.deep.equal([]);
				// The plain form still works for a satisfying row.
				await db.exec("insert into x.W (id, name, tag) values (3, 'gamma', 'ok')");
			} finally {
				await db.close();
			}
		});

		it(`${shape.label}: a genuinely disallowed value still rejects`, async () => {
			const db = new Database();
			try {
				await setupSubquery(db, shape.check);
				await db.exec("insert into main.Allowed values ('ok')");
				await expectThrows(() => db.exec("insert into x.W (id, name, tag) values (2, 'beta', 'nope')"), CONSTRAINT);
				expect(await rows(db, 'select id from x.W')).to.deep.equal([]);
			} finally {
				await db.close();
			}
		});
	}
});

describe('lens row-local CHECK row addressing — member-hop vs loud refusal', () => {
	/**
	 * A hidden (surrogate) shared key with the logical PK `id` on the NON-anchor
	 * member U_key. With `presence: 'mandatory'` the deferred re-read addresses
	 * the written row by hopping through U_key (the member-hop — every member's
	 * key column carries the same surrogate), so the UPDATE seam ENFORCES. With
	 * `presence: 'optional'` the hop could be legitimately empty (an absent
	 * member row would make the re-read pass vacuously), so the write refuses
	 * with `lens-row-local-unenforceable` rather than silently skipping the
	 * check — the optional shape deploys only because the logical `id` carries a
	 * default (an undefaulted `not null` over a nullable-derived column blocks
	 * at deploy on this capability-less basis).
	 *
	 * Only the seams that need to ADDRESS the written row are affected: the
	 * subquery-free INSERT rides the envelope, which needs no address and keeps
	 * enforcing in both shapes.
	 */
	function pkOffAnchor(pkMemberPresence: 'mandatory' | 'optional'): MappingAdvertisement {
		return {
			id: 'U_core',
			logicalTable: 'W',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'U_core',
				members: [
					{ relationId: 'U_core', relation: { schema: 'main', table: 'U_core' }, presence: 'mandatory', columns: [colMap('name', 'name')] },
					{ relationId: 'U_key', relation: { schema: 'main', table: 'U_key' }, presence: pkMemberPresence, columns: [colMap('id', 'id')] },
					{ relationId: 'U_tag', relation: { schema: 'main', table: 'U_tag' }, presence: 'optional', columns: [colMap('tag', 'tag')] },
				],
				sharedKey: {
					kind: 'surrogate',
					keyColumnsByRelation: new Map<string, readonly string[]>([['U_core', ['sid']], ['U_key', ['key_sid']], ['U_tag', ['tag_sid']]]),
				},
			},
		};
	}

	async function setupPkOffAnchor(db: Database, pkMemberPresence: 'mandatory' | 'optional'): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [pkOffAnchor(pkMemberPresence)];
		db.registerModule('admod', mod);
		await db.exec('create table U_core (sid integer primary key default (coalesce((select max(sid) from U_core), 0) + mutation_ordinal()), name text) using admod');
		await db.exec('create table U_key (key_sid integer primary key, id integer) using admod');
		await db.exec('create table U_tag (tag_sid integer primary key, tag text) using admod');
		const idDecl = pkMemberPresence === 'optional' ? 'id integer primary key default 0' : 'id integer primary key';
		await db.exec(`declare logical schema x { table W { ${idDecl}, name text, tag text null constraint tag_rule check (tag is not null and tag <> 'bad') } }`);
		await db.exec('apply schema x');
		await db.exec("insert into main.U_core values (1, 'alpha')");
		await db.exec('insert into main.U_key values (1, 1)');
		await db.exec("insert into main.U_tag values (1, 'seed')");
	}

	it('a PK on a mandatory non-anchor member is addressed via the member-hop: UPDATE enforces', async () => {
		const db = new Database();
		try {
			await setupPkOffAnchor(db, 'mandatory');
			// Filtered on the ANCHOR (`name`) so the fan-out's own non-anchor-predicate
			// guard does not preempt the seam under test.
			await expectThrows(
				() => db.exec("update x.W set tag = 'bad' where name = 'alpha'"),
				CONSTRAINT);
			await expectThrows(
				() => db.exec('update x.W set tag = null where name = \'alpha\''),
				CONSTRAINT);
			expect(await rows(db, 'select tag from main.U_tag where tag_sid = 1')).to.deep.equal([{ tag: 'seed' }]);
			await db.exec("update x.W set tag = 'ok' where name = 'alpha'");
			expect(await rows(db, 'select tag from x.W')).to.deep.equal([{ tag: 'ok' }]);
		} finally {
			await db.close();
		}
	});

	it('a PK on an OPTIONAL member cannot be addressed: the UPDATE refuses loudly instead of skipping', async () => {
		const db = new Database();
		try {
			await setupPkOffAnchor(db, 'optional');
			await expectThrows(
				() => db.exec("update x.W set tag = 'ok' where name = 'alpha'"),
				/cannot be addressed in the logical view/i);
			expect(await rows(db, 'select tag from main.U_tag where tag_sid = 1')).to.deep.equal([{ tag: 'seed' }]);
		} finally {
			await db.close();
		}
	});

	for (const presence of ['mandatory', 'optional'] as const) {
		it(`the INSERT envelope needs no row address, so it still enforces (${presence} PK member)`, async () => {
			const db = new Database();
			try {
				await setupPkOffAnchor(db, presence);
				await expectThrows(() => db.exec("insert into x.W (id, name, tag) values (2, 'beta', 'bad')"), CONSTRAINT);
				await db.exec("insert into x.W (id, name, tag) values (3, 'gamma', 'ok')");
			} finally {
				await db.close();
			}
		});
	}
});

// ---------------------------------------------------------------------------
// NOT NULL as a row-local obligation (ticket lens-logical-not-null-never-
// enforced-on-write): the second axis of the constraint-class × value-shape
// matrix. Same seams as the CHECK cases above, same value shapes, but the rule
// comes from the column's `not null` declaration — previously never collected,
// so every write below persisted NULL into a `not null` column. Requires a
// grandfathered basis (the nullable-derived shape), since over a strict basis
// the declaration either proves (non-nullable derived) or blocks the deploy.
// ---------------------------------------------------------------------------

const NOT_NULL_VIOLATION = /NOT NULL constraint failed: W\.tag/;

describe('lens logical NOT NULL on a write — decomposition over a grandfathered basis', () => {
	/**
	 * The Lamina shape: per-column optional member, so `tag` derives nullable
	 * through the outer join and the logical `not null` demotes to an advisory at
	 * deploy — while its write-time obligation classifies `enforced-row-local`.
	 * Row 1 is fully populated; row 2 is grandfathered (anchor only, `tag` reads
	 * NULL — seeded straight into the basis, past the lens).
	 */
	async function setupNotNull(db: Database): Promise<void> {
		const mod = new GrandfatheredAdvertisingModule();
		mod.ads = [split()];
		db.registerModule('admod', mod);
		await db.exec('create table W_core (id integer primary key, name text) using admod');
		await db.exec('create table W_tag (id integer primary key, tag text) using admod');
		await db.exec('declare logical schema x { table W { id integer primary key, name text, tag text not null } }');
		await db.exec('apply schema x');
		await db.exec("insert into main.W_core values (1, 'alpha')");
		await db.exec("insert into main.W_tag values (1, 'seed')");
		await db.exec("insert into main.W_core values (2, 'beta')");
	}

	const INSERT_NN: readonly WriteCase[] = [
		{ label: 'A: explicit NULL', sql: "insert into x.W (id, name, tag) values (4, 'delta', null)", rejected: true },
		{ label: 'B: column omitted', sql: "insert into x.W (id, name) values (5, 'epsilon')", rejected: true },
		{ label: 'satisfying value', sql: "insert into x.W (id, name, tag) values (8, 'theta', 'ok')", rejected: false },
	];

	for (const c of INSERT_NN) {
		it(`insert — ${c.label} ${c.rejected ? 'rejects as a NOT NULL violation' : 'succeeds'}`, async () => {
			const db = new Database();
			try {
				await setupNotNull(db);
				if (c.rejected) {
					await expectThrows(() => db.exec(c.sql), NOT_NULL_VIOLATION);
					// Atomic: no partial member rows behind the rejected logical row.
					expect(await rows(db, 'select id from main.W_core where id > 2')).to.deep.equal([]);
					expect(await rows(db, 'select id from main.W_tag where id > 1')).to.deep.equal([]);
				} else {
					await db.exec(c.sql);
				}
			} finally {
				await db.close();
			}
		});
	}

	it('update — C: set to NULL rejects at commit as a NOT NULL violation', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			// The all-null assignment lowers to a member DELETE; the deferred
			// logical-row re-read (OLD-correlated) still sees the emptied image.
			await expectThrows(() => db.exec('update x.W set tag = null where id = 1'), NOT_NULL_VIOLATION);
			expect(await rows(db, 'select tag from main.W_tag where id = 1')).to.deep.equal([{ tag: 'seed' }]);
		} finally {
			await db.close();
		}
	});

	it('update — filling the grandfathered cell in succeeds (and reads back)', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			await db.exec("update x.W set tag = 'filled' where id = 2");
			expect(await rows(db, 'select id, tag from x.W order by id')).to.deep.equal([
				{ id: 1, tag: 'seed' },
				{ id: 2, tag: 'filled' },
			]);
		} finally {
			await db.close();
		}
	});

	it('update — a sibling column of a grandfathered row rejects (whole-row semantics, the write-side boundary of grandfathering)', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			// Same posture the CHECK class pins above: the deferred re-read evaluates
			// the whole post-write logical image, and row 2's `tag` is still NULL.
			// Fill the column in (or combine the assignments) to update such a row.
			await expectThrows(() => db.exec("update x.W set name = 'renamed' where id = 2"), NOT_NULL_VIOLATION);
			expect(await rows(db, 'select name from main.W_core where id = 2')).to.deep.equal([{ name: 'beta' }]);
			// The combined assignment repairs the row and passes.
			await db.exec("update x.W set name = 'renamed', tag = 'filled' where id = 2");
			expect(await rows(db, 'select id, name, tag from x.W where id = 2')).to.deep.equal([
				{ id: 2, name: 'renamed', tag: 'filled' },
			]);
		} finally {
			await db.close();
		}
	});

	it('update — a sibling column of a VALID row succeeds', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			await db.exec("update x.W set name = 'renamed' where id = 1");
			expect(await rows(db, 'select name, tag from x.W where id = 1')).to.deep.equal([{ name: 'renamed', tag: 'seed' }]);
		} finally {
			await db.close();
		}
	});

	it('`insert or ignore` skips the NULL row and keeps the satisfying one (physical NOT NULL parity)', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			await db.exec("insert or ignore into x.W (id, name, tag) values (4, 'delta', null), (8, 'theta', 'ok')");
			expect(await rows(db, 'select id from main.W_core order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 8 }]);
		} finally {
			await db.close();
		}
	});

	it('reads are untouched: the grandfathered row stays readable (NULL), deletable, and the deploy carries the advisory', async () => {
		const db = new Database();
		try {
			await setupNotNull(db);
			expect(await rows(db, 'select id, tag from x.W order by id')).to.deep.equal([
				{ id: 1, tag: 'seed' },
				{ id: 2, tag: null },
			]);
			const report = db.declaredSchemaManager.getDeployedLensReport('x');
			expect(
				report?.warnings.some(w => w.code === 'lens.nullability-mismatch' && w.site.column === 'tag'),
				'nullability advisory demoted, not silenced',
			).to.equal(true);
			await db.exec('delete from x.W where id = 2');
			expect(await rows(db, 'select id from x.W')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens logical NOT NULL on a write — single-source over a grandfathered basis', () => {
	/** Name-match single-source: the routed basis-term seam (`NEW.tag is not null`). */
	async function setupSingleNotNull(db: Database): Promise<void> {
		db.registerModule('gfmem', new GrandfatheredMemoryModule());
		await db.exec('create table W (id integer primary key, name text, tag text null) using gfmem');
		await db.exec('declare logical schema x { table W { id integer primary key, name text, tag text not null } }');
		await db.exec('apply schema x');
		await db.exec("insert into main.W values (1, 'alpha', 'seed')");
		await db.exec("insert into main.W (id, name, tag) values (2, 'beta', null)"); // grandfathered
	}

	const SINGLE_NN: readonly WriteCase[] = [
		{ label: 'A: explicit NULL insert', sql: "insert into x.W (id, name, tag) values (4, 'delta', null)", rejected: true },
		{ label: 'B: column omitted insert', sql: "insert into x.W (id, name) values (5, 'epsilon')", rejected: true },
		{ label: 'C: update to NULL', sql: 'update x.W set tag = null where id = 1', rejected: true },
		{ label: 'satisfying insert', sql: "insert into x.W (id, name, tag) values (8, 'theta', 'ok')", rejected: false },
		{ label: 'fill-in of the grandfathered row', sql: "update x.W set tag = 'filled' where id = 2", rejected: false },
	];

	for (const c of SINGLE_NN) {
		it(`${c.label} ${c.rejected ? 'rejects as a NOT NULL violation' : 'succeeds'}`, async () => {
			const db = new Database();
			try {
				await setupSingleNotNull(db);
				if (c.rejected) {
					await expectThrows(() => db.exec(c.sql), NOT_NULL_VIOLATION);
				} else {
					await db.exec(c.sql);
				}
			} finally {
				await db.close();
			}
		});
	}

	it('a sibling-column update of the grandfathered row rejects (the single base op carries the whole row)', async () => {
		const db = new Database();
		try {
			await setupSingleNotNull(db);
			await expectThrows(() => db.exec("update x.W set name = 'renamed' where id = 2"), NOT_NULL_VIOLATION);
		} finally {
			await db.close();
		}
	});

	it('the grandfathered row stays readable through the lens', async () => {
		const db = new Database();
		try {
			await setupSingleNotNull(db);
			expect(await rows(db, 'select id, tag from x.W order by id')).to.deep.equal([
				{ id: 1, tag: 'seed' },
				{ id: 2, tag: null },
			]);
		} finally {
			await db.close();
		}
	});

	it('a non-nullable derived column classifies `proved`: no advisory, and the BASIS rejects the NULL itself', async () => {
		const db = new Database();
		try {
			// Same capability module, but the basis column IS `not null` — the derived
			// output is non-nullable, so the lens attaches nothing and the basis
			// write's own NOT NULL does the rejecting (named after the basis table).
			db.registerModule('gfmem', new GrandfatheredMemoryModule());
			await db.exec('create table P (id integer primary key, tag text) using gfmem');
			await db.exec('declare logical schema x { table P { id integer primary key, tag text not null } }');
			await db.exec('apply schema x');
			const report = db.declaredSchemaManager.getDeployedLensReport('x');
			expect(
				report?.warnings.some(w => w.code === 'lens.nullability-mismatch'),
				'no nullability advisory for a proved NOT NULL',
			).to.equal(false);
			await expectThrows(
				() => db.exec("insert into x.P (id, tag) values (1, null)"),
				/NOT NULL constraint failed: P\.tag/);
		} finally {
			await db.close();
		}
	});
});
