/**
 * Verifies the `permitsGrandfatheredCheckViolators` capability gate on the
 * planner's lift of declared CHECK constraints into `TableReferenceNode`'s
 * physical properties (see `planner/nodes/reference.ts` and
 * `vtab/capabilities.ts`).
 *
 * Default vtab modules leave the cap off: a `CHECK (v > 0)` on column `v`
 * flows into `domainConstraints` as `{ kind: 'range', column: <v>, min: 0,
 * minInclusive: false }`, so the filter-contradiction rule can fold a WHERE
 * like `v <= 0` to `EmptyRelationNode`. Modules that opt in (e.g. Lamina,
 * whose `ALTER TABLE … ADD CHECK` is structurally total and grandfathers
 * violators) suppress the lift — the planner can no longer prove the
 * predicate empty, so the scan stays.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { TableReferenceNode } from '../../src/planner/nodes/reference.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import type { ModuleCapabilities } from '../../src/vtab/capabilities.js';
import { getTrustedCheckExtraction } from '../../src/planner/analysis/check-extraction.js';
import type { LensDeployReport } from '../../src/schema/lens-prover.js';

describe('CHECK contribution gated by permitsGrandfatheredCheckViolators', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	function buildReference(vtabModule: MemoryTableModule, schemaName = 'main', tableName = 't'): TableReferenceNode {
		const table = db.schemaManager.findTable(tableName, schemaName);
		if (!table) throw new Error(`table ${schemaName}.${tableName} not found`);
		return new TableReferenceNode(
			new GlobalScope(db.schemaManager),
			table,
			vtabModule,
		);
	}

	it('default (cap absent): CHECK (v > 0) lifts into domainConstraints', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER CHECK (v > 0)) USING memory');
		const ref = buildReference(new MemoryTableModule());
		const phys = ref.computePhysical([]);
		expect(phys.domainConstraints, 'CHECK should lift to domainConstraints').to.exist;
		const domain = phys.domainConstraints!;
		// Column 1 is `v`. Expect a min: 0 range with minInclusive: false.
		const vDomain = domain.find(d => d.column === 1 && d.kind === 'range');
		expect(vDomain, 'range domain on v').to.exist;
		expect(vDomain).to.include({ kind: 'range', column: 1, min: 0, minInclusive: false });
	});

	it('cap on: CHECK (v > 0) is NOT lifted', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER CHECK (v > 0)) USING memory');
		class WrappedModule extends MemoryTableModule {
			override getCapabilities(): ModuleCapabilities {
				return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
			}
		}
		const ref = buildReference(new WrappedModule());
		const phys = ref.computePhysical([]);
		// `out.domainConstraints` is only set when non-empty (see reference.ts);
		// absence is the contract.
		expect(phys.domainConstraints, 'no CHECK lift under cap').to.be.undefined;
	});

	it('cap on: equality CHECK (a = b) does NOT lift to equivClasses / FDs / constantBindings', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, CHECK (a = b)) USING memory');
		class WrappedModule extends MemoryTableModule {
			override getCapabilities(): ModuleCapabilities {
				return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
			}
		}
		const ref = buildReference(new WrappedModule());
		const phys = ref.computePhysical([]);
		expect(phys.equivClasses, 'no EC lift under cap').to.be.undefined;
		expect(phys.constantBindings, 'no binding lift under cap').to.be.undefined;
		expect(phys.domainConstraints, 'no domain lift under cap').to.be.undefined;
		// `fds` still gets seeded from the PK; assert no a↔b FDs leaked in from
		// the CHECK extraction.
		const fds = phys.fds ?? [];
		const aIdx = 1; // columns: id(0), a(1), b(2)
		const bIdx = 2;
		const hasAtoB = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === aIdx
			&& fd.dependents.length === 1 && fd.dependents[0] === bIdx,
		);
		const hasBtoA = fds.some(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === bIdx
			&& fd.dependents.length === 1 && fd.dependents[0] === aIdx,
		);
		expect(hasAtoB, 'no a→b FD under cap').to.be.false;
		expect(hasBtoA, 'no b→a FD under cap').to.be.false;
	});

	it('default (cap absent): equality CHECK (a = b) lifts the EC and the bi-FD as determinations', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, CHECK (a = b)) USING memory');
		const ref = buildReference(new MemoryTableModule());
		const phys = ref.computePhysical([]);
		// Columns: id(0), a(1), b(2). The value-equality CHECK lifts the equivalence
		// class {a, b} unconditionally — the EC merge is never gated (value-equality
		// is always sound and ECs are not read by key derivation). The capability cap
		// suppresses this (the paired "cap on" test asserts equivClasses undefined).
		expect(phys.equivClasses, 'a≡b EC lifts without cap').to.deep.equal([[1, 2]]);
		// The bi-directional FD {a}↔{b} folds unconditionally as
		// `kind: 'determination'` — the kind-aware readers (`isUniqueDeterminant`,
		// ticket fd-determination-reader-side-rule) never read a determination as
		// a uniqueness claim, so `select a, b` cannot read {a} as a key over the
		// duplicate (a=b) rows. (Replaces the producer-side gate from ticket
		// fd-check-assertion-key-bag-overclaim, which dropped the pair here.)
		const fds = phys.fds ?? [];
		const aIdx = 1;
		const bIdx = 2;
		const aToB = fds.find(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === aIdx
			&& fd.dependents.includes(bIdx),
		);
		const bToA = fds.find(fd =>
			fd.determinants.length === 1 && fd.determinants[0] === bIdx
			&& fd.dependents.includes(aIdx),
		);
		expect(aToB?.kind, 'a→b folds as a determination').to.equal('determination');
		expect(bToA?.kind, 'b→a folds as a determination').to.equal('determination');
	});
});

/** Test double: a memory module that grandfathers CHECK violators. */
class GrandfatheringMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsGrandfatheredCheckViolators: true };
	}
}

