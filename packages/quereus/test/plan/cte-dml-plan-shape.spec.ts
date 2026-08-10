import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { CTENode } from '../../src/planner/nodes/cte-node.js';
import { serializePlanForGolden } from './_helpers.js';

/**
 * Structural plan-shape parity for the three single-source DML write-target forms
 * that all funnel through `buildViewMutation` (planner/building/view-mutation-builder.ts):
 *
 *   - a **named view**  (`create view t as …` then `update t …`),
 *   - a **CTE name**    (`with t as (…) update t …`), and
 *   - an **inline subquery** (`update (select …) as v …`).
 *
 * For a single-source projection-and-filter body each lowers to the SAME wrapped
 * base-op subtree under a `ViewMutationNode` (docs/vu-operators.md § Common
 * Table Expressions, docs/vu-roundtrip.md § Round-Trip Laws). `test/logic/93.4-view-mutation.sqllogic`
 * already pins this as observable base-table STATE parity; this spec pins the
 * stronger **structural** claim: the `ViewMutationNode` subtrees are byte-identical
 * once per-plan id offsets are canonicalized away.
 *
 * **Why a canonicalizer at all.** `getPlan` returns the *optimized* tree, and the
 * three forms allocate a different number of plan-node / attribute ids before
 * reaching the shared base-op subtree, so absolute ids sit at different offsets.
 * `serializePlanForGolden` already strips ` [n]` / `#n` id tokens from `detail` and
 * drops logical keys literally named `id`, but two id-bearing values survive in the
 * `physical.updateLineage` `$map` and must be neutralized:
 *
 *   1. the `$map` **keys** — each an output attribute id (the map is keyed by
 *      attribute id), and
 *   2. each base site's `"table"` field — the producing `TableReferenceNode`'s
 *      plan-node id (see `UpdateSite` in planner/nodes/plan-node.ts).
 *
 * NB: for THIS optimized single-source plan no `ColumnReferenceNode.attributeId`
 * value survives — the `id = 1` predicate folds into the `IndexSeek` seek key and
 * the assignment is a literal — so the leak the canonicalizer must erase lives in
 * `updateLineage`, not in a bare `attributeId`. The `attributeId` remap is kept as a
 * defensive no-op for plans where one does survive. The **self-stability guard**
 * below is the authority on completeness: it plans the SAME form at two different
 * counter offsets and requires the canonicalized snapshots to match, so any missed
 * id-bearing token fails it (and the comparison tests then need no counter reset).
 */

const BASE_DDL = 'create table b (id integer primary key, color text)';
const VIEW_DDL = 'create view t as select id, color from b';

// The three forms of each DML over the same base table + body. The named-view and
// CTE forms both spell the target `t` (the leading `with t as (…)` shadows the view
// as the write target — see 93.4 § Shadow); the inline form aliases the body `v`.
const UPDATE_FORMS = {
	named: "update t set color = 'x' where id = 1",
	cte: "with t as (select id, color from b) update t set color = 'x' where id = 1",
	inline: "update (select id, color from b) as v set color = 'x' where v.id = 1",
} as const;

const DELETE_FORMS = {
	named: 'delete from t where id = 1',
	cte: 'with t as (select id, color from b) delete from t where id = 1',
	inline: 'delete from (select id, color from b) as v where v.id = 1',
} as const;

// INSERT: the named-view and CTE forms admit it; the inline form rejects INSERT
// (it parses as a non-target), so only the named↔CTE pair is compared.
const INSERT_FORMS = {
	named: "insert into t (id, color) values (4, 'k')",
	cte: "with t as (select id, color from b) insert into t (id, color) values (4, 'k')",
} as const;

/** Depth-first search for the first `ViewMutationNode` — the mutation substrate all
 *  three forms wrap their lowered base op in (view-mutation-node.ts). */
function viewMutationSubtree(root: PlanNode): PlanNode {
	const stack: PlanNode[] = [root];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (node.nodeType === PlanNodeType.ViewMutation) return node;
		for (const child of node.getChildren()) stack.push(child);
	}
	throw new Error('no ViewMutationNode in the optimized plan');
}

/**
 * Remap every per-plan id in a serialized subtree to a first-appearance ordinal, so
 * the snapshot is invariant to the counter offset at which the plan happened to be
 * built. Two independent id namespaces are renumbered (kept separate so an attribute
 * id and a node id that happen to share a value are never conflated):
 *
 *  - **attribute ids** — the `updateLineage` `$map` keys (`["<attrId>", { "kind": … }`)
 *    plus any surviving `ColumnReferenceNode` `"attributeId": <n>` value, and
 *  - **plan-node ids** — each base site's `"table": <n>` (a numeric `"table"` is always
 *    a node id; the logical table *name* renders as a quoted string).
 */
