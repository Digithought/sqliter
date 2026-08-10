/**
 * Module mapping advertisement protocol (docs/lens.md § The Default Mapper,
 * ticket `lens-module-mapping-advertisement`).
 *
 * Covers the protocol seam: the `MappingAdvertisement` descriptor a module
 * exposes via `getMappingAdvertisements`, the `quereus.lens.decomp.*` reserved-tag
 * vocabulary + `buildAdvertisementsFromTags` builder the generic memory module
 * returns, and the lens-compiler **resolution + validation + slot storage +
 * introspection** seam (`resolveAdvertisement`). This ticket STORES the resolved
 * advertisement; the n-way join synthesis + put fan-out that consume it land in
 * `lens-multi-source-decomposition`, so the v1 name-match / override body
 * producer is unchanged — these tests provide name-match backing (or an override)
 * for the body and assert the advertisement is resolved + stored alongside it.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import { astToString } from '../src/emit/ast-stringify.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type * as AST from '../src/parser/ast.js';
import type {
	MappingAdvertisement,
	LogicalColumnMapping,
} from '../src/vtab/mapping-advertisement.js';
import type { LensSlot } from '../src/schema/lens.js';
import type { InclusionDependency } from '../src/planner/nodes/plan-node.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

/** A memory module that advertises whatever decompositions a test assigns. */
class AdvertisingModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

function keyMap(...entries: Array<[string, readonly string[]]>): ReadonlyMap<string, readonly string[]> {
	return new Map<string, readonly string[]>(entries);
}

/** The canonical 3-member columnar split over main.T_core / T_b / T_c (anchor T_core). */
function columnarSplit(): MappingAdvertisement {
	return {
		id: 'T_core',
		logicalTable: 'T',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'T_core',
			members: [
				{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'optional', columns: [colMap('b', 'b')] },
				{ relationId: 'T_c', relation: { schema: 'main', table: 'T_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']], ['T_c', ['id']]) },
		},
	};
}

/** An nd-tree auxiliary-access advertisement over main.T_spatial. */
function ndTree(): MappingAdvertisement {
	return {
		id: 'T_spatial',
		logicalTable: 'T',
		role: 'auxiliary-access',
		storage: {
			anchorRelationId: 'T_spatial',
			members: [{ relationId: 'T_spatial', relation: { schema: 'main', table: 'T_spatial' }, presence: 'mandatory', columns: [colMap('id', 'id')] }],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_spatial', ['id']]) },
		},
		access: { served: [{ columns: ['x', 'y'], forms: ['range', 'knn'] }] },
	};
}

/** Creates a basis (in main) backing the columnar split + a name-match table T for the v1 body. */
async function setupSplitBasis(db: Database, mod: AdvertisingModule): Promise<void> {
	db.registerModule('admod', mod);
	// T provides the v1 name-match body; T_core/T_b/T_c/T_spatial are decomposition members.
	await db.exec('create table T (id integer primary key, a integer, b integer, c integer) using admod');
	await db.exec('create table T_core (id integer primary key, a integer) using admod');
	await db.exec('create table T_b (id integer primary key, b integer) using admod');
	await db.exec('create table T_c (id integer primary key, c integer) using admod');
	await db.exec('create table T_spatial (id integer primary key, x real, y real) using admod');
}