describe('getTrustedCheckExtraction: central capability gate (schema-resolved module)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('default (cap absent): the extraction carries the CHECK-derived domain', async () => {
		await db.exec("create table t (id integer primary key, v text not null check (v in ('a', 'b'))) using memory");
		const table = db.schemaManager.findTable('t', 'main')!;
		const ext = getTrustedCheckExtraction(table);
		expect(ext.domainConstraints.length, 'enum domain extracted').to.be.greaterThan(0);
	});

	it('cap on: the schema-resolved module suppresses the extraction wholesale', async () => {
		db.registerModule('gfmem', new GrandfatheringMemoryModule());
		await db.exec("create table t (id integer primary key, v text not null check (v in ('a', 'b'))) using gfmem");
		const table = db.schemaManager.findTable('t', 'main')!;
		const ext = getTrustedCheckExtraction(table);
		expect(ext.fds, 'no FDs under cap').to.deep.equal([]);
		expect(ext.equivPairs, 'no ECs under cap').to.deep.equal([]);
		expect(ext.constantBindings, 'no bindings under cap').to.deep.equal([]);
		expect(ext.domainConstraints, 'no domains under cap').to.deep.equal([]);
	});
});

describe('lens prover: basis CHECK domain gated by permitsGrandfatheredCheckViolators', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	/**
	 * Deploys the bijective-enumeration shape from
	 * test/logic/55.5-lens-authored-inverse.sqllogic § 6 over a basis table on
	 * the given module: `upper(code)` forward, `lower(new.grp)` inverse —
	 * bijective between the basis CHECK domain ('a','b','c') and the logical
	 * CHECK domain ('A','B','C') whenever both domains are trusted.
	 */
	async function deployBijectiveLens(moduleName: string): Promise<LensDeployReport> {
		await db.exec(`create table Item (id integer primary key, code text not null check (code in ('a', 'b', 'c'))) using ${moduleName}`);
		await db.exec("declare logical schema x { table Item (id integer primary key, grp text null check (grp in ('A', 'B', 'C'))) }");
		await db.exec('declare lens for x over main { view Item as select id, upper(code) as grp with inverse (code = lower(new.grp)) from main.Item }');
		await db.exec('apply schema x');
		const report = db.declaredSchemaManager.getDeployedLensReport('x');
		expect(report, 'deploy report for x').to.not.be.undefined;
		return report!;
	}

	it('control (cap absent): the bijective enumeration suppresses lens.getput-lossy', async () => {
		const report = await deployBijectiveLens('memory');
		expect(report.warnings.map(w => w.code), 'forward proved injective over the trusted basis domain').to.not.include('lens.getput-lossy');
	});

	it('cap on: the basis CHECK domain is untrusted — the injectivity proof must not certify, the advisory stands', async () => {
		db.registerModule('gfmem', new GrandfatheringMemoryModule());
		const report = await deployBijectiveLens('gfmem');
		// Grandfathered basis rows may sit outside the declared CHECK domain, so
		// the enumeration cannot witness the bijection: GetPut stays surrendered.
		const lossy = report.warnings.filter(w => w.code === 'lens.getput-lossy');
		expect(lossy.length, 'advisory stands under cap').to.equal(1);
		expect(lossy[0].site.column, 'sited at the authored column').to.equal('grp');
	});
});
