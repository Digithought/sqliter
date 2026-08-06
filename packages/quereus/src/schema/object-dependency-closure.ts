import type * as AST from '../parser/ast.js';
import type { Database } from '../core/database.js';
import { collectTableRefsInAst, objectRefKeySchema, type ResolveObjectRef, type TableRenameOpts } from './rename-rewriter.js';
import type { ObjectRefResolvers } from './object-ref-resolver.js';
import { isMaintainedTable } from './derivation.js';

/**
 * The catalog query "can this stored body REACH that object?", as opposed to the
 * one-hop "does this stored body NAME that object?" the rename walkers answer.
 *
 * A DROP guard that only asks the one-hop question is defeated by a view: an
 * assertion body reading `v` where `create view v as select * from t` names `t`
 * nowhere, so `drop table t` is accepted and every later write to the whole
 * database fails on an assertion whose text does not mention `t`. Reach is the
 * closure over STORED bodies — an assertion body names views and materialized
 * views, whose bodies name further views and base tables — and this module is
 * the one place that closure is computed, so the guard families that consume it
 * cannot end up disagreeing about what "reaches" means.
 *
 * Each body is walked under ITS OWN home-schema resolver, so an unqualified
 * name in a view body means what the planner would make of it *in that body*,
 * not what it would mean in the root body. That is the whole reason
 * {@link ObjectRefResolvers} is a per-home-schema factory over one snapshot.
 *
 * Scope-awareness survives the widening because the walk is
 * {@link collectTableRefsInAst}, the third sink over the very traversal the
 * rename uses: a body whose `with t as (…)` merely shadows the name still
 * contributes no reference, so the closure cannot false-refuse where the direct
 * probe already does not.
 */

/**
 * One stored body the closure walked, and how the root got to it.
 *
 * The root body itself is a `ReachedBody` with an empty {@link path} and no
 * {@link ownerKey} — it is an assertion's CHECK, or a table's CHECK / DEFAULT /
 * generated expression, none of which is a catalog object with a key of its own.
 */
export interface ReachedBody {
	/**
	 * Canonical `<schema>.<name>` key of the view / materialized view owning this
	 * body, or `undefined` for the ROOT body the closure started from.
	 */
	ownerKey: string | undefined;
	/**
	 * The stored bodies traversed from the root to this one INCLUSIVE, root-first,
	 * each described for an error message: `view 'v'`, `materialized view 'm'`.
	 * Empty for the root body itself, which is what tells a caller its match is
	 * direct and needs no "reaches it through …" clause.
	 */
	path: ReadonlyArray<string>;
	/** The AST to walk — an assertion/CHECK expression at the root, a view body below it. */
	body: AST.AstNode;
	/** Planner-parity resolver for THIS body's home schema. */
	resolve: ResolveObjectRef;
}

/** What {@link reachableObjects} returns: the walked bodies, and who named what. */
export interface ObjectReach {
	/**
	 * The root body followed by every stored body reached from it, breadth-first.
	 * A caller asking a question the closure does not answer itself — "does any
	 * body in the reach name `t.x`?" — probes these in order.
	 */
	readonly bodies: ReadonlyArray<ReachedBody>;
	/**
	 * The body that NAMES `key`, or `undefined` when nothing in the reach does.
	 * Breadth-first, so the answer is the shortest chain from the root and its
	 * {@link ReachedBody.path} is the shortest path to quote in an error.
	 *
	 * NOTE: two chains of EQUAL length to the same object tie on queue order,
	 * i.e. the order the parent bodies happened to name their children. Harmless
	 * while the path is advisory — either chain is a true one, and dropping the
	 * rule is the escape hatch for both — but a caller that ever needs a
	 * deterministic chain (a stable error-message fixture, say) has to order the
	 * candidates itself.
	 */
	namerOf(key: string): ReachedBody | undefined;
}