function canonicalizePlanIds(snapshot: string): string {
	const attrOrder = new Map<string, number>();
	const attrOrdinal = (id: string): string => {
		if (!attrOrder.has(id)) attrOrder.set(id, attrOrder.size);
		return String(attrOrder.get(id)!);
	};
	let out = snapshot
		.replace(/(\[\s*)"(\d+)"(,\s*\{\s*"kind":)/g, (_m, pre, id, post) => `${pre}"${attrOrdinal(id)}"${post}`)
		.replace(/("attributeId": )(\d+)/g, (_m, pre, id) => `${pre}${attrOrdinal(id)}`);

	const nodeOrder = new Map<string, number>();
	const nodeOrdinal = (id: string): string => {
		if (!nodeOrder.has(id)) nodeOrder.set(id, nodeOrder.size);
		return String(nodeOrder.get(id)!);
	};
	out = out.replace(/("table": )(\d+)/g, (_m, pre, id) => `${pre}${nodeOrdinal(id)}`);
	return out;
}

/** The raw (offset-bearing) serialized `ViewMutationNode` subtree for `sql`. */
function rawSubtree(db: Database, sql: string): string {
	return serializePlanForGolden(viewMutationSubtree(db.getPlan(sql)));
}

/** The canonicalized serialized `ViewMutationNode` subtree for `sql`. */
function subtree(db: Database, sql: string): string {
	return canonicalizePlanIds(rawSubtree(db, sql));
}

describe('CTE / inline-subquery DML write target: plan-shape parity', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(BASE_DDL);
		await db.exec(VIEW_DDL);
	});
	afterEach(async () => { await db.close(); });

	// Deliberately NOT wrapped in withDeterministicPlanIds — the canonicalizer is what
	// makes the counter offset irrelevant, and this guard is what proves it. Plan the
	// named-view form, advance the global id counters with an unrelated throwaway plan,
	// then plan it again: the raw snapshots MUST differ (the offset really moved) and
	// the canonicalized snapshots MUST match (the canonicalizer erased that offset).
	// A missed id-bearing token — a `$map` key, a base-site node id, a future descriptor
	// array — would survive the offset and fail the second assertion, so this is the
	// completeness authority for `canonicalizePlanIds`.
	it('self-stability: the same form canonicalizes identically at two counter offsets', () => {
		const rawA = rawSubtree(db, UPDATE_FORMS.named);
		db.getPlan('select id, color from b where color = \'advance-the-counters\''); // throwaway
		const rawB = rawSubtree(db, UPDATE_FORMS.named);

		expect(rawA, 'the throwaway plan must shift the id offset (else the guard is vacuous)')
			.to.not.equal(rawB);
		expect(canonicalizePlanIds(rawA), 'canonicalization must erase the offset')
			.to.equal(canonicalizePlanIds(rawB));
	});

	it('UPDATE: named view ≡ CTE name ≡ inline subquery', () => {
		const named = subtree(db, UPDATE_FORMS.named);
		expect(subtree(db, UPDATE_FORMS.cte), 'CTE-name UPDATE subtree differs from the named view').to.equal(named);
		expect(subtree(db, UPDATE_FORMS.inline), 'inline-subquery UPDATE subtree differs from the named view').to.equal(named);
	});

	it('DELETE: named view ≡ CTE name ≡ inline subquery', () => {
		const named = subtree(db, DELETE_FORMS.named);
		expect(subtree(db, DELETE_FORMS.cte), 'CTE-name DELETE subtree differs from the named view').to.equal(named);
		expect(subtree(db, DELETE_FORMS.inline), 'inline-subquery DELETE subtree differs from the named view').to.equal(named);
	});

	it('INSERT: named view ≡ CTE name (inline form rejects INSERT)', () => {
		const named = subtree(db, INSERT_FORMS.named);
		expect(subtree(db, INSERT_FORMS.cte), 'CTE-name INSERT subtree differs from the named view').to.equal(named);
	});

	// Anti-vacuity: the extraction is a real, non-empty base-op subtree (so an
	// empty/short-circuited extraction cannot pass the parity asserts silently), and
	// the canonicalizer is not collapsing everything to a constant.
	it('the compared subtree is a real, non-empty base-op mutation tree', () => {
		const named = subtree(db, UPDATE_FORMS.named);
		expect(named.length, 'a non-trivial serialized subtree').to.be.greaterThan(500);
		expect(named, 'the lowered op writes the base table b').to.contain('"table": "b"');
		expect(named, 'the wrapper is a VIEW MUTATION op').to.contain('VIEW MUTATION');
	});

	it('a divergent predicate canonicalizes to a different string', () => {
		const baseline = subtree(db, UPDATE_FORMS.named);
		const divergent = subtree(db, "update t set color = 'x' where id = 2");
		expect(divergent, 'a different seek-key literal must survive canonicalization').to.not.equal(baseline);
	});
});

/** Every `CTENode` instance reachable from `root`, in discovery order. */
function cteNodes(root: PlanNode): CTENode[] {
	const found: CTENode[] = [];
	const stack: PlanNode[] = [root];
	const seen = new Set<PlanNode>();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (node instanceof CTENode) found.push(node);
		for (const child of node.getChildren()) stack.push(child);
	}
	return found;
}

