/**
 * Audit fixtures for the side-effect awareness discipline (`2-query-expr-side-effect-audit`).
 *
 * Every rule that moves, duplicates, drops, or merges a subtree must consult
 * `PlanNodeCharacteristics.hasSideEffects` (or `subtreeHasSideEffects`) and
 * refuse / weaken when any participating subtree carries a write.
 *
 * These fixtures use FROM-position DML — `INSERT ... RETURNING *` materialized
 * as a relational source — to plant a side-effect-bearing subtree where a
 * rule would otherwise have happily dropped / reordered / dedup-merged it.
 * They assert the **negative cases**: the rewrite must not fire. The matching
 * positive cases are covered by each rule's existing spec (where a pure subtree
 * lets the rule fire normally).
 *
 * The propagation pin and the registry rejection test live here too.
 */

import { expect } from 'chai';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Database } from '../../src/core/database.js';
import { readCode, stripComments } from '../util/source-scan.js';
import { PassManager, createPass, TraversalOrder } from '../../src/planner/framework/pass.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { RuleHandle } from '../../src/planner/framework/registry.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../src/planner/framework/characteristics.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function hasOp(rows: readonly PlanRow[], op: string): boolean {
	return rows.some(r => r.op === op);
}

async function setupBase(db: Database): Promise<void> {
	await db.exec(
		'CREATE TABLE writes_log (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) USING memory',
	);
	await db.exec(
		'CREATE TABLE seed (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) USING memory',
	);
	await db.exec('INSERT INTO seed VALUES (1, 10), (2, 20), (3, 30)');
}

describe('Side-effect audit: rules must refuse on impure subtrees', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	describe('Empty-relation / contradiction folds', () => {
		it('Filter(InsertReturning, false) does NOT fold to EmptyRelation', async () => {
			await setupBase(db);
			// FROM-position DML: a SELECT whose source is a RETURNING-bearing
			// INSERT. The outer `where false` would normally fold the whole
			// subtree to EmptyRelation; the audit forbids that because it would
			// silently skip the INSERT.
			const q = `select * from (insert into writes_log (id, x)
				select id, x from seed returning id) z where false`;
			const plan = await planRows(db, q);
			// The fold must NOT have replaced the INSERT with an EmptyRelation
			// host carrying writes_log's attributes.
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});
	});

	describe('Join folds / eliminations', () => {
		it('cross join with empty side does NOT fold when other side has side effects', async () => {
			await setupBase(db);
			const q = `select * from (insert into writes_log (id, x)
				select id, x from seed returning id) z cross join (select * from seed where false) e`;
			const plan = await planRows(db, q);
			// The other side is EmptyRelation, but the InsertReturning side has
			// side effects, so the cross-join fold must abstain.
			expect(hasOp(plan, 'INSERT')).to.equal(true);
		});
	});

	describe('Propagation', () => {
		it('plan walk surfaces a FROM-position INSERT in the plan tree', async () => {
			// A node whose physical.readonly is undefined-with-children inherits
			// AND-of-children, so a Sink (write) wrapped in pure relational ops
			// reports hasSideEffects=true at the root via the unified surface.
			// Here we verify the precondition that the plan still contains the
			// INSERT (i.e. nothing in the audit discipline elided it before the
			// runtime can fire); the per-rule audits above pin specific cases.
			await setupBase(db);
			const q = `select * from (insert into writes_log (id, x) values (99, 99) returning id) z`;
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'INSERT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		});
	});
});

describe('Registry guardrail: unannotated rules are rejected', () => {
	it('PassManager.addRuleToPass rejects a rule missing sideEffectMode', () => {
		const pass = createPass(
			'audit-test',
			'Audit test',
			'Synthesizes a rule registration to validate the guardrail',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);

		const unannotated = {
			id: 'unannotated-rule',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: (n: PlanNode) => n,
		} as unknown as RuleHandle;

		expect(() => pm.addRuleToPass('audit-test', unannotated))
			.to.throw(/sideEffectMode/);
	});

	it('accepts a rule that declares safe', () => {
		const pass = createPass(
			'audit-test-safe',
			'Audit test safe',
			'',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);
		expect(() => pm.addRuleToPass('audit-test-safe', {
			id: 'rule-safe',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: () => null,
			sideEffectMode: 'safe',
		})).to.not.throw();
	});

	it('accepts a rule that declares aware', () => {
		const pass = createPass(
			'audit-test-aware',
			'Audit test aware',
			'',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);
		expect(() => pm.addRuleToPass('audit-test-aware', {
			id: 'rule-aware',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: () => null,
			sideEffectMode: 'aware',
		})).to.not.throw();
	});
});

describe('subtreeHasSideEffects helper', () => {
	it('reports true when any descendant has readonly=false', () => {
		// Build a minimal plan-node mock tree: Project → Filter → Sink (write).
		const writeLeaf = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const filter = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [writeLeaf],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [filter],
		} as unknown as PlanNode;

		expect(PlanNodeCharacteristics.subtreeHasSideEffects(project)).to.equal(true);
	});

	it('reports false on a pure subtree', () => {
		const leaf = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [leaf],
		} as unknown as PlanNode;

		expect(PlanNodeCharacteristics.subtreeHasSideEffects(project)).to.equal(false);
	});

	it('reports true when the local node is pure but a deep descendant writes', () => {
		const writeLeaf = {
			physical: { readonly: false },
			getChildren: () => [],
		} as unknown as PlanNode;
		// Pure wrapper that fails to propagate readonly=false to its own
		// physical (defensive belt — the AND-of-children defaults are normally
		// applied, but a custom computePhysical override could lie).
		const lyingWrapper = {
			physical: { readonly: true },
			getChildren: () => [writeLeaf],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.subtreeHasSideEffects(lyingWrapper)).to.equal(true);
	});
});

