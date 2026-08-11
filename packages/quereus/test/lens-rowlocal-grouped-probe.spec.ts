/**
 * The GROUPED deferred logical-row re-read on decomposition writes (ticket
 * `perf-lens-decomposition-update-probe-per-check`; docs/lens.md § Constraint
 * Attachment).
 *
 * A decomposition UPDATE's row-local rules (authored CHECKs and synthesized
 * NOT NULL obligations) are decided by ONE planned probe per
 * `(target relation, op shape)` of the fan-out — a message-valued CASE over the
 * logical row image — instead of one planned probe per rule. This suite pins
 * the two things the collapse must not lose:
 *
 *  - **exact per-rule failure attribution** — the literal messages
 *    `CHECK constraint failed: lens:<name>` / `NOT NULL constraint failed:
 *    <table>.<col>`, identical to what the per-rule constraint form produced;
 *  - **constant plan count** — the number of planned deferred constraints for a
 *    k-rule table does not grow with k (the whole point of the ticket).
 *
 * Behavior coverage of the seam itself (NULL writes, member-hop addressing,
 * grandfathering, OLD-correlated delete lowering) lives in
 * test/lens-row-local-null-write.spec.ts and test/lens-put-fanout.spec.ts.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type { MappingAdvertisement, LogicalColumnMapping } from '../src/vtab/mapping-advertisement.js';
import type { ModuleCapabilities } from '../src/vtab/capabilities.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { ConstraintCheckNode } from '../src/planner/nodes/constraint-check-node.js';
import { LENS_ROW_LOCAL_DEFERRED_NAME } from '../src/planner/mutation/lens-enforcement.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** Runs `fn`, expecting it to throw; returns the thrown error's message verbatim. */
async function captureErrorMessage(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error('expected the operation to throw');
}

/** A grandfathered memory module advertising whatever decomposition a test assigns. */
class GrandfatheredAdvertisingModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), permitsGrandfatheredNotNullViolators: true };
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

/** Columnar split over main.W_core (anchor: id, name) and main.W_tag (optional: tag). */
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
 * Deploys the split with `tableBody` as the logical W declaration and seeds one
 * satisfying row (id 1, name 'alpha', tag 'seed').
 */
async function setup(db: Database, tableBody: string): Promise<void> {
	await deploy(db, tableBody);
	await db.exec("insert into main.W_core values (1, 'alpha')");
	await db.exec("insert into main.W_tag values (1, 'seed')");
}

/** Deploys the split with `tableBody` as the logical W declaration, seeding nothing. */
async function deploy(db: Database, tableBody: string): Promise<void> {
	const mod = new GrandfatheredAdvertisingModule();
	mod.ads = [split()];
	db.registerModule('admod', mod);
	// `name` is explicitly nullable on both sides: columns default to NOT NULL,
	// and the NULL-rule case below needs a NULL name the basis itself accepts.
	await db.exec('create table W_core (id integer primary key, name text null) using admod');
	await db.exec('create table W_tag (id integer primary key, tag text) using admod');
	// Allow-lists for the subquery-bearing checks, deliberately NOT named `name` /
	// `tag`: a bare reference inside the subquery would resolve to the inner
	// relation's own column and the check would be vacuous.
	await db.exec('create table AllowName (av text primary key) using admod');
	await db.exec('create table AllowTag (bv text primary key) using admod');
	await db.exec(`declare logical schema x { table W { ${tableBody} } }`);
	await db.exec('apply schema x');
}

/** Both rule classes: an authored CHECK on `name` and a NOT NULL obligation on `tag`. */
const TWO_CLASS_BODY = "id integer primary key, name text null constraint name_rule check (name <> 'bad'), tag text not null";

