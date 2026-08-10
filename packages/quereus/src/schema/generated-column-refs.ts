import type * as AST from '../parser/ast.js';
import { eq, type ResolveColumnInSource } from './rename/shared.js';
import {
	buildScopeFrame,
	emptyScopeFrame,
	opaqueScopeFrame,
	withScopeFrame,
	type ScopeFrame,
} from './rename/scope-frame.js';

// ──────────────────────────────────────────────────────────────────────
// Scope-aware reference collection for GENERATED ALWAYS AS bodies.
//
// The two schema-time analyses of a generated expression — dependency-graph
// extraction (`extractGeneratedColumnDependencies`) and the ALTER ADD COLUMN
// pre-flight (`validateAddColumnGeneratedRefs`), both in `./table.ts` — need
// one shared answer to "does this name bind the owning table's row?". The
// walk uses the same conservative frame model as the CHECK self-qualifier
// strip (`./rename/scope-frame.ts`): real-table FROM sources are asked via
// `ResolveColumnInSource`; subquery / function / CTE sources are opaque and
// make the answer undecidable rather than wrong.
//
// NOTE: residual — a reference to an own-column NAME reachable only through
// an opaque source (e.g. a CTE shadowing the owning table) classifies as
// 'unknown', and the consumers record a dependency edge for it. That edge is
// the safe half of the asymmetry (a missing edge would compute a generated
// column before its dependency and silently write NULL), but it means two
// generated columns whose bodies reach each other's names only through
// opaque sources still raise a false cycle error.
// ──────────────────────────────────────────────────────────────────────

/** How a reference in a generated body relates to the table being defined. */
export type RefBinding =
	/** Binds the owning table's row: bare name captured by the seed, `<table>.<col>`,
	 *  `<own-schema>.<table>.<col>`, or an unrebound `new.<col>`. */
	| 'own'
	/** Binds something else: an analysable inner FROM source exposes the name, or the
	 *  qualifier resolves to another object. */
	| 'foreign'
	/** Cannot be decided: an intervening frame holds a subquery / function / CTE source. */
	| 'unknown';

export interface GeneratedColumnRef {
	/** Lowercase name, for column-map lookups. */
	readonly name: string;
	/** Name as written (original casing), for error messages. */
	readonly originalName: string;
	/** `'column'` refs may raise "not found"; `'identifier'` refs never do (a bare
	 *  identifier may legitimately be a function or a mutation-context variable). */
	readonly shape: 'column' | 'identifier';
	readonly binding: RefBinding;
}

interface CollectState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase owning schema name. */
	schemaName: string;
	resolve: ResolveColumnInSource;
	/** Index 0 is the implicit seed frame binding the owning table. */
	stack: ScopeFrame[];
	refs: GeneratedColumnRef[];
}

/**
 * Collect every column / identifier reference in a generated-column body,
 * classified against the table being defined. `resolveColumnInSource` answers
 * "does source `<schema>.<table>` expose column `<name>`?" — callers wrap the
 * catalog resolver so questions about the target table itself are answered
 * from the in-flight column list (the catalog may not hold the table yet, or
 * may hold a stale pre-ALTER column set).
 */
export function collectGeneratedColumnRefs(
	expr: AST.Expression,
	tableName: string,
	schemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
): GeneratedColumnRef[] {
	const state: CollectState = {
		tableName: tableName.toLowerCase(),
		schemaName: schemaName.toLowerCase(),
		resolve: resolveColumnInSource,
		stack: [],
		refs: [],
	};
	const seed = emptyScopeFrame();
	seed.bound.add(state.tableName);
	withScopeFrame(state.stack, seed, () => visitCollect(expr, state));
	return state.refs;
}

/**
 * Classify an unqualified name against the frames above the seed,
 * innermost-first: a real source exposing the name binds it there
 * (`'foreign'`); an opaque frame reached before any such source could bind
 * anything (`'unknown'`); falling through every frame reaches the seed
 * (`'own'`).
 */
function classifyUnqualified(state: CollectState, nameLower: string): RefBinding {
	for (let i = state.stack.length - 1; i >= 1; i--) {
		const frame = state.stack[i];
		for (const src of frame.realSources) {
			if (state.resolve(src.schema, src.name, nameLower)) return 'foreign';
		}
		if (frame.hasOpaque) return 'unknown';
	}
	return 'own';
}

/**
 * Classify a qualified reference. A qualifier bound by any inner FROM (alias,
 * bare table name, or CTE name) resolves there. An unbound bare `new` names
 * the row image of the table being defined (the same rule `matchesRowImage`
 * applies in `./rename/column-rename.ts` — `new` is not a reserved word, so a
 * frame binding it wins first); an unbound bare `old` names nothing in a
 * generated body (there is no old row to compute from). Otherwise the
 * qualifier must name the owning table — schema-qualified spellings must name
 * the owning schema exactly, matching the self-qualifier strip's rule.
 */
