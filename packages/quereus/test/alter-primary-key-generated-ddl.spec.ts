/**
 * `ALTER TABLE … ALTER PRIMARY KEY` → generated DDL → re-parse.
 *
 * A table records its key twice: `primaryKeyDefinition` (authoritative) and the
 * per-column `primaryKey` / `pkOrder` flags. ALTER PRIMARY KEY moves the definition;
 * the DDL generator's inline single-column `PRIMARY KEY` branch used to render from the
 * FLAG, so after a re-key it emitted DDL naming the RETIRED key — and on a
 * composite→single move, two inline `PRIMARY KEY` clauses (which the parser silently
 * merges back into the old composite key rather than rejecting).
 *
 * That text is what the store persists to its catalog and what both backends attach to
 * their schema-change events, so a wrong key here is a wrongly-keyed table after a
 * reopen or on a sync peer (the store leg of that is
 * `quereus-store/test/alter-primary-key-persistence.spec.ts`).
 *
 * Each case asserts three things about the generated DDL: it names the NEW key, it
 * contains exactly ONE `PRIMARY KEY` occurrence, and re-parsing it in a fresh Database
 * yields an equal `primaryKeyDefinition` (index + desc).
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateTableDDL } from '../src/schema/ddl-generator.js';
import type { TableSchema } from '../src/schema/table.js';

/** Key as `(name[ desc], …)` in definition order — the comparison form for both sides. */
function keySpelling(schema: TableSchema): string[] {
	return schema.primaryKeyDefinition.map(pk => schema.columns[pk.index].name + (pk.desc ? ' desc' : ''));
}

function countPrimaryKeyClauses(ddl: string): number {
	return (ddl.match(/PRIMARY KEY/gi) ?? []).length;
}

interface Case {
	label: string;
	create: string;
	alter: string;
	/** Expected post-ALTER key, as `keySpelling` renders it. */
	expectedKey: string[];
	/**
	 * Expected count of `PRIMARY KEY` occurrences in the generated DDL. 1 for a key that
	 * emits a clause; 0 for the synthesized all-columns key, which deliberately emits
	 * none so the re-parse re-synthesizes it (see `isSynthesizedAllColumnsKey`).
	 */
	expectedClauses: number;
}

const CASES: Case[] = [
	{
		label: 'single → single',
		create: `create table t (id integer primary key, code integer not null)`,
		alter: `alter table t alter primary key (code)`,
		expectedKey: ['code'],
		expectedClauses: 1,
	},
	{
		label: 'single → single desc',
		create: `create table t (id integer primary key, code integer not null)`,
		alter: `alter table t alter primary key (code desc)`,
		expectedKey: ['code desc'],
		expectedClauses: 1,
	},
	{
		label: 'composite → single (must not emit two inline clauses)',
		create: `create table t (a integer not null, b integer not null, v integer null, primary key (a, b))`,
		alter: `alter table t alter primary key (b)`,
		expectedKey: ['b'],
		expectedClauses: 1,
	},
	{
		label: 'single → composite subset',
		create: `create table t (id integer primary key, a integer not null, b integer not null)`,
		alter: `alter table t alter primary key (a, b)`,
		expectedKey: ['a', 'b'],
		expectedClauses: 1,
	},
	{
		label: 'single → composite all columns (synthesized key: no clause)',
		create: `create table t (id integer primary key, code integer not null)`,
		alter: `alter table t alter primary key (id, code)`,
		expectedKey: ['id', 'code'],
		expectedClauses: 0,
	},
	{
		// The empty-key singleton: the retired inline clause must go and the table-level
		// `PRIMARY KEY ()` take its place, or the re-parse re-keys on the old column.
		label: 'single → empty (the `primary key ()` singleton)',
		create: `create table t (id integer primary key, code integer not null)`,
		alter: `alter table t alter primary key ()`,
		expectedKey: [],
		expectedClauses: 1,
	},
	{
		label: 'composite → composite reordered',
		create: `create table t (a integer not null, b integer not null, v integer null, primary key (a, b))`,
		alter: `alter table t alter primary key (b, a desc)`,
		expectedKey: ['b', 'a desc'],
		expectedClauses: 1,
	},
];

describe('ALTER PRIMARY KEY — generated DDL names the new key', () => {
	for (const c of CASES) {
		it(c.label, async () => {
			const db = new Database();
			let ddl: string;
			try {
				await db.exec(c.create);
				await db.exec(c.alter);

				const schema = db.schemaManager.findTable('t')!;
				expect(keySpelling(schema), 'live schema re-keyed').to.deep.equal(c.expectedKey);

				ddl = generateTableDDL(schema);
				expect(countPrimaryKeyClauses(ddl), `PRIMARY KEY clause count in: ${ddl}`).to.equal(c.expectedClauses);
				for (const member of c.expectedKey) {
					// The retired key's column must not carry a clause; assert positively that
					// each new member's name appears somewhere and rely on the re-parse below
					// for the exact association.
					expect(ddl, `generated DDL mentions new key member '${member}'`).to.contain(member.split(' ')[0]);
				}
			} finally {
				await db.close();
			}

			// Re-parse in a fresh session: the key the DDL actually declares.
			const db2 = new Database();
			try {
				await db2.exec(ddl);
				const reparsed = db2.schemaManager.findTable('t')!;
				expect(keySpelling(reparsed), `re-parsed key from: ${ddl}`).to.deep.equal(c.expectedKey);
			} finally {
				await db2.close();
			}
		});
	}

	it('round-trips an unaltered table\'s DDL byte-identically (CREATE-time output unmoved)', async () => {
		const shapes = [
			`create table t (id integer primary key, v text null)`,
			`create table t (id integer primary key desc, v text null)`,
			`create table t (a integer not null, b integer not null, primary key (a, b desc))`,
			`create table t (a integer null, b text null)`,
			`create table t (a integer not null, b integer null, primary key ())`,
		];
		for (const create of shapes) {
			const db = new Database();
			try {
				await db.exec(create);
				const ddl = generateTableDDL(db.schemaManager.findTable('t')!);
				const db2 = new Database();
				try {
					await db2.exec(ddl);
					expect(generateTableDDL(db2.schemaManager.findTable('t')!), `idempotent for: ${create}`).to.equal(ddl);
				} finally {
					await db2.close();
				}
			} finally {
				await db.close();
			}
		}
	});
});