describe('lens grouped deferred probe — exact per-rule failure attribution', () => {
	it("an authored CHECK violation reports the per-rule constraint form's literal message", async () => {
		const db = new Database();
		try {
			await setup(db, TWO_CLASS_BODY);
			const message = await captureErrorMessage(() => db.exec("update x.W set name = 'bad' where id = 1"));
			expect(message).to.equal('CHECK constraint failed: lens:name_rule');
			expect(await rows(db, 'select name from main.W_core where id = 1')).to.deep.equal([{ name: 'alpha' }]);
		} finally {
			await db.close();
		}
	});

	it('a NOT NULL violation reports its own class message, not an anonymous CHECK', async () => {
		const db = new Database();
		try {
			await setup(db, TWO_CLASS_BODY);
			// The all-null assignment lowers to a member DELETE — the OLD-correlated
			// grouped probe must still attribute the NOT NULL rule exactly.
			const message = await captureErrorMessage(() => db.exec('update x.W set tag = null where id = 1'));
			expect(message).to.equal('NOT NULL constraint failed: W.tag');
			expect(await rows(db, 'select tag from main.W_tag where id = 1')).to.deep.equal([{ tag: 'seed' }]);
		} finally {
			await db.close();
		}
	});

	it("a NULL rule passes its CASE branch (SQL's NULL-passes-a-CHECK convention survives grouping)", async () => {
		const db = new Database();
		try {
			await setup(db, TWO_CLASS_BODY);
			// `name <> 'bad'` evaluates NULL for a NULL name ⇒ that rule's branch is
			// not taken ⇒ passes; `tag` is still 'seed' ⇒ the whole probe is NULL.
			await db.exec('update x.W set name = null where id = 1');
			expect(await rows(db, 'select name, tag from x.W where id = 1')).to.deep.equal([{ name: null, tag: 'seed' }]);
		} finally {
			await db.close();
		}
	});

	it('two rules violated at once: the FIRST in obligation order is reported', async () => {
		const db = new Database();
		try {
			await setup(db, "id integer primary key, name text null constraint r_name check (name <> 'bad'), "
				+ "tag text null constraint r_tag check (tag <> 'bad')");
			// Both branches of the one CASE are live; the CASE takes the first taken
			// branch, which is the first rule in obligation order.
			const message = await captureErrorMessage(() => db.exec("update x.W set name = 'bad', tag = 'bad' where id = 1"));
			expect(message).to.equal('CHECK constraint failed: lens:r_name');
		} finally {
			await db.close();
		}
	});

	it('a satisfying multi-column update passes', async () => {
		const db = new Database();
		try {
			await setup(db, TWO_CLASS_BODY);
			await db.exec("update x.W set name = 'ok', tag = 'fine' where id = 1");
			expect(await rows(db, 'select name, tag from x.W where id = 1')).to.deep.equal([{ name: 'ok', tag: 'fine' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens grouped deferred probe — the INSERT seam groups too', () => {
	// The INSERT deferred branch (subquery-bearing checks riding the anchor op)
	// uses the same synthesizer, so several such checks now share ONE probe. Each
	// must still be attributed to itself, whichever one the row violates.
	const TWO_SUBQUERY_BODY =
		'id integer primary key, name text null, tag text null, '
		+ 'constraint a_rule check (exists (select 1 from AllowName where AllowName.av = name)), '
		+ 'constraint b_rule check (exists (select 1 from AllowTag where AllowTag.bv = tag))';

	async function setupAllowed(db: Database): Promise<void> {
		await deploy(db, TWO_SUBQUERY_BODY);
		await db.exec("insert into main.AllowName values ('ok')");
		await db.exec("insert into main.AllowTag values ('fine')");
	}

	it('a row satisfying both grouped checks inserts', async () => {
		const db = new Database();
		try {
			await setupAllowed(db);
			await db.exec("insert into x.W (id, name, tag) values (1, 'ok', 'fine')");
			expect(await rows(db, 'select id from x.W')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('either grouped check, violated alone, rejects with its own message', async () => {
		const db = new Database();
		try {
			await setupAllowed(db);
			expect(await captureErrorMessage(() => db.exec("insert into x.W (id, name, tag) values (2, 'nope', 'fine')")))
				.to.equal('CHECK constraint failed: lens:a_rule');
			expect(await captureErrorMessage(() => db.exec("insert into x.W (id, name, tag) values (3, 'ok', 'nope')")))
				.to.equal('CHECK constraint failed: lens:b_rule');
			expect(await rows(db, 'select id from x.W')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('lens grouped deferred probe — constant plan count', () => {
	function countGroupedConstraints(node: PlanNode): number {
		let count = 0;
		if (node instanceof ConstraintCheckNode) {
			count += node.constraintChecks.filter(c => c.constraint.name === LENS_ROW_LOCAL_DEFERRED_NAME).length;
		}
		for (const child of node.getChildren()) count += countGroupedConstraints(child);
		return count;
	}

	async function plannedCount(tableBody: string, sql: string): Promise<number> {
		const db = new Database();
		try {
			await setup(db, tableBody);
			return countGroupedConstraints(db.getPlan(sql));
		} finally {
			await db.close();
		}
	}

	it('the planned deferred-constraint count for a k-rule table does not grow with k', async () => {
		const sql = "update x.W set tag = 'v' where id = 1";
		// One rule: the NOT NULL obligation on `tag`.
		const oneRule = await plannedCount('id integer primary key, name text null, tag text not null', sql);
		// Four rules over the SAME members: the NOT NULL plus three authored CHECKs.
		const fourRules = await plannedCount(
			"id integer primary key, name text null, tag text not null, "
			+ "constraint r1 check (name <> 'x1'), constraint r2 check (tag <> 'x2'), constraint r3 check (name <> 'x3')",
			sql);
		expect(oneRule, 'the grouped probe is planned at all').to.be.greaterThan(0);
		expect(fourRules, 'rule count must not multiply the planned probes').to.equal(oneRule);
	});
});