/**
 * Every object reachable from `root` through stored view / materialized-view
 * bodies, plus the bodies traversed to get there.
 *
 * `homeSchemaName` is the root body's OWN schema — the assertion's schema, or
 * the schema of the table carrying the CHECK / DEFAULT — because that is what
 * the root's unqualified names resolve against.
 *
 * `resolvers` is REQUIRED rather than built here, and the reason is snapshot
 * discipline (see {@link import('./object-ref-resolver.js').snapshotObjectRefResolvers}):
 * a caller looping over many roots must share ONE pre-mutation snapshot, and a
 * default would silently give each root its own.
 *
 * Termination is a visited set of object keys, so a mutually-referencing or
 * otherwise malformed catalog is walked once per object rather than forever. A
 * body naming an object that does not exist is not an error: the resolver's
 * miss→home fallback keys it stably and the expansion below simply finds
 * nothing to expand.
 *
 * `rootOpts` applies to the ROOT body's collection ONLY, never to a body
 * reached below it. Every reached body is a view / materialized-view body — a
 * relation, with no written-row context — so
 * {@link import('./rename/table-rename.js').TableRenameOpts.rowImageContext}
 * would be wrong there. It is REQUIRED at a root that is a table's CHECK
 * constraint or column DEFAULT / generated body, where a bare `new.a` names the
 * row image: rooted there without the flag, a table literally called `new`
 * would land in the reach and false-refuse its own drop
 * (`schema/expression-dependents.ts` passes it for exactly that reason). The
 * assertion guards pass nothing: an assertion CHECK owns no `new.` / `old.`
 * namespace either.
 */
export function reachableObjects(
	db: Database,
	root: AST.AstNode,
	homeSchemaName: string,
	resolvers: ObjectRefResolvers,
	rootOpts?: TableRenameOpts,
): ObjectReach {
	const bodies: ReachedBody[] = [];
	const namer = new Map<string, ReachedBody>();
	/** Object keys already expanded (or found not to be a stored body). */
	const visited = new Set<string>();

	const queue: ReachedBody[] = [{
		ownerKey: undefined,
		path: [],
		body: root,
		resolve: resolvers.forHomeSchema(homeSchemaName),
	}];

	// Breadth-first: `namer` and `path` then carry the SHORTEST chain to each
	// object, which is the one an error message should quote.
	for (let head = 0; head < queue.length; head++) {
		const current = queue[head];
		bodies.push(current);
		// `ownerKey === undefined` identifies the ROOT uniquely — every body reached
		// below it gets one from `childBody`.
		const opts = current.ownerKey === undefined ? rootOpts : undefined;
		for (const [key, nameLower] of collectTableRefsInAst(current.body, current.resolve, opts)) {
			if (!namer.has(key)) namer.set(key, current);
			if (visited.has(key)) continue;
			visited.add(key);
			const child = expandStoredBody(db, key, nameLower, resolvers, current);
			if (child) queue.push(child);
		}
	}

	return { bodies, namerOf: key => namer.get(key) };
}

/**
 * The stored body of the object `key` names, as a child of `parent` — or
 * `undefined` when the key names something with no body to follow: a base table,
 * or nothing at all.
 *
 * A materialized view is looked up as a TABLE (one `TableSchema`, one catalog
 * name) and its body hangs off `derivation.selectAst`; see `schema/derivation.ts`.
 */
function expandStoredBody(
	db: Database,
	key: string,
	nameLower: string,
	resolvers: ObjectRefResolvers,
	parent: ReachedBody,
): ReachedBody | undefined {
	const schema = db.schemaManager.getSchema(objectRefKeySchema(key, nameLower));
	if (!schema) return undefined;

	const view = schema.getView(nameLower);
	if (view) return childBody(key, `view '${view.name}'`, view.selectAst, view.schemaName, resolvers, parent);

	const table = schema.getTable(nameLower);
	if (isMaintainedTable(table)) {
		return childBody(key, `materialized view '${table.name}'`, table.derivation.selectAst,
			table.schemaName, resolvers, parent);
	}
	return undefined;
}

/** A reached stored body, with the parent's path extended by its own description. */
function childBody(
	ownerKey: string,
	describe: string,
	body: AST.QueryExpr,
	ownerSchemaName: string,
	resolvers: ObjectRefResolvers,
	parent: ReachedBody,
): ReachedBody {
	return {
		ownerKey,
		path: [...parent.path, describe],
		body,
		resolve: resolvers.forHomeSchema(ownerSchemaName),
	};
}

/**
 * The `reaches it through view 'v2' -> view 'v1'` clause for a
 * {@link ReachedBody.path}, or the empty string when the match is direct.
 * Shared so every guard consuming the closure phrases an indirect refusal the
 * same way — a user told to fix a rule whose body does not mention the dropped
 * object needs the chain, or the message is unactionable.
 */
export function describeReachPath(path: ReadonlyArray<string>): string {
	return path.length === 0 ? '' : ` through ${path.join(' -> ')}`;
}