// ---------------------------------------------------------------------------
// OPT-003 static guard
// ---------------------------------------------------------------------------

/** Local name -> module specifier, for the `import { ... } from '...'` lines of a module. */
function parseImportMap(code: string): Map<string, string> {
	const map = new Map<string, string>();
	const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;
	for (const m of code.matchAll(importRe)) {
		for (const raw of m[1].split(',')) {
			const name = raw.trim();
			if (!name) continue;
			// `X as Y` binds the local name Y.
			const local = name.includes(' as ') ? name.split(' as ')[1].trim() : name;
			map.set(local, m[2]);
		}
	}
	return map;
}

/**
 * Text of the `RULE_MANIFEST` array literal (between its `[` and matching `]`),
 * or the whole `code` when no such array is present (synthetic fixtures below
 * pass bare entry lists). Rules are registered from this manifest in `optimizer.ts`,
 * so the guard reads the manifest rather than individual `addRuleToPass` calls.
 */
function manifestRegion(code: string): string {
	const m = /RULE_MANIFEST\b[^=]*=\s*(?:readonly\s+)?\[/.exec(code);
	if (!m) return code;
	const open = m.index + m[0].length - 1; // index of the array's `[`
	let depth = 0;
	for (let j = open; j < code.length; j++) {
		if (code[j] === '[') depth++;
		else if (code[j] === ']' && --depth === 0) return code.slice(open + 1, j);
	}
	throw new Error('unbalanced RULE_MANIFEST array');
}

/**
 * Each manifest entry object-literal `{...}` in `code`. Manifest entries contain
 * no nested object literals, so we return every innermost brace block that names
 * an `id:` field — this skips the array's own brackets and any array-valued
 * `nodeType`, and ignores non-entry braces (e.g. import bindings).
 *
 * NOTE: assumes `RULE_MANIFEST` entries stay flat (no nested `{...}`). If an entry
 * ever gains an inline object literal (e.g. an options bag), the innermost-brace
 * scan would return the inner block instead of the entry — extend this to track
 * the entry's outer brace rather than the innermost one.
 */
function extractRuleEntries(code: string): string[] {
	const region = manifestRegion(code);
	const out: string[] = [];
	for (let i = 0; i < region.length; i++) {
		if (region[i] !== '{') continue;
		let depth = 0;
		let nested = false;
		let j = i;
		for (; j < region.length; j++) {
			if (region[j] === '{') { depth++; if (depth > 1) nested = true; }
			else if (region[j] === '}' && --depth === 0) break;
		}
		const body = region.slice(i + 1, j);
		if (!nested && /\bid:/.test(body)) out.push(body);
		i = j;
	}
	return out;
}

interface RuleRegistration {
	readonly id: string;
	readonly fn: string;
	readonly mode: string;
}

/** Every rule registration (one per manifest entry) in a comment-stripped `optimizer.ts`. */
function parseRuleRegistrations(code: string): RuleRegistration[] {
	return extractRuleEntries(code).map((entry, n) => {
		const id = /\bid:\s*(['"`])([^'"`]*)\1/.exec(entry)?.[2];
		const fn = /\bfn:\s*(\w+)/.exec(entry)?.[1];
		const mode = /\bsideEffectMode:\s*'(\w+)'/.exec(entry)?.[1];
		if (!id || !fn || !mode) {
			throw new Error(`rule manifest entry #${n} is missing id/fn/sideEffectMode — the guard cannot audit it`);
		}
		return { id, fn, mode };
	});
}

/**
 * Signals that constitute "consulting the side-effect question". `isFunctional`
 * (readonly *and* deterministic) is strictly stronger than `hasSideEffects`;
 * `isConcurrencySafe` is the parallel-rule form of the same refusal.
 */
const SIDE_EFFECT_SIGNALS = [
	'hasSideEffects',
	'subtreeHasSideEffects',
	'isConcurrencySafe',
	'isFunctional',
	'physical.readonly',
] as const;

/** `'aware'` rules that legitimately consult no signal, with the reason each is sound. */
const NO_SIGNAL_ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		'cte-optimization',
		'wraps the CTE body in a run-once CacheNode rather than refusing, so a write inside the body still executes exactly once — there is no signal to consult',
	],
]);

