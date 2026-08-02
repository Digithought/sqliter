import { describe, it } from 'mocha';
import { Database } from '../src/index.js';

async function tryExec(db: Database, sql: string, label: string): Promise<void> {
	try {
		await db.exec(sql);
		console.log(`OK   [${label}]`);
	} catch (e) {
		console.log(`FAIL [${label}] ${sql.replace(/\s+/g, ' ')}\n   -> ${(e as Error).message.split('\n')[0]}`);
	}
}

async function dump(db: Database, sql: string, label: string): Promise<void> {
	try {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		console.log(`ROWS [${label}] ${JSON.stringify(out)}`);
	} catch (e) {
		console.log(`FAIL [${label}] ${(e as Error).message.split('\n')[0]}`);
	}
}

describe('tmp repro', () => {
	it('declared schema, non-main: full object matrix', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema pol {
				table t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL)
				table child (id INTEGER PRIMARY KEY, pid INTEGER references t(id))
				index idx_t_x on t (x)
				assertion a1 check (not exists (select 1 from t where x < 0))
			}`);
			await dump(db, 'diff schema pol', 'diff-1');
			await tryExec(db, 'apply schema pol', 'apply-table+index+assertion');
			await dump(db, 'diff schema pol', 'diff-2 (should be empty)');
		} finally {
			await db.close();
		}
	});

	it('declared schema, non-main: view only', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema vpol {
				table t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL)
				view v as select id, x from t
			}`);
			await dump(db, 'diff schema vpol', 'vdiff-1');
			await tryExec(db, 'apply schema vpol', 'apply-view');
		} finally {
			await db.close();
		}
	});

	it('declared schema, non-main: mv only', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema mpol {
				table t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL)
				materialized view mv as select id, x from t
			}`);
			await dump(db, 'diff schema mpol', 'mdiff-1');
			await tryExec(db, 'apply schema mpol', 'apply-mv');
		} finally {
			await db.close();
		}
	});
});
