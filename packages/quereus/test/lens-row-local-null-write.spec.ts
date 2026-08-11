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