/**
 * A CTE whose body writes rows must run that write exactly once per statement
 * execution, however many times the query names it. Two plan-level properties carry
 * that guarantee, and each was independently broken before
 * (`bug-dml-cte-executes-once-per-reference`):
 *
 *  1. **every** `CTENode` instance in the optimized plan carries `materialize = true`
 *     — set at build time in planner/building/with.ts rather than left to the
 *     reference-count gate in planner/cache/materialization-advisory.ts, which
 *     undercounts (two mentions sharing an alias collapse to one
 *     `CTEReferenceNode`, so the `CTENode` shows a single parent), and
 *  2. all those instances share **one** `tableDescriptor` object — the key
 *     `emitCTE` uses for its per-execution buffer. The optimizer does not promise a
 *     single instance: the constant-folding pass (planner/analysis/const-pass.ts)
 *     rebuilds a two-parent node once per parent path, so a `values`-bodied INSERT
 *     really does end up as two `CTENode`s. Two descriptors would mean two buffers,
 *     i.e. two writes.
 *
 * `test/logic/13.6-cte-dml-runs-once.sqllogic` pins the observable row-set and
 * base-table state; this spec pins the plan-level invariants that produce them, so a
 * regression names its own cause instead of surfacing as a mystery duplicate-key error.
 */
describe('data-modifying CTE: plan-shape invariants', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table w (k integer primary key, v integer)');
		await db.exec('create table u (k integer primary key)');
	});
	afterEach(async () => { await db.close(); });

	// Both body shapes matter: a `values` body constant-folds (and so gets split into
	// several CTENode instances), a `select … from u` body does not.
	const DML_BODIES = {
		'insert … values': "with c as (insert into w (k) values (1) returning k) select (select count(*) from c) a, (select count(*) from c) b",
		'insert … select': "with c as (insert into w (k) select k from u returning k) select (select count(*) from c) a, (select count(*) from c) b",
		update: 'with c as (update w set v = v + 1 returning k, v) select (select count(*) from c) a, (select count(*) from c) b',
		delete: 'with c as (delete from w where k = 1 returning k) select (select count(*) from c) a, (select count(*) from c) b',
		'insert, joined twice': 'with c as (insert into w (k) values (1) returning k) select count(*) n from c c1 join c c2 on c1.k = c2.k',
		'insert, MATERIALIZED hint': 'with c as materialized (insert into w (k) values (1) returning k) select (select count(*) from c) a, (select count(*) from c) b',
		// The hint is deliberately overridden: honoring it would license a second write.
		'insert, NOT MATERIALIZED hint': 'with c as not materialized (insert into w (k) values (1) returning k) select (select count(*) from c) a, (select count(*) from c) b',
		'insert, referenced once': 'with c as (insert into w (k) values (1) returning k) select k from c',
	} as const;

	for (const [label, sql] of Object.entries(DML_BODIES)) {
		it(`${label}: every CTENode is materialized and all share one tableDescriptor`, () => {
			const nodes = cteNodes(db.getPlan(sql));

			expect(nodes.length, 'the DML-bodied CTE must survive into the optimized plan').to.be.greaterThan(0);
			for (const node of nodes) {
				expect(node.materialize, `CTENode ${node.cteName} (id ${node.id}) is not materialized`).to.equal(true);
			}
			const descriptors = new Set(nodes.map(n => n.tableDescriptor));
			expect(descriptors.size, `${nodes.length} CTENode instance(s) carry ${descriptors.size} distinct descriptors`).to.equal(1);
		});
	}

	// Anti-vacuity for the descriptor assert: prove the split this fix survives is real,
	// i.e. that at least one covered shape genuinely yields two CTENode instances. If the
	// optimizer ever stops splitting, this fails loudly rather than letting the
	// single-descriptor assert quietly become a tautology for every case.
	it('a constant-foldable DML body really is split into 2+ CTENode instances', () => {
		const nodes = cteNodes(db.getPlan(DML_BODIES['insert … values']));
		expect(nodes.length, 'expected the constant-folding pass to rebuild the shared CTENode per parent path')
			.to.be.greaterThan(1);
	});

	// Guard the other direction: the build-time mark is scoped to writing bodies only.
	// A read-only CTE keeps flowing through the advisory pass, which leaves a
	// single-reference one unmaterialized (streaming, so an outer LIMIT can cut it off).
	it('a SELECT-bodied CTE referenced once is NOT force-materialized', () => {
		const nodes = cteNodes(db.getPlan('with c as (select k from u) select k from c'));
		expect(nodes.length, 'the CTE must survive into the optimized plan').to.be.greaterThan(0);
		for (const node of nodes) {
			expect(node.materialize, `read-only CTENode ${node.cteName} was force-materialized`).to.equal(false);
		}
	});
});