function classifyQualified(state: CollectState, col: AST.ColumnExpr): RefBinding {
	const qualifier = col.table!.toLowerCase();
	for (let i = state.stack.length - 1; i >= 1; i--) {
		if (state.stack[i].bound.has(qualifier)) return 'foreign';
	}
	if (col.schema === undefined) {
		if (qualifier === 'new') return 'own';
		if (qualifier === 'old') return 'foreign';
		return qualifier === state.tableName ? 'own' : 'foreign';
	}
	return qualifier === state.tableName && eq(col.schema, state.schemaName) ? 'own' : 'foreign';
}

function recordColumnRef(col: AST.ColumnExpr, state: CollectState): void {
	const nameLower = col.name.toLowerCase();
	const binding = col.table === undefined
		? classifyUnqualified(state, nameLower)
		: classifyQualified(state, col);
	state.refs.push({ name: nameLower, originalName: col.name, shape: 'column', binding });
}

function recordIdentifierRef(ident: AST.IdentifierExpr, state: CollectState): void {
	// A schema-qualified identifier can never be a column of the table being
	// defined — same skip the previous traverseAst-based analysis applied.
	if (ident.schema) return;
	const nameLower = ident.name.toLowerCase();
	state.refs.push({
		name: nameLower,
		originalName: ident.name,
		shape: 'identifier',
		binding: classifyUnqualified(state, nameLower),
	});
}

/** Visit a node whose scope cannot be analyzed (CTE / derived-table / DML bodies). */
function visitCollectBarrier(node: AST.AstNode | undefined, state: CollectState): void {
	withScopeFrame(state.stack, opaqueScopeFrame(), () => visitCollect(node, state));
}

function visitCollect(node: AST.AstNode | undefined, state: CollectState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			const withFrame = emptyScopeFrame();
			withScopeFrame(state.stack, withFrame, () => {
				for (const cte of stmt.withClause?.ctes ?? []) {
					// A CTE body's scope is not analyzed — refs inside classify
					// conservatively through the barrier.
					visitCollectBarrier(cte.query, state);
					withFrame.cteNames.add(cte.name.toLowerCase());
				}
				const frame = buildScopeFrame(stmt.from, state.schemaName, state.stack);
				withScopeFrame(state.stack, frame, () => {
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') visitCollect(c.expr, state);
					});
					(stmt.from ?? []).forEach(f => visitCollect(f, state));
					visitCollect(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitCollect(g, state));
					visitCollect(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitCollect(o.expr, state));
					visitCollect(stmt.limit, state);
					visitCollect(stmt.offset, state);
					visitCollect(stmt.union, state);
					if (stmt.compound) visitCollect(stmt.compound.select, state);
				});
			});
			break;
		}
		// DML bodies (reachable via a subquery source / scalar subquery over
		// `insert … returning` etc.) bind names against their target table in
		// ways this walk does not model — descend under a barrier so their refs
		// classify 'unknown' rather than falsely 'own'.
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			withScopeFrame(state.stack, opaqueScopeFrame(), () => {
				stmt.withClause?.ctes.forEach(cte => visitCollectBarrier(cte.query, state));
				visitCollect(stmt.source, state);
			});
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			withScopeFrame(state.stack, opaqueScopeFrame(), () => {
				stmt.withClause?.ctes.forEach(cte => visitCollectBarrier(cte.query, state));
				visitCollect(stmt.targetSource, state);
				stmt.assignments.forEach(a => visitCollect(a.value, state));
				visitCollect(stmt.where, state);
			});
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			withScopeFrame(state.stack, opaqueScopeFrame(), () => {
				stmt.withClause?.ctes.forEach(cte => visitCollectBarrier(cte.query, state));
				visitCollect(stmt.targetSource, state);
				visitCollect(stmt.where, state);
			});
			break;
		}
		case 'values': {
			(node as AST.ValuesStmt).values.forEach(row => row.forEach(v => visitCollect(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitCollect(join.left, state);
			visitCollect(join.right, state);
			visitCollect(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visitCollect(a, state));
			break;
		}
		case 'subquerySource': {
			// A derived table's body scope is not analyzed — barrier.
			visitCollectBarrier((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitCollect(e.left, state);
			visitCollect(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visitCollect((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visitCollect(a, state));
			break;
		case 'subquery':
			visitCollect((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitCollect(wf.function, state);
			visitCollect(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitCollect(p, state));
			(wd.orderBy ?? []).forEach(o => visitCollect(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitCollect(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitCollect(wt.when, state);
				visitCollect(wt.then, state);
			});
			visitCollect(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitCollect(ie.expr, state);
			(ie.values ?? []).forEach(v => visitCollect(v, state));
			visitCollect(ie.subquery, state);
			break;
		}
		case 'exists':
			visitCollect((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitCollect(be.expr, state);
			visitCollect(be.lower, state);
			visitCollect(be.upper, state);
			break;
		}
		case 'column':
			recordColumnRef(node as AST.ColumnExpr, state);
			break;
		case 'identifier':
			recordIdentifierRef(node as AST.IdentifierExpr, state);
			break;
		default:
			break;
	}
}
