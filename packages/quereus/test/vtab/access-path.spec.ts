/**
 * `FilterInfo.accessPath` is the typed record of which index the planner chose and how
 * it means to walk it — the structured twin of the free-text `idxStr`. These assertions
 * read it straight off the physical leaf node the optimizer produced.
 *
 * The interesting case is a module that names its index with a per-plan alias the engine
 * cannot resolve from the table schema. Without an `indexDescriptor` the planner must say
 * so (`kind: 'unresolvedIndex'`) rather than guess; with one, the alias resolves to a
 * primary-key walk.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import {
	EmptyResultNode,
	IndexScanNode,
	IndexSeekNode,
	SeqScanNode,
} from '../../src/planner/nodes/table-access-nodes.js';
import type { AccessPath } from '../../src/vtab/index-descriptor.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import { ALIASED_PK_NAME, TestAliasedIndexModule, aliasedIndexStore } from './test-aliased-index-module.js';

/** Every physical table-access leaf carries a FilterInfo. */
type AccessNode = SeqScanNode | IndexScanNode | IndexSeekNode | EmptyResultNode;

function isAccessNode(n: PlanNode): n is AccessNode {
	return n instanceof SeqScanNode || n instanceof IndexScanNode
		|| n instanceof IndexSeekNode || n instanceof EmptyResultNode;
}

/** The `accessPath` of the single table-access leaf in the optimized plan for `sql`. */
function accessPathOf(db: Database, sql: string): AccessPath {
	const found: AccessNode[] = [];
	const walk = (n: PlanNode): void => {
		if (isAccessNode(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(db.getPlan(sql));

	expect(found, `expected exactly one table-access leaf for: ${sql}`).to.have.lengthOf(1);
	const filterInfo: FilterInfo = found[0].filterInfo;
	expect(filterInfo.accessPath, `accessPath must be populated for: ${sql}`).to.not.be.undefined;
	return filterInfo.accessPath!;
}

describe('FilterInfo.accessPath', () => {
	describe('memory module', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id integer primary key, name text, age integer) using memory');
			await db.exec('create index by_name on t(name)');
			await db.exec("insert into t values (1, 'a', 30), (2, 'b', 40)");
		});

		afterEach(async () => {
			await db.close();
		});

		it('plans an unconstrained select as an ordered walk of the primary key', () => {
			// The memory module always advertises primary-key ordering, so a bare select
			// is an ordered index walk (plan=scan), not a sequential scan. (A module that
			// advertises no ordering yields `{ kind: 'fullScan' }` — see the aliased-module
			// suite below.)
			const path = accessPathOf(db, 'select * from t');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('scan');
			expect(path.index.role).to.equal('primary');
		});

		it('plans a literal-NULL primary-key equality as empty (distinct from fullScan)', () => {
			// `id = null` is UNKNOWN under three-valued logic ⇒ no row matches; the rule
			// folds it to an EmptyResult whose FilterInfo carries `{ kind: 'empty' }`.
			expect(accessPathOf(db, 'select * from t where id = null')).to.deep.equal({ kind: 'empty' });
		});

		it('plans a primary-key equality as an eqSeek over the primary key', () => {
			const path = accessPathOf(db, 'select * from t where id = 1');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('eqSeek');
			expect(path.index.role).to.equal('primary');
			expect(path.index.name).to.equal('_primary_');
			expect(path.index.unique).to.be.true;
			expect(path.index.keyColumns).to.deep.equal([{ columnIndex: 0, desc: false, collation: 'BINARY' }]);
		});

		it('plans a secondary-index equality as an eqSeek carrying the index FULL key columns', () => {
			const path = accessPathOf(db, "select * from t where name = 'a'");
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('eqSeek');
			expect(path.index.role).to.equal('secondary');
			expect(path.index.name).to.equal('by_name');
			expect(path.index.keyColumns.map(c => c.columnIndex)).to.deep.equal([1]);
		});

		it('plans a primary-key range as a rangeSeek', () => {
			const path = accessPathOf(db, 'select * from t where id > 1');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('rangeSeek');
			expect(path.index.role).to.equal('primary');
		});

		it('plans an IN list as a multiSeek', () => {
			const path = accessPathOf(db, 'select * from t where id in (1, 2)');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('multiSeek');
		});
	});

	describe('composite secondary index', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table c (id integer primary key, a integer, b integer) using memory');
			await db.exec('create index idx_ab on c(a, b)');
			await db.exec('insert into c values (1, 1, 10), (2, 2, 20)');
		});

		afterEach(async () => {
			await db.close();
		});

		it('an eqSeek on the leading column still reports the index FULL key columns', () => {
			// The seek prefix is `a` alone; the descriptor must describe `(a, b)`.
			const path = accessPathOf(db, 'select * from c where a = 1 and b = 10');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.index.keyColumns.map(c => c.columnIndex)).to.deep.equal([1, 2]);
		});

		it('plans prefix-equality + trailing range as a prefixRangeSeek', () => {
			const path = accessPathOf(db, 'select * from c where a = 1 and b > 5');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('prefixRangeSeek');
			expect(path.index.keyColumns.map(c => c.columnIndex)).to.deep.equal([1, 2]);
		});
	});

	describe('a module that aliases the primary-key index name', () => {
		let db: Database;
		let module: TestAliasedIndexModule;

		beforeEach(async () => {
			aliasedIndexStore.clear();
			db = new Database();
			module = new TestAliasedIndexModule();
			db.registerModule('aliased_idx', module);
			await db.exec('create table a (id integer primary key, v integer) using aliased_idx');
			await db.exec('insert into a values (1, 10), (2, 20)');
		});

		afterEach(async () => {
			await db.close();
			aliasedIndexStore.clear();
		});

		it('without an indexDescriptor, the plan records the index as unresolved', () => {
			module.supplyDescriptor = false;
			const path = accessPathOf(db, 'select * from a where id = 1');
			expect(path).to.deep.equal({ kind: 'unresolvedIndex', indexName: ALIASED_PK_NAME, plan: 'eqSeek' });
		});

		it('with an indexDescriptor, the alias resolves to a primary-key walk', () => {
			module.supplyDescriptor = true;
			const path = accessPathOf(db, 'select * from a where id = 1');
			expect(path.kind).to.equal('index');
			if (path.kind !== 'index') return;
			expect(path.plan).to.equal('eqSeek');
			expect(path.index.role).to.equal('primary');
			expect(path.index.name).to.equal(ALIASED_PK_NAME);
			expect(path.index.keyColumns).to.deep.equal([{ columnIndex: 0, desc: false }]);
		});

		it('plans an unfiltered select as a full scan (module advertises no ordering)', () => {
			module.supplyDescriptor = false;
			expect(accessPathOf(db, 'select * from a')).to.deep.equal({ kind: 'fullScan' });
		});

		it('either way, idxStr still carries the alias the module asked for', () => {
			for (const supply of [false, true]) {
				module.supplyDescriptor = supply;
				const root = db.getPlan('select * from a where id = 1');
				const seeks: IndexSeekNode[] = [];
				const walk = (n: PlanNode): void => {
					if (n instanceof IndexSeekNode) seeks.push(n);
					for (const c of n.getChildren()) walk(c as PlanNode);
				};
				walk(root);
				expect(seeks).to.have.lengthOf(1);
				expect(seeks[0].filterInfo.idxStr).to.equal(`idx=${ALIASED_PK_NAME}(0);plan=2`);
			}
		});
	});
});
