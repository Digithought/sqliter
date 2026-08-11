import type * as AST from '../../parser/ast.js';

// ──────────────────────────────────────────────────────────────────────
// Conservative FROM-frame model used by the schema-time expression scope
// walk (`./walk.ts`) and the two analyses layered on it — the self-qualifier
// strip (`../rename/self-qualifier-strip.ts`) and the generated-column
// reference collector (`../generated-column-refs.ts`). Unlike the column-rename
// walker's richer `ScopeFrame` (`../rename/column-rename.ts`), this model does
// not resolve sources to object keys; it only distinguishes analysable
// real-table sources (askable via `ResolveColumnInSource`) from opaque ones
// (subquery / function / CTE sources), which conservatively could bind
// anything.
// ──────────────────────────────────────────────────────────────────────

/** One FROM nesting level for a conservative scope walk. */
export interface ScopeFrame {
	/** Lowercase qualifier names this frame's FROM binds (table names, aliases, CTE names). */
	bound: Set<string>;
	/** Real-table sources, askable via the catalog callback for unqualified capture. */
	realSources: Array<{ schema: string; name: string }>;
	/**
	 * Frame contains sources whose column sets cannot be analyzed
	 * (subquery / function / CTE sources), or marks a context that must be
	 * treated as categorically unanalysable (CTE / derived-table bodies).
	 */
	hasOpaque: boolean;
	/**
	 * Marks a subtree whose names resolve in a naming environment this walk does not
	 * model at all (view write-through metadata: a result column's `with inverse`
	 * clause, a select's trailing `with defaults` clause, both evaluated against the
	 * written view row where `new.<output column>` is the naming environment).
	 * NOTHING below a sealed frame can reach the seed — not even the `new.` /
	 * owning-table spellings that an opaque frame still lets through, since the
	 * classifiers check those AFTER the frame loop. Implies {@link hasOpaque}.
	 */
	sealed: boolean;
	/** Lowercase CTE names declared at this level (consulted by nested FROMs). */
	cteNames: Set<string>;
}

export function emptyScopeFrame(): ScopeFrame {
	return { bound: new Set(), realSources: [], hasOpaque: false, sealed: false, cteNames: new Set() };
}

/** A frame that binds nothing but blocks every unqualified-capture question. */
export function opaqueScopeFrame(): ScopeFrame {
	const frame = emptyScopeFrame();
	frame.hasOpaque = true;
	return frame;
}

/** A frame nothing below can see past — see {@link ScopeFrame.sealed}. */
export function sealedScopeFrame(): ScopeFrame {
	const frame = opaqueScopeFrame();
	frame.sealed = true;
	return frame;
}

/**
 * Whether any frame above the seed is sealed. A flat scan of `stack[1..]` rather
 * than a position-relative check, which is correct precisely because a sealed
 * frame blocks UNCONDITIONALLY: it is only ever on the stack while the walk is
 * inside such a subtree.
 */
export function hasSealedFrame(stack: ReadonlyArray<ScopeFrame>): boolean {
	for (let i = 1; i < stack.length; i++) {
		if (stack[i].sealed) return true;
	}
	return false;
}

/** Whether any frame on the stack declares `name` (lowercase) as a CTE. */
export function isCteNameInScope(stack: ReadonlyArray<ScopeFrame>, name: string): boolean {
	for (const frame of stack) {
		if (frame.cteNames.has(name)) return true;
	}
	return false;
}

/**
 * Record one FROM item's bindings into `frame`. A table source whose bare name
 * is a CTE in scope (and carries no schema qualifier) is opaque — its column
 * set is not analyzed; every other table source is a real source the catalog
 * callback can be asked about. Subquery and function sources are opaque.
 */
export function collectScopeBindings(
	item: AST.FromClause,
	defaultSchema: string,
	stack: ReadonlyArray<ScopeFrame>,
	frame: ScopeFrame,
): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const name = ts.table.name.toLowerCase();
			frame.bound.add(ts.alias ? ts.alias.toLowerCase() : name);
			if (ts.table.schema === undefined && isCteNameInScope(stack, name)) {
				// CTE source — column set not analyzed.
				frame.hasOpaque = true;
			} else {
				frame.realSources.push({ schema: (ts.table.schema ?? defaultSchema).toLowerCase(), name });
			}
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectScopeBindings(join.left, defaultSchema, stack, frame);
			collectScopeBindings(join.right, defaultSchema, stack, frame);
			break;
		}
		case 'subquerySource': {
			frame.bound.add((item as AST.SubquerySource).alias.toLowerCase());
			frame.hasOpaque = true;
			break;
		}
		case 'functionSource': {
			const fs = item as AST.FunctionSource;
			if (fs.alias) frame.bound.add(fs.alias.toLowerCase());
			frame.hasOpaque = true;
			break;
		}
	}
}

/** Build the frame for a select body's FROM list. */
export function buildScopeFrame(
	from: AST.FromClause[] | undefined,
	defaultSchema: string,
	stack: ReadonlyArray<ScopeFrame>,
): ScopeFrame {
	const frame = emptyScopeFrame();
	(from ?? []).forEach(item => collectScopeBindings(item, defaultSchema, stack, frame));
	return frame;
}

/** Run `fn` with `frame` pushed on `stack`, popping it after. */
export function withScopeFrame<T>(stack: ScopeFrame[], frame: ScopeFrame, fn: () => T): T {
	stack.push(frame);
	try {
		return fn();
	} finally {
		stack.pop();
	}
}