interface Unguarded {
	/**
	 * `'unresolved'` means the audit could not run on that rule at all, so the allowlist
	 * must not excuse it — otherwise renaming an allowlisted rule's import would silently
	 * stop auditing it.
	 */
	readonly kind: 'no-signal' | 'unresolved';
	readonly id: string;
	readonly reason: string;
}

/**
 * The `'aware'` rules whose source file names no side-effect signal, ignoring the
 * allowlist. `readRuleSource` maps an `fn:` local name to that rule's comment-stripped
 * source, or `undefined` if it cannot be resolved (which is itself reported).
 */
function auditAwareRules(
	optimizerCode: string,
	readRuleSource: (fnName: string) => string | undefined,
): { readonly awareIds: string[]; readonly unguarded: Unguarded[] } {
	const awareIds: string[] = [];
	const unguarded: Unguarded[] = [];
	for (const reg of parseRuleRegistrations(optimizerCode)) {
		if (reg.mode !== 'aware') continue;
		awareIds.push(reg.id);
		const code = readRuleSource(reg.fn);
		if (code === undefined) {
			unguarded.push({ kind: 'unresolved', id: reg.id, reason: `cannot resolve rule function \`${reg.fn}\` to a source file` });
		} else if (!SIDE_EFFECT_SIGNALS.some(s => code.includes(s))) {
			unguarded.push({ kind: 'no-signal', id: reg.id, reason: `\`${reg.fn}\` consults none of ${SIDE_EFFECT_SIGNALS.join(', ')}` });
		}
	}
	return { awareIds, unguarded };
}

/** An `'aware'` rule is excused only when it is allowlisted *and* the audit actually ran on it. */
function isExcused(u: Unguarded): boolean {
	return u.kind === 'no-signal' && NO_SIGNAL_ALLOWLIST.has(u.id);
}

