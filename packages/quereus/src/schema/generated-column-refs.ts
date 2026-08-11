import type * as AST from '../parser/ast.js';
import { eq, type ResolveColumnInSource } from './rename/shared.js';
import { hasSealedFrame, type ScopeFrame } from './expr-scope/frame.js';
import { walkSchemaExpressionScope } from './expr-scope/walk.js';

// ──────────────────────────────────────────────────────────────────────
// Scope-aware reference collection for GENERATED ALWAYS AS bodies.
//
// The two schema-time analyses of a generated expression — dependency-graph
// extraction (`extractGeneratedColumnDependencies`) and the ALTER ADD COLUMN
// pre-flight (`validateAddColumnGeneratedRefs`), both in `./table.ts` — need
// one shared answer to "does this name bind the owning table's row?". The
// walk is the shared schema-time scope traversal (`./expr-scope/walk.ts`) the
// CHECK self-qualifier strip also runs on, with its conservative frame model
// (`./expr-scope/frame.ts`): real-table FROM sources are asked via
// `ResolveColumnInSource`; subquery / function / CTE sources are opaque and
// make the answer undecidable rather than wrong. This file supplies only the
// per-leaf classification.
//
// A qualified reference whose qualifier no frame binds is `'unbound'`: nothing
// in the body, and nothing at write time, can ever resolve it. Both consumers
// reject `'unbound'` at declaration time rather than deferring to a write-time
// failure — see `unboundQualifierError` in `./table.ts`.
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
	/** Binds something else — an analysable inner FROM source exposes the name, the
	 *  qualifier resolves to another object, or the reference sits under a sealed
	 *  frame (view write-through metadata, resolved against the written view row).
	 *  Ignored by both consumers: no dependency edge, no error. */
	| 'foreign'
	/** Qualified, and NOTHING binds the qualifier — no inner FROM, and it does not
	 *  name the owning table (or `new`). There is nothing for it to resolve against
	 *  at write time either; rejected at declaration time by both consumers. */
	| 'unbound'
	/** Cannot be decided: an intervening frame holds a subquery / function / CTE source. */
	| 'unknown';

export interface GeneratedColumnRef {
	/** Lowercase name, for column-map lookups. */
	readonly name: string;
	/** Name as written (original casing), for error messages. */
	readonly originalName: string;
	/** Qualifier as written (original casing), e.g. `d` or `s.d`, when the reference
	 *  carried one — used to report `'unbound'` errors. */
	readonly originalQualifier?: string;
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
		refs: [],
	};
	walkSchemaExpressionScope(
		expr,
		{ defaultSchema: state.schemaName, seedBindings: [state.tableName] },
		{
			onColumn: (col, stack) => recordColumnRef(col, stack, state),
			onIdentifier: (ident, stack) => recordIdentifierRef(ident, stack, state),
		},
	);
	return state.refs;
}

/**
 * How every reference under a sealed frame classifies — see
 * {@link ScopeFrame.sealed}. Not `'unknown'`: that binding means "an opaque
 * source MIGHT be this row", and both consumers hedge by recording a dependency
 * edge for it. A sealed subtree is view write-through metadata, inert wherever a
 * schema expression can hold it and resolved against the written view row if
 * ever evaluated — it is DEFINITELY not this row, so an edge there is spurious
 * and can raise a false `Cyclic dependency in generated columns` at DDL time.
 * `'foreign'` says "binds something else" and is the one binding both consumers
 * ignore outright.
 */
const sealedBinding: RefBinding = 'foreign';

/**
 * Classify an unqualified name against the frames above the seed,
 * innermost-first: a real source exposing the name binds it there
 * (`'foreign'`); an opaque frame reached before any such source could bind
 * anything (`'unknown'`); falling through every frame reaches the seed
 * (`'own'`). `stack[0]` IS that seed, which is why the loop stops at index 1.
 *
 * A sealed frame anywhere above the seed short-circuits to `'foreign'` — see
 * {@link sealedBinding}.
 */
function classifyUnqualified(
	state: CollectState,
	stack: ReadonlyArray<ScopeFrame>,
	nameLower: string,
): RefBinding {
	if (hasSealedFrame(stack)) return sealedBinding;
	for (let i = stack.length - 1; i >= 1; i--) {
		const frame = stack[i];
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
 * frame binding it wins first); a bare `old`, or any other qualifier, must
 * name the owning table — schema-qualified spellings must name the owning
 * schema exactly, matching the self-qualifier strip's rule. Anything else is
 * `'unbound'` (nothing binds it) unless an opaque frame was crossed on the
 * way out, in which case the walk cannot tell and defers to `'unknown'`.
 *
 * A sealed frame short-circuits to `'foreign'` BEFORE any of that: `new.a`
 * inside a `with inverse (…)` clause names the written view row, not the row of
 * the table being defined, so the `'new'` arm below must never see it.
 */
function classifyQualified(
	state: CollectState,
	stack: ReadonlyArray<ScopeFrame>,
	col: AST.ColumnExpr,
): RefBinding {
	if (hasSealedFrame(stack)) return sealedBinding;
	const qualifier = col.table!.toLowerCase();
	let opaque = false;
	for (let i = stack.length - 1; i >= 1; i--) {
		if (stack[i].bound.has(qualifier)) return 'foreign';
		if (stack[i].hasOpaque) opaque = true;
	}
	if (col.schema === undefined) {
		if (qualifier === 'new') return 'own';
		if (qualifier === state.tableName) return 'own';
	} else if (qualifier === state.tableName && eq(col.schema, state.schemaName)) {
		return 'own';
	}
	return opaque ? 'unknown' : 'unbound';
}

function recordColumnRef(
	col: AST.ColumnExpr,
	stack: ReadonlyArray<ScopeFrame>,
	state: CollectState,
): void {
	const nameLower = col.name.toLowerCase();
	const binding = col.table === undefined
		? classifyUnqualified(state, stack, nameLower)
		: classifyQualified(state, stack, col);
	state.refs.push({
		name: nameLower,
		originalName: col.name,
		originalQualifier: col.schema !== undefined ? `${col.schema}.${col.table}` : col.table,
		shape: 'column',
		binding,
	});
}

function recordIdentifierRef(
	ident: AST.IdentifierExpr,
	stack: ReadonlyArray<ScopeFrame>,
	state: CollectState,
): void {
	// A schema-qualified identifier can never be a column of the table being
	// defined — same skip the previous traverseAst-based analysis applied.
	if (ident.schema) return;
	const nameLower = ident.name.toLowerCase();
	state.refs.push({
		name: nameLower,
		originalName: ident.name,
		shape: 'identifier',
		binding: classifyUnqualified(state, stack, nameLower),
	});
}