describe('lens advertisement: resolution + storage', () => {
	it('stores the primary columnar split + the nd-tree auxiliary on the slot', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit(), ndTree()];
			await setupSplitBasis(db, mod);

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer null, c integer null } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('T')!;
			expect(slot.advertisement, 'primary advertisement stored').to.not.be.undefined;
			expect(slot.advertisement!.id).to.equal('T_core');
			expect(slot.advertisement!.role).to.equal('primary-storage');
			expect(slot.advertisement!.storage!.members.length).to.equal(3);

			expect(slot.auxiliaryAccess, 'auxiliary advertisement stored').to.not.be.undefined;
			expect(slot.auxiliaryAccess!.length).to.equal(1);
			expect(slot.auxiliaryAccess![0].id).to.equal('T_spatial');
			expect(slot.auxiliaryAccess![0].role).to.equal('auxiliary-access');
			expect(slot.auxiliaryAccess![0].access!.served[0].forms).to.deep.equal(['range', 'knn']);
		} finally {
			await db.close();
		}
	});

	it('IND existence-anchor contract: id === storage.anchorRelationId', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit()];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer null, c integer null } }');
			await db.exec('apply schema x');

			const ad = db.schemaManager.getSchema('x')!.getLensSlot('T')!.advertisement!;
			expect(ad.id).to.equal(ad.storage!.anchorRelationId);
		} finally {
			await db.close();
		}
	});

	it('no advertisement ⇒ name-match path untouched (slot.advertisement undefined)', async () => {
		const db = new Database();
		try {
			await db.exec("create table t (id integer primary key, name text)");
			await db.exec("insert into t values (1, 'a')");
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('t')!;
			expect(slot.advertisement).to.be.undefined;
			expect(slot.auxiliaryAccess).to.be.undefined;
			expect(await rows(db, 'select * from x.t')).to.deep.equal([{ id: 1, name: 'a' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: validation errors (atomic, before catalog mutation)', () => {
	async function expectBadAdvertisement(ad: MappingAdvertisement, matcher: RegExp): Promise<void> {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [ad];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), matcher);
			// Atomic: the failed deploy left no lens slot behind.
			expect(db.schemaManager.getSchema('x')?.getLensSlot('T')).to.be.undefined;
		} finally {
			await db.close();
		}
	}

	it('anchor not among members', async () => {
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{ ...ad, id: 'ghost', storage: { ...ad.storage!, anchorRelationId: 'ghost' } },
			/anchor 'ghost' is not among the members/i,
		);
	});

	it('a member relation that does not exist', async () => {
		const ad = columnarSplit();
		const members = ad.storage!.members.map(m =>
			m.relationId === 'T_c' ? { ...m, relation: { schema: 'main', table: 'ghost' } } : m);
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, members } },
			/references basis relation 'main\.ghost', which does not exist/i,
		);
	});

	it('a basisExpr referencing a missing basis column', async () => {
		const ad = columnarSplit();
		const members = ad.storage!.members.map(m =>
			m.relationId === 'T_core' ? { ...m, columns: [colMap('id', 'id'), colMap('a', 'nonexistent')] } : m);
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, members } },
			/column 'nonexistent', which does not exist on 'T_core'/i,
		);
	});

	it('two primary-storage advertisements for one logical table', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			const second: MappingAdvertisement = { ...columnarSplit(), id: 'T_alt' };
			mod.ads = [columnarSplit(), second];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), /2 primary-storage advertisements|at most one is allowed/i);
		} finally {
			await db.close();
		}
	});

	it('surrogate shared key whose anchor key column declares no DEFAULT', async () => {
		// The basis T_core.id declares no DEFAULT, so a surrogate decomposition has
		// nowhere to source its per-row key — rejected at deploy (the engine no longer
		// invents one).
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, sharedKey: { kind: 'surrogate', keyColumnsByRelation: ad.storage!.sharedKey.keyColumnsByRelation } } },
			/declares no DEFAULT/i,
		);
	});

	it('surrogate shared key with inconsistent per-member arity (would silently under-join)', async () => {
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{
				...ad,
				storage: {
					...ad.storage!,
					sharedKey: {
						kind: 'surrogate',
						// Anchor T_core has 1 key column; T_b declares 2 — the positional
						// equi-join would pair by Math.min and silently under-join.
						keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id', 'b']], ['T_c', ['id']]),
					},
				},
			},
			/surrogate.*member 'T_b' has 2 key column.*arity \(1\)/i,
		);
	});

	it('claims the table but leaves a logical column unbacked and uncovered', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			// Single-member advertisement backs id + a; logical T also declares b,
			// which is unbacked and (no basis table T) not name-matchable.
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] }],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using admod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer } }');
			await expectThrows(() => db.exec('apply schema x'), /'b' is left unbacked/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: override composition', () => {
	it('an override renaming an advertised value column stores the advertisement + records provenance', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('maxSpeed', 'speed')] }],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, speed integer) using admod');
			await db.exec("insert into T_core values (1, 120)");

			await db.exec('declare logical schema x { table T { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over main { view T as select id, speed as maxSpeed from main.T_core }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('T')!;
			expect(slot.advertisement, 'advertisement still stored under an override').to.not.be.undefined;
			expect(slot.advertisement!.id).to.equal('T_core');

			const prov = await rows(db, "select logical_column, source, advertised_member from quereus_effective_lens('x', 'T') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'id', source: 'override', advertised_member: 'T_core' },
				{ logical_column: 'maxSpeed', source: 'override', advertised_member: 'T_core' },
			]);
			expect(await rows(db, 'select * from x.T')).to.deep.equal([{ id: 1, maxSpeed: 120 }]);
		} finally {
			await db.close();
		}
	});

	it('a sparse override whose FROM contradicts the advertised anchor errors with the conflict named', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [
						{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
						{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'optional', columns: [colMap('b', 'b')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using admod');
			await db.exec('create table T_b (id integer primary key, b integer) using admod');
			// `Other` is NOT part of the advertised decomposition; the override covers
			// only id and gap-fills a + b from Other (which has them), so the body
			// compiles — and then the re-anchor conflict fires.
			await db.exec('create table Other (id integer primary key, a integer, b integer) using admod');

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer } }');
			await db.exec('declare lens for x over main { view T as select id from main.Other }');
			await expectThrows(() => db.exec('apply schema x'), /references basis relation 'main\.Other', which is not part of the advertised decomposition/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: tag builder (buildAdvertisementsFromTags via memory module)', () => {
	it('assembles an advertisement from quereus.lens.decomp.* tags on basis tables', async () => {
		const db = new Database();
		try {
			// T provides the v1 name-match body; T_core/T_ext carry the decomp facts.
			await db.exec('create table T (id integer primary key, a integer, b integer)');
			await db.exec(`create table T_core (id integer primary key, a integer) with tags (
				"quereus.lens.decomp.logical.d1" = 'T',
				"quereus.lens.decomp.role.d1" = 'primary-storage',
				"quereus.lens.decomp.anchor.d1" = 'T_core',
				"quereus.lens.decomp.presence.d1" = 'mandatory',
				"quereus.lens.decomp.keykind.d1" = 'logical-tuple',
				"quereus.lens.decomp.key.d1" = 'id',
				"quereus.lens.decomp.col.d1.id" = 'id',
				"quereus.lens.decomp.col.d1.a" = 'a'
			)`);
			await db.exec(`create table T_ext (id integer primary key, b integer) with tags (
				"quereus.lens.decomp.logical.d1" = 'T',
				"quereus.lens.decomp.role.d1" = 'primary-storage',
				"quereus.lens.decomp.anchor.d1" = 'T_core',
				"quereus.lens.decomp.presence.d1" = 'optional',
				"quereus.lens.decomp.keykind.d1" = 'logical-tuple',
				"quereus.lens.decomp.key.d1" = 'id',
				"quereus.lens.decomp.col.d1.b" = 'b'
			)`);

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer null } }');
			await db.exec('apply schema x');

			const ad = db.schemaManager.getSchema('x')!.getLensSlot('T')!.advertisement!;
			expect(ad, 'tag-derived advertisement resolved').to.not.be.undefined;
			expect(ad.id).to.equal('T_core');
			expect(ad.logicalTable).to.equal('T');
			expect(ad.role).to.equal('primary-storage');
			expect(ad.storage!.anchorRelationId).to.equal('T_core');
			expect(ad.storage!.members.length).to.equal(2);
			// Anchor first in member order.
			expect(ad.storage!.members[0].relationId).to.equal('T_core');

			const tcore = ad.storage!.members.find(m => m.relationId === 'T_core')!;
			expect(tcore.presence).to.equal('mandatory');
			expect(tcore.columns.map(c => c.logicalColumn).sort()).to.deep.equal(['a', 'id']);
			const text = ad.storage!.members.find(m => m.relationId === 'T_ext')!;
			expect(text.presence).to.equal('optional');
			expect(text.columns.map(c => c.logicalColumn)).to.deep.equal(['b']);
			expect(ad.storage!.sharedKey.kind).to.equal('logical-tuple');
			expect([...ad.storage!.sharedKey.keyColumnsByRelation.get('T_core')!]).to.deep.equal(['id']);
		} finally {
			await db.close();
		}
	});

	it('a malformed decomp tag is rejected at CREATE TABLE (validateReservedTags, create-time)', async () => {
		const db = new Database();
		try {
			// The decomp facts sit on a table-level WITH TAGS (the physical-table site), so the
			// direct CREATE path now validates them at plan-build: a bad enum value fails loudly
			// here rather than later through the advertisement builder at `apply schema`. The
			// builder uses the SAME validateReservedTags check, so create-time is the gate now.
			await expectThrows(
				() => db.exec(`create table T_core (id integer primary key, a integer) with tags (
					"quereus.lens.decomp.logical.d1" = 'T',
					"quereus.lens.decomp.role.d1" = 'bogus-role'
				)`),
				/quereus\.lens\.decomp\.role\.d1.*expected one of: primary-storage/i,
			);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: introspection', () => {
	it('quereus_effective_lens surfaces advertisement-backed provenance per column', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit()];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer null, c integer null } }');
			await db.exec('apply schema x');

			const prov = await rows(db, "select logical_column, advertised_member, advertisement_anchor from quereus_effective_lens('x', 'T') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'a', advertised_member: 'T_core', advertisement_anchor: 'T_core' },
				{ logical_column: 'b', advertised_member: 'T_b', advertisement_anchor: 'T_core' },
				{ logical_column: 'c', advertised_member: 'T_c', advertisement_anchor: 'T_core' },
				{ logical_column: 'id', advertised_member: 'T_core', advertisement_anchor: 'T_core' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: get synthesis (n-way decomposition)', () => {
	it('columnar split: inner-joins mandatory members and recomposes rows', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Car_core',
				logicalTable: 'Car',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Car_core',
					members: [
						{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
						{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: 'mandatory', columns: [colMap('maxSpeed', 'speed')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Car_core (id integer primary key, make text) using admod');
			await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
			await db.exec("insert into Car_core values (1, 'Honda'), (2, 'Mazda')");
			await db.exec('insert into Car_perf values (1, 180), (2, 240)');

			await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer } }');
			await db.exec('apply schema x');

			// Synthesized body is an inner join on id (mandatory member).
			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Car')!;
			const top = slot.compiledBody.from![0] as AST.JoinClause;
			expect(top.type).to.equal('join');
			expect(top.joinType).to.equal('inner');

			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, make: 'Honda', maxSpeed: 180 },
				{ id: 2, make: 'Mazda', maxSpeed: 240 },
			]);

			// The effective SQL (quereus_effective_lens) shows the join.
			const eff = await rows(db, "select distinct effective_sql from quereus_effective_lens('x', 'Car')");
			expect(String(eff[0].effective_sql)).to.match(/inner join/i);
		} finally {
			await db.close();
		}
	});

	it('optional component: outer-joins and preserves a row missing the optional member', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Car_core',
				logicalTable: 'Car',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Car_core',
					members: [
						{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
						{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: 'optional', columns: [colMap('maxSpeed', 'speed')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Car_core (id integer primary key, make text) using admod');
			await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
			await db.exec("insert into Car_core values (1, 'Honda'), (2, 'Mazda')");
			await db.exec('insert into Car_perf values (1, 180)'); // car 2 has NO perf row

			await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer null } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Car')!;
			expect((slot.compiledBody.from![0] as AST.JoinClause).joinType).to.equal('left');

			// The load-bearing correctness property: car 2 survives with maxSpeed null —
			// it is NOT dropped (the inner-join-drops-rows regression).
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, make: 'Honda', maxSpeed: 180 },
				{ id: 2, make: 'Mazda', maxSpeed: null },
			]);
		} finally {
			await db.close();
		}
	});

	it('singleton (primary key ()): on-true join reads 0-or-1 row with nulls when only the anchor exists', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Cfg_exists',
				logicalTable: 'Config',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Cfg_exists',
					members: [
						{ relationId: 'Cfg_exists', relation: { schema: 'main', table: 'Cfg_exists' }, presence: 'mandatory', columns: [] },
						{ relationId: 'Cfg_kv', relation: { schema: 'main', table: 'Cfg_kv' }, presence: 'optional', columns: [colMap('theme', 'theme'), colMap('lang', 'lang')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Cfg_exists', []], ['Cfg_kv', []]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Cfg_exists (tag integer primary key) using admod'); // existence anchor (0-or-1 row)
			await db.exec('create table Cfg_kv (theme text, lang text, primary key ()) using admod');
			await db.exec('insert into Cfg_exists values (1)'); // anchor present, no kv row

			await db.exec('declare logical schema x { table Config { theme text null, lang text null, primary key () } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Config')!;
			const top = slot.compiledBody.from![0] as AST.JoinClause;
			expect(top.type).to.equal('join');
			expect(top.joinType).to.equal('left');
			// Empty key ⇒ vacuously-true ON condition (no singleton-specific branch).
			expect(astToString(top.condition!)).to.equal('1 = 1');

			// Only the existence anchor present → exactly one row, every column null.
			expect(await rows(db, 'select * from x.Config')).to.deep.equal([{ theme: null, lang: null }]);

			// A kv row joins on true (0-or-1 row each ⇒ 0-or-1 result row).
			await db.exec("insert into Cfg_kv values ('dark', 'en')");
			expect(await rows(db, 'select * from x.Config')).to.deep.equal([{ theme: 'dark', lang: 'en' }]);

			// No anchor row → zero rows (existence collapses).
			await db.exec('delete from Cfg_exists');
			expect(await rows(db, 'select * from x.Config')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('EAV pivot: each logical column reads via a correlated scalar subquery on the attribute literal', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Prof_exists',
				logicalTable: 'Profile',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Prof_exists',
					members: [
						{ relationId: 'Prof_exists', relation: { schema: 'main', table: 'Prof_exists' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
						{ relationId: 'Prof_eav', relation: { schema: 'main', table: 'Prof_eav' }, presence: 'optional', columns: [], attributePivot: { entityColumn: 'entity', attributeColumn: 'attr', valueColumn: 'val' } },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Prof_exists', ['id']], ['Prof_eav', ['entity']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Prof_exists (id integer primary key) using admod');
			await db.exec('create table Prof_eav (entity integer, attr text, val text, primary key (entity, attr)) using admod');
			await db.exec('insert into Prof_exists values (1), (2)');
			// entity 2 has a nick triple but no city triple.
			await db.exec("insert into Prof_eav values (1, 'nick', 'Ada'), (1, 'city', 'London'), (2, 'nick', 'Bob')");

			await db.exec('declare logical schema x { table Profile { id integer primary key, nick text, city text } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Profile')!;
			// The EAV pivot member is NOT joined: the anchor is the sole FROM source.
			expect(slot.compiledBody.from!.length).to.equal(1);
			expect(slot.compiledBody.from![0].type).to.equal('table');
			// nick / city are correlated scalar subqueries.
			expect((slot.compiledBody.columns[1] as AST.ResultColumnExpr).expr.type).to.equal('subquery');
			expect((slot.compiledBody.columns[2] as AST.ResultColumnExpr).expr.type).to.equal('subquery');

			expect(await rows(db, 'select * from x.Profile order by id')).to.deep.equal([
				{ id: 1, nick: 'Ada', city: 'London' },
				{ id: 2, nick: 'Bob', city: null }, // missing triple → null
			]);

			// Provenance attributes the EAV-backed columns to the pivot member.
			const prov = await rows(db, "select logical_column, advertised_member from quereus_effective_lens('x', 'Profile') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'city', advertised_member: 'Prof_eav' },
				{ logical_column: 'id', advertised_member: 'Prof_exists' },
				{ logical_column: 'nick', advertised_member: 'Prof_eav' },
			]);
		} finally {
			await db.close();
		}
	});

	it('surrogate key: equi-joins per-member surrogate columns positionally; the logical key projects as a value column', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Doc_core',
				logicalTable: 'Doc',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Doc_core',
					members: [
						{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
						{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
					],
					sharedKey: {
						kind: 'surrogate',
						keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['doc_sid']]),
					},
				},
			}];
			db.registerModule('admod', mod);
			// The surrogate is spelled differently per relation (sid vs doc_sid); the
			// logical key (docKey) is carried as an ordinary value column on Doc_core.
			// The anchor (Doc_core.sid) declares the surrogate's per-row source default.
			await db.exec('create table Doc_core (sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal()), doc_key text, title text) using admod');
			await db.exec('create table Doc_body (doc_sid integer primary key, body text) using admod');
			await db.exec("insert into Doc_core values (100, 'k1', 'First'), (101, 'k2', 'Second')");
			await db.exec("insert into Doc_body values (100, 'body one'), (101, 'body two')");

			await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Doc')!;
			const top = slot.compiledBody.from![0] as AST.JoinClause;
			expect(top.joinType).to.equal('inner');
			// The equi-join pairs the per-member surrogate columns positionally.
			expect(astToString(top.condition!)).to.equal('Doc_body.doc_sid = Doc_core.sid');

			expect(await rows(db, 'select * from x.Doc order by docKey')).to.deep.equal([
				{ docKey: 'k1', title: 'First', body: 'body one' },
				{ docKey: 'k2', title: 'Second', body: 'body two' },
			]);
		} finally {
			await db.close();
		}
	});

	it('advertisement-driven gap-fill: a sparse override gap-fills uncovered columns from the advertised member mapping (not name-match)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Item_core',
				logicalTable: 'Item',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Item_core',
					members: [
						{ relationId: 'Item_core', relation: { schema: 'main', table: 'Item_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('name', 'name'), colMap('caption', 'cap')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Item_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			// 'caption' maps to the renamed basis column 'cap' — a name-match for 'caption' would FAIL.
			await db.exec('create table Item_core (id integer primary key, name text, cap text) using admod');
			await db.exec("insert into Item_core values (1, 'widget', 'Hello')");

			await db.exec('declare logical schema x { table Item { id integer primary key, name text, caption text } }');
			// Sparse override covers id + name; caption gap-fills from the advertisement (cap), not name-match.
			await db.exec("declare lens for x over main { view Item as select id, name from main.Item_core }");
			await db.exec('apply schema x');

			const prov = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Item') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'caption', source: 'default' }, // gap-filled from the advertisement member mapping (cap)
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'name', source: 'override' },
			]);

			expect(await rows(db, 'select * from x.Item')).to.deep.equal([{ id: 1, name: 'widget', caption: 'Hello' }]);
		} finally {
			await db.close();
		}
	});

	// Same body as above, written with a BARE FROM source. Basis-source resolution
	// runs on the authored select, before the compiler pins bare names to the basis
	// (`lens-compiler.ts` § qualifyBasisSources), so `overrideSourceByRel` must key
	// the advertised member the same either way — i.e. gap-fill still finds `cap`.
	it('advertisement-driven gap-fill: an unqualified override FROM resolves the same advertised member', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Item_core',
				logicalTable: 'Item',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Item_core',
					members: [
						{ relationId: 'Item_core', relation: { schema: 'main', table: 'Item_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('name', 'name'), colMap('caption', 'cap')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Item_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Item_core (id integer primary key, name text, cap text) using admod');
			await db.exec("insert into Item_core values (1, 'widget', 'Hello')");

			await db.exec('declare logical schema x { table Item { id integer primary key, name text, caption text } }');
			await db.exec("declare lens for x over main { view Item as select id, name from Item_core }");
			await db.exec('apply schema x');

			expect(await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Item') order by logical_column")).to.deep.equal([
				{ logical_column: 'caption', source: 'default' },
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'name', source: 'override' },
			]);
			expect(await rows(db, 'select * from x.Item')).to.deep.equal([{ id: 1, name: 'widget', caption: 'Hello' }]);
		} finally {
			await db.close();
		}
	});

	it('advertisement-driven gap-fill: errors precisely when an uncovered column needs a member absent from the override FROM', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Item_core',
				logicalTable: 'Item',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Item_core',
					members: [
						{ relationId: 'Item_core', relation: { schema: 'main', table: 'Item_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('caption', 'cap')] },
						{ relationId: 'Item_ext', relation: { schema: 'main', table: 'Item_ext' }, presence: 'optional', columns: [colMap('extra', 'ex')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Item_core', ['id']], ['Item_ext', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Item_core (id integer primary key, cap text) using admod');
			await db.exec('create table Item_ext (id integer primary key, ex text) using admod');

			await db.exec('declare logical schema x { table Item { id integer primary key, caption text, extra text } }');
			// FROM omits Item_ext; `extra` (backed by Item_ext) cannot gap-fill — error precisely.
			await db.exec("declare lens for x over main { view Item as select id from main.Item_core }");
			await expectThrows(() => db.exec('apply schema x'), /column 'extra'.*backing member 'Item_ext' is absent from the override's FROM/i);
		} finally {
			await db.close();
		}
	});

	it('put fan-out: a decomposition body is insert/update/delete-through', async () => {
		// `lens-multi-source-put-fanout` + `lens-multi-source-put-insert-fanout` wire the
		// advertisement-driven put fan-out (`planner/mutation/decomposition.ts`): a
		// decomposition body routes off the generic join path to a member fan-out for
		// INSERT (off the shared-surrogate envelope), UPDATE, and DELETE.
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Car_core',
				logicalTable: 'Car',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Car_core',
					members: [
						{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
						{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: 'optional', columns: [colMap('maxSpeed', 'speed')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Car_core (id integer primary key, make text) using admod');
			await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
			await db.exec("insert into Car_core values (1, 'Honda'), (2, 'Mazda')");
			await db.exec('insert into Car_perf values (1, 180)');
			await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer null } }');
			await db.exec('apply schema x');

			// INSERT fans out to every member (anchor + optional), threading the logical PK.
			await db.exec("insert into x.Car (id, make, maxSpeed) values (3, 'Ford', 200)");
			expect(await rows(db, 'select * from main.Car_core where id = 3')).to.deep.equal([{ id: 3, make: 'Ford' }]);
			expect(await rows(db, 'select * from main.Car_perf where id = 3')).to.deep.equal([{ id: 3, speed: 200 }]);
			expect(await rows(db, 'select * from x.Car where id = 3')).to.deep.equal([{ id: 3, make: 'Ford', maxSpeed: 200 }]);

			// UPDATE of an anchor-backed column fans out to that member.
			await db.exec("update x.Car set make = 'Acura' where id = 1");
			expect(await rows(db, 'select make from main.Car_core where id = 1')).to.deep.equal([{ make: 'Acura' }]);

			// DELETE fans out to every member (anchor + optional). id=3 (just inserted)
			// survives; id=1's anchor + perf rows are removed.
			await db.exec('delete from x.Car where id = 1');
			expect(await rows(db, 'select id from main.Car_core order by id')).to.deep.equal([{ id: 2 }, { id: 3 }]);
			expect(await rows(db, 'select id from main.Car_perf order by id')).to.deep.equal([{ id: 3 }]);
		} finally {
			await db.close();
		}
	});

	it('optional member: the outer join survives a non-null-rejecting filter on the optional column', async () => {
		// The classic outer-join-to-inner pitfall: a WHERE on the optional column must
		// not let the optimizer rewrite the synthesized `left join` back to an inner
		// join. `is null` is not null-rejecting, so the anchor-only row must survive;
		// a null-rejecting predicate (`= 180`) correctly excludes it.
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Car_core',
				logicalTable: 'Car',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Car_core',
					members: [
						{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
						{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: 'optional', columns: [colMap('maxSpeed', 'speed')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Car_core (id integer primary key, make text) using admod');
			await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
			await db.exec("insert into Car_core values (1, 'Honda'), (2, 'Mazda')");
			await db.exec('insert into Car_perf values (1, 180)'); // car 2 has NO perf row
			await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer null } }');
			await db.exec('apply schema x');

			// Non-null-rejecting filter: the anchor-only row (car 2) survives.
			expect(await rows(db, 'select * from x.Car where maxSpeed is null order by id')).to.deep.equal([
				{ id: 2, make: 'Mazda', maxSpeed: null },
			]);
			// Null-rejecting filter: only the joined row qualifies (correct exclusion).
			expect(await rows(db, 'select * from x.Car where maxSpeed = 180 order by id')).to.deep.equal([
				{ id: 1, make: 'Honda', maxSpeed: 180 },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens existence-anchor IND injection (lens-multi-source-ind-injection)', () => {
	/** Narrows a relation-target IND, failing the test if it is anything else. */
	function relTarget(i: InclusionDependency): { relationId: string; targetCols: readonly number[] } {
		expect(i.target.kind, 'expected a kind:relation IND target').to.equal('relation');
		const t = i.target as Extract<InclusionDependency['target'], { kind: 'relation' }>;
		return { relationId: t.relationId, targetCols: t.targetCols };
	}

	/**
	 * A 2-member columnar Car split — Car_core (anchor) + Car_perf — with the perf
	 * member's presence parameterized, over basis `main`. Logical-tuple key on `id`.
	 */
	function carAd(perfPresence: 'mandatory' | 'optional'): MappingAdvertisement {
		return {
			id: 'Car_core',
			logicalTable: 'Car',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'Car_core',
				members: [
					{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
					{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: perfPresence, columns: [colMap('maxSpeed', 'speed')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']]) },
			},
		};
	}

	/** Deploys a Car decomposition over the standard Car_core/Car_perf basis and returns the slot. */
	async function deployCar(db: Database, ad: MappingAdvertisement): Promise<LensSlot> {
		const mod = new AdvertisingModule();
		mod.ads = [ad];
		db.registerModule('admod', mod);
		await db.exec('create table Car_core (id integer primary key, make text) using admod');
		await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
		await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer null } }');
		await db.exec('apply schema x');
		return db.schemaManager.getSchema('x')!.getLensSlot('Car')!;
	}

	it('injects one existence-anchor IND per mandatory member (cols = anchor key, target = member, total)', async () => {
		const db = new Database();
		try {
			const slot = await deployCar(db, carAd('mandatory'));
			const inds = slot.injectedInds ?? [];
			expect(inds, 'one IND for the single mandatory non-anchor member').to.have.length(1);
			const ind = inds[0];
			// `cols` are Car_core's (the anchor's) key column indices on its own basis relation (id @ 0).
			expect(ind.cols).to.deep.equal([0]);
			// Total existence — every logical (= anchor) row has the mandatory member.
			expect(ind.nullRejecting).to.equal(false);
			// Target is the mandatory non-anchor *member* relation, keyed by its key column indices (id @ 0).
			const t = relTarget(ind);
			expect(t.relationId).to.equal('Car_perf');
			expect(t.targetCols).to.deep.equal([0]);
		} finally {
			await db.close();
		}
	});

	it('the injected target is a non-anchor mandatory member while cols address the anchor key (direction-swap guard)', async () => {
		const db = new Database();
		try {
			const slot = await deployCar(db, carAd('mandatory'));
			const ad = slot.advertisement!;
			const ind = (slot.injectedInds ?? [])[0];
			const t = relTarget(ind);
			// The injected fact is `anchor.key ⊆ member.key`: the THIS-side (`cols`) is the
			// anchor and the target is the *member* — explicitly NOT the anchor. Pinning the
			// target to a non-anchor member makes a future accidental direction swap (back to
			// the unsound `member ⊆ anchor`) fail loudly here.
			expect(ad.id).to.equal(ad.storage!.anchorRelationId); // resolver invariant, unchanged
			expect(t.relationId).to.equal('Car_perf');
			expect(t.relationId).to.not.equal(ad.storage!.anchorRelationId);
			// `cols` index the anchor's key (id @ 0 on Car_core), pairing positionally with the member key.
			expect(ind.cols).to.deep.equal([0]);
		} finally {
			await db.close();
		}
	});

	it('an optional member injects no IND (over-claim guard — its absence is what the outer join preserves)', async () => {
		const db = new Database();
		try {
			const slot = await deployCar(db, carAd('optional'));
			expect(slot.injectedInds ?? [], 'optional member ⇒ no relation-IND').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('a singleton (primary key ()) decomposition injects no IND (empty key — no witnessing tuple)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Cfg_exists',
				logicalTable: 'Config',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Cfg_exists',
					members: [
						{ relationId: 'Cfg_exists', relation: { schema: 'main', table: 'Cfg_exists' }, presence: 'mandatory', columns: [] },
						// A *mandatory* value member with an empty shared key: even so, the empty
						// key means there is no tuple to thread, so no IND is injected.
						{ relationId: 'Cfg_kv', relation: { schema: 'main', table: 'Cfg_kv' }, presence: 'mandatory', columns: [colMap('theme', 'theme'), colMap('lang', 'lang')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Cfg_exists', []], ['Cfg_kv', []]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Cfg_exists (tag integer primary key) using admod');
			await db.exec('create table Cfg_kv (theme text, lang text, primary key ()) using admod');
			await db.exec('declare logical schema x { table Config { theme text, lang text, primary key () } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Config')!;
			expect(slot.injectedInds ?? [], 'empty (singleton) key ⇒ no relation-IND').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('a surrogate split injects per-member surrogate columns (cols/targetCols index each relation, spelled differently)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Doc_core',
				logicalTable: 'Doc',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Doc_core',
					members: [
						{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
						{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
					],
					sharedKey: {
						kind: 'surrogate',
						keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['doc_sid']]),
					},
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Doc_core (sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal()), doc_key text, title text) using admod');
			await db.exec('create table Doc_body (doc_sid integer primary key, body text) using admod');
			await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('Doc')!;
			const inds = slot.injectedInds ?? [];
			expect(inds).to.have.length(1);
			// cols index Doc_core, the anchor (sid @ 0); targetCols index Doc_body, the member (doc_sid @ 0).
			expect(inds[0].cols).to.deep.equal([0]);
			const t = relTarget(inds[0]);
			expect(t.relationId).to.equal('Doc_body');
			expect(t.targetCols).to.deep.equal([0]);
			expect(inds[0].nullRejecting).to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('injects one IND per mandatory member when several are present (3-member split)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Car_core',
				logicalTable: 'Car',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Car_core',
					members: [
						{ relationId: 'Car_core', relation: { schema: 'main', table: 'Car_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('make', 'make')] },
						{ relationId: 'Car_perf', relation: { schema: 'main', table: 'Car_perf' }, presence: 'mandatory', columns: [colMap('maxSpeed', 'speed')] },
						{ relationId: 'Car_trim', relation: { schema: 'main', table: 'Car_trim' }, presence: 'optional', columns: [colMap('trim', 'trim')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Car_core', ['id']], ['Car_perf', ['id']], ['Car_trim', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table Car_core (id integer primary key, make text) using admod');
			await db.exec('create table Car_perf (id integer primary key, speed integer) using admod');
			await db.exec('create table Car_trim (id integer primary key, trim text) using admod');
			await db.exec('declare logical schema x { table Car { id integer primary key, make text, maxSpeed integer, trim text null } }');
			await db.exec('apply schema x');

			const inds = db.schemaManager.getSchema('x')!.getLensSlot('Car')!.injectedInds ?? [];
			// Only Car_perf is mandatory + non-anchor; Car_trim is optional ⇒ excluded.
			expect(inds).to.have.length(1);
			// Target is the mandatory non-anchor member (Car_perf), not the anchor (Car_core).
			expect(relTarget(inds[0]).relationId).to.equal('Car_perf');
		} finally {
			await db.close();
		}
	});

	it('distinct per-side key ordinals: cols pick the anchor ordinal, targetCols the member ordinal (value-level direction guard)', async () => {
		// Every other fixture keys both relations at column 0, so `cols`/`targetCols`
		// are both `[0]` and a re-swap is caught only by `target.relationId`. Here the
		// shared surrogate sits at a *different* ordinal on each side — anchor `sid` @ 2,
		// member `body_sid` @ 0 — so the index *values* themselves discriminate
		// direction: `cols` must be the anchor's ordinal `[2]` and `targetCols` the
		// member's `[0]`. A direction swap back to `member ⊆ anchor` would flip these to
		// `cols=[0]`/`targetCols=[2]` and fail here independently of the relationId guard.
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'Doc_core',
				logicalTable: 'Doc',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'Doc_core',
					members: [
						{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
						{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
					],
					sharedKey: {
						kind: 'surrogate',
						keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['body_sid']]),
					},
				},
			}];
			db.registerModule('admod', mod);
			// Anchor surrogate `sid` at ordinal 2 (not 0); member surrogate `body_sid` at ordinal 0.
			await db.exec('create table Doc_core (doc_key text, title text, sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal())) using admod');
			await db.exec('create table Doc_body (body_sid integer primary key, body text) using admod');
			await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text } }');
			await db.exec('apply schema x');

			const inds = db.schemaManager.getSchema('x')!.getLensSlot('Doc')!.injectedInds ?? [];
			expect(inds).to.have.length(1);
			// cols index Doc_core, the anchor (sid @ 2); targetCols index Doc_body, the member (body_sid @ 0).
			expect(inds[0].cols).to.deep.equal([2]);
			const t = relTarget(inds[0]);
			expect(t.relationId).to.equal('Doc_body');
			expect(t.targetCols).to.deep.equal([0]);
			expect(inds[0].nullRejecting).to.equal(false);
		} finally {
			await db.close();
		}
	});
});