describe("OPT-003 static guard: every 'aware' rule consults a side-effect signal", () => {
	// A rule that moves, drops, duplicates, or merges a subtree declares
	// `sideEffectMode: 'aware'` and must ask whether that subtree carries a write
	// before touching it. Registration (OPT-001) checks that the declaration exists;
	// nothing checks that the rule body honours it. This guard reads `optimizer.ts`,
	// collects every `'aware'` rule, resolves its `fn:` to the imported rule file, and
	// fails if that file never names a purity signal. A miss here is a wrong-answer bug
	// (a lost or duplicated write), not a missed optimization.
	//
	// NOTE: only the rule's own file is read. No rule currently delegates its refusal to a
	// helper module; if one ever does, it will be flagged as unguarded — extend the reader
	// to follow the rule file's imports rather than allowlisting the rule.
	const plannerDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/planner');
	const optimizerFile = join(plannerDir, 'optimizer.ts');

	/** Resolve an `fn:` local name to its comment-stripped rule source via the import map. */
	function ruleSourceReader(optimizerCode: string): (fnName: string) => string | undefined {
		const imports = parseImportMap(optimizerCode);
		return (fnName) => {
			const spec = imports.get(fnName);
			if (spec === undefined || !spec.startsWith('./')) return undefined;
			const file = join(plannerDir, spec.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
			return existsSync(file) ? readCode(file) : undefined;
		};
	}

	it("every 'aware' rule's source names a side-effect signal", () => {
		const code = readCode(optimizerFile);
		const { awareIds, unguarded } = auditAwareRules(code, ruleSourceReader(code));

		// Self-check: if the parser silently matched nothing, the guard would pass
		// vacuously. Every `sideEffectMode:` in the manifest must be one we parsed
		// (scoped to the manifest region so the `RuleManifestEntry` type declaration
		// and the registration loop's own `sideEffectMode:` don't inflate the count).
		const declared = manifestRegion(code).match(/\bsideEffectMode:/g)?.length ?? 0;
		expect(parseRuleRegistrations(code).length, 'parsed every manifest registration').to.equal(declared);
		expect(awareIds.length, "found the 'aware' rules").to.be.greaterThan(20);

		const offenders = unguarded
			.filter(u => !isExcused(u))
			.map(u => `${u.id}: ${u.reason}`);
		expect(offenders, `'aware' rules that consult no side-effect signal:\n${offenders.join('\n')}`).to.be.empty;
	});

	it('the allowlist has no stale entries', () => {
		const code = readCode(optimizerFile);
		const { awareIds, unguarded } = auditAwareRules(code, ruleSourceReader(code));
		const noSignalIds = new Set(unguarded.filter(u => u.kind === 'no-signal').map(u => u.id));

		for (const id of NO_SIGNAL_ALLOWLIST.keys()) {
			expect(awareIds, `allowlisted rule \`${id}\` is no longer registered as 'aware'`).to.include(id);
			expect(
				noSignalIds.has(id),
				`allowlisted rule \`${id}\` now consults a signal — drop it from NO_SIGNAL_ALLOWLIST`,
			).to.equal(true);
		}
	});

	it('flags a hand-written violation', () => {
		const optimizer = stripComments(`
			import { ruleGoodRule } from './rules/fake/rule-good.js';
			import { ruleBadRule } from './rules/fake/rule-bad.js';
			const RULE_MANIFEST = [
				{
					pass: PassId.Structural,
					id: 'good-rule',
					nodeType: PlanNodeType.Join,
					fn: ruleGoodRule,
					sideEffectMode: 'aware',
				},
				{
					pass: PassId.Structural,
					id: 'bad-rule',
					nodeType: PlanNodeType.Join,
					fn: ruleBadRule,
					// mentions subtreeHasSideEffects only in a comment
					sideEffectMode: 'aware',
				},
				{
					pass: PassId.Structural,
					id: 'safe-rule',
					nodeType: PlanNodeType.Join,
					fn: ruleBadRule,
					sideEffectMode: 'safe',
				},
			];
		`);
		const sources: Record<string, string> = {
			ruleGoodRule: 'if (PlanNodeCharacteristics.subtreeHasSideEffects(node)) return null;',
			ruleBadRule: 'return node.withChildren([node.getChildren()[1], node.getChildren()[0]]);',
		};
		const { awareIds, unguarded } = auditAwareRules(optimizer, fn => sources[fn]);

		expect(awareIds).to.deep.equal(['good-rule', 'bad-rule']);
		expect(unguarded).to.have.lengthOf(1);
		expect(unguarded[0].id).to.equal('bad-rule');
		expect(unguarded[0].reason).to.match(/consults none of/);
	});

	it('reports an aware rule whose function cannot be resolved to a file', () => {
		const optimizer = stripComments(`
			const RULE_MANIFEST = [
				{
					pass: PassId.Structural,
					id: 'ghost-rule',
					fn: ruleGhost,
					sideEffectMode: 'aware',
				},
			];
		`);
		const { unguarded } = auditAwareRules(optimizer, () => undefined);
		expect(unguarded[0].id).to.equal('ghost-rule');
		expect(unguarded[0].kind).to.equal('unresolved');
		expect(unguarded[0].reason).to.match(/^cannot resolve rule function/);
	});

	it('does not let the allowlist excuse a rule the audit could not read', () => {
		const allowlisted = [...NO_SIGNAL_ALLOWLIST.keys()][0];
		const optimizer = stripComments(`
			const RULE_MANIFEST = [
				{
					pass: PassId.Structural,
					id: '${allowlisted}',
					fn: ruleVanished,
					sideEffectMode: 'aware',
				},
			];
		`);
		const { unguarded } = auditAwareRules(optimizer, () => undefined);
		expect(unguarded.filter(u => !isExcused(u)).map(u => u.id)).to.deep.equal([allowlisted]);
	});

	it('rejects a registration that omits sideEffectMode rather than skipping it', () => {
		const optimizer = stripComments(`
			const RULE_MANIFEST = [
				{
					pass: PassId.Structural,
					id: 'unannotated',
					fn: ruleUnannotated,
				},
			];
		`);
		expect(() => parseRuleRegistrations(optimizer)).to.throw(/missing id\/fn\/sideEffectMode/);
	});
});
