import type { Database } from '../../src/index.js';

/**
 * Prepare `sql`, capture its instruction-program dump, and release the statement.
 * Shared by the specs that assert on emitted program shape rather than on rows.
 */
export function programOf(db: Database, sql: string): string {
	const stmt = db.prepare(sql);
	try {
		return stmt.getDebugProgram();
	} finally {
		void stmt.finalize();
	}
}

/**
 * The dump up to the sub-program section — i.e. the top-level pipeline only, so an
 * assertion cannot be satisfied by an instruction that lives inside a subquery.
 */
export function topLevelProgram(db: Database, sql: string): string {
	return programOf(db, sql).split('=== SUB-PROGRAMS ===')[0];
}
