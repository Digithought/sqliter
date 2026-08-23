import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * Clause canaries — "does this SELECT clause reach the plan at all?"
 *
 * The failure this suite guards is not a wrong answer, it is a *silent* one: the
 * parser accepts a clause, no builder ever reads it, and the query runs as though
 * the clause had not been written. Two independent instances of that class have
 * been found — a HAVING with no aggregate and no GROUP BY was dropped outright
 * (bug-having-without-aggregates-silently-dropped), and `order by <ordinal>
 * collate <name>` silently does not sort. Neither produced an error.
 *
 * So, for each clause: a query whose answer MUST differ from the same query with
 * the clause removed. If the two answers match, the clause did nothing.
 *
 * What this suite is NOT: it does not check that a clause is implemented
 * *correctly*, only that it is implemented *at all*. A clause could be wired up
 * and still compute the wrong rows and every canary here would stay green. The
 * per-clause behaviour suites (test/logic/*.sqllogic and friends) own correctness;
 * this file owns "it is connected".
 *
 * The `order by <ordinal> collate <name>` instance above is deliberately absent from
 * the table: it is a KNOWN-OPEN defect, so its canary would fail today. Add it with
 * the fix, not before — a skipped canary is indistinguishable from no canary.
 *
 * The table is a floor, not a ceiling. Clauses still unrepresented: the `from`-clause
 * modifiers, `with`, set operations (`union`/`intersect`/`except`), explicit `window`
 * definitions. Adding a row costs two queries.
 */

/** The fixture every canary runs against — small, with a duplicate and an ascending key. */
const FIXTURE = `
	create table cn (id integer primary key, grp text, val integer);
	insert into cn values (1, 'x', 10), (2, 'y', 20), (3, 'x', 30);
`;

interface ClauseCanary {
	/** Clause under test, for the test name. */
	readonly clause: string;
	/** Query WITHOUT the clause. */
	readonly without: string;
	/** Same query WITH the clause. Must produce a different answer. */
	readonly with: string;
}

const CANARIES: readonly ClauseCanary[] = [
	{
		clause: 'where',
		without: `select id from cn order by id`,
		with: `select id from cn where grp = 'x' order by id`,
	},
	{
		clause: 'group by',
		// Same select list either way: one implicit group vs one group per `grp`.
		without: `select count(*) as c from cn`,
		with: `select count(*) as c from cn group by grp`,
	},
	{
		clause: 'having (grouped)',
		without: `select grp, count(*) as c from cn group by grp order by grp`,
		with: `select grp, count(*) as c from cn group by grp having count(*) > 1 order by grp`,
	},
	{
		clause: 'having (no aggregate, no group by)',
		// The shape that was dropped: with no aggregate and no GROUP BY the query is
		// still an aggregate query over one implicit group, so a false predicate must
		// empty the result. When the clause was dropped this returned all three rows —
		// identical to `without` — which is exactly what this canary catches.
		without: `select 1 as one from cn`,
		with: `select 1 as one from cn having 1 = 0`,
	},
	{
		clause: 'order by',
		// The source scans by primary key ascending, so a descending sort must reorder.
		without: `select id from cn`,
		with: `select id from cn order by id desc`,
	},
	{
		clause: 'limit',
		without: `select id from cn order by id`,
		with: `select id from cn order by id limit 1`,
	},
	{
		clause: 'offset',
		without: `select id from cn order by id limit 2`,
		with: `select id from cn order by id limit 2 offset 1`,
	},
	{
		clause: 'distinct',
		// `grp` holds 'x' twice.
		without: `select grp from cn order by grp`,
		with: `select distinct grp from cn order by grp`,
	},
];

/**
 * Canaries for clause forms whose only observable effect is a rejection. A clause
 * that is dropped from the plan raises nothing, so "must raise" is the same guard
 * as "must change the answer" — stated the only way it can be for these shapes.
 */
interface ErrorCanary {
	readonly clause: string;
	readonly sql: string;
	/** Substring the raised message must contain. */
	readonly errorFragment: string;
}

const ERROR_CANARIES: readonly ErrorCanary[] = [
	{
		clause: 'having (no aggregate, no group by) — bare column',
		// One implicit group, which carries no `grp`, so this must be rejected. While
		// the clause was dropped it happily returned every row. The fragment names the
		// coverage rule, not just the column: `grp` alone appears in the SQL text and so
		// would also match a parse error or an internal failure that echoes the query.
		sql: `select grp from cn having grp = 'x'`,
		errorFragment: `Column 'grp' must appear in the GROUP BY clause`,
	},
	{
		clause: 'having (no aggregate, no group by) — bare column via star',
		// Same rule reached through `select *`. Worth its own canary: the star select
		// list is rebuilt by a different builder, which used to raise an internal
		// assertion here rather than this user-facing message.
		sql: `select * from cn having 1 = 1`,
		errorFragment: `Column 'id' must appear in the GROUP BY clause`,
	},
];

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('SELECT clause canaries', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(FIXTURE);
	});

	afterEach(async () => {
		await db.close();
	});

	for (const canary of CANARIES) {
		it(`${canary.clause} changes the answer`, async () => {
			const without = await collect(db, canary.without);
			const withClause = await collect(db, canary.with);

			expect(JSON.stringify(withClause), `\`${canary.clause}\` did nothing:\n  ${canary.without}\n  ${canary.with}\nboth returned ${JSON.stringify(without)}`)
				.to.not.equal(JSON.stringify(without));
		});
	}

	for (const canary of ERROR_CANARIES) {
		it(`${canary.clause} is rejected`, async () => {
			let message: string | undefined;
			try {
				await collect(db, canary.sql);
			} catch (e) {
				message = (e as Error).message;
			}

			expect(message, `\`${canary.clause}\` did nothing — ${canary.sql} was accepted`).to.be.a('string');
			expect(message).to.contain(canary.errorFragment);
		});
	}
});
