import type { Database } from '../core/database.js';
import { objectRefKey, type ResolveObjectRef, type TableRenameTarget } from './rename-rewriter.js';

/**
 * Per-home-schema {@link ResolveObjectRef} factory over ONE catalog snapshot.
 * The rename propagation walks dependents living in many schemas, and each
 * dependent's unqualified names resolve under ITS OWN home schema path — so
 * one statement needs one snapshot and many resolvers derived from it.
 */
export interface ObjectRefResolvers {
	/** Resolver for a stored body owned by `homeSchemaName`. Cached per home schema. */
	forHomeSchema(homeSchemaName: string): ResolveObjectRef;
	/**
	 * A sibling snapshot with one table rename applied — the catalog as it will
	 * look AFTER the statement. Used only to check the rename post-condition
	 * ({@link import('./rename/table-rename.js').renameTableInAst}: a rewritten
	 * reference must still resolve to the renamed object). Derived from this
	 * snapshot's name sets, never the live catalog, so the SNAPSHOT DISCIPLINE
	 * below holds for both.
	 */
	withTableRenamed(schemaName: string, oldName: string, newName: string): ObjectRefResolvers;
}

/**
 * The catalog-backed {@link ResolveObjectRef} the rename walkers consult to decide
 * whether a table/view reference written in a stored body denotes the object being
 * renamed / probed. It answers the way the PLANNER answers for that body — against
 * the owning object's home schema path ({@link Database._homeSchemaPath}:
 * `[homeSchema, ...session default path]`) — not against a single "default schema".
 *
 * Resolution rules:
 * - **Qualified** (`schema` present) → `objectRefKey(schema, name)`, no catalog
 *   lookup. A qualified name means what it says even when the object does not
 *   exist (it may be the one about to be created, or the one just renamed away).
 * - **Unqualified** → the first schema in the home path holding a table or view
 *   (a materialized view is a table) of that name.
 * - **Miss in every schema** → the home schema's key, so a body naming an object
 *   that does not exist still gets a stable key rather than `undefined` —
 *   `undefined` is reserved for "no resolver could be consulted at all".
 *
 * NOTE: "the way the planner answers" is exact for the body kinds that plan under
 * {@link Database._homeSchemaPath} — view bodies, materialized-view bodies, and
 * assertion checks (`planner/stored-body-context.ts`). A CHECK constraint or a
 * column DEFAULT / generated expression is stricter still: it plans under
 * `schemaAuthoredContext` (`planner/building/schema-authored-context.ts`), the
 * owning schema and NOTHING else, so an unqualified name the owning schema does
 * not hold is an error there rather than a fallthrough down the session path.
 * This resolver applies the looser home-path rule to all of them, which is
 * deliberately safe rather than exact: the two rules can only disagree when the
 * home schema lacks the name, and such a CHECK / DEFAULT cannot be evaluated at
 * all — so no VALID body is ever matched (or missed) differently. Tighten to a
 * per-body-kind path only if a rename ever needs to be right about a body the
 * planner itself rejects.
 *
 * SNAPSHOT DISCIPLINE — the single most likely way to get this wrong: build the
 * snapshot (`snapshotObjectRefResolvers` / `buildObjectRefResolver`) BEFORE the
 * statement's first catalog mutation, and pass the same instance through the whole
 * statement. Name-set lookups answer from the snapshot, NOT the live catalog, and
 * that is load-bearing: rename propagation runs after the catalog swap, when the
 * old name is gone — a live lookup of a bare `t` under `[main, temp]` after
 * `main.t` was renamed would fall through to `temp.t` and silently match (or miss)
 * the wrong object. The pre-mutation snapshot resolves every reference the way the
 * body planned before the statement started, which is the question the rename is
 * asking. (The session `schema_path` option is read at resolver-derivation time;
 * it cannot change mid-statement.)
 */
export function snapshotObjectRefResolvers(db: Database): ObjectRefResolvers {
	// NOTE: snapshots every schema's table+view name set on each DDL statement, and
	// resolves per reference after that; both are Map/Set work over handfuls of
	// names. If a schema-heavy workload ever shows this hot, snapshot lazily per
	// schema actually consulted.
	const bySchema = new Map<string, Set<string>>();
	for (const schema of db.schemaManager._getAllSchemas()) {
		const names = new Set<string>();
		for (const table of schema.getAllTables()) names.add(table.name.toLowerCase());
		for (const view of schema.getAllViews()) names.add(view.name.toLowerCase());
		bySchema.set(schema.name.toLowerCase(), names);
	}
	return buildResolvers(db, bySchema);
}

/** The shared builder over `(db, bySchema)`, so a {@link ObjectRefResolvers.withTableRenamed}
 *  sibling reuses the base snapshot's resolution logic over its own name-set map. */
function buildResolvers(db: Database, bySchema: ReadonlyMap<string, ReadonlySet<string>>): ObjectRefResolvers {
	const cache = new Map<string, ResolveObjectRef>();
	return {
		forHomeSchema(homeSchemaName: string): ResolveObjectRef {
			const homeLower = homeSchemaName.toLowerCase();
			const cached = cache.get(homeLower);
			if (cached) return cached;
			const path = db._homeSchemaPath(homeSchemaName).map(s => s.toLowerCase());
			const resolve: ResolveObjectRef = (schema, name) => {
				if (schema !== undefined) return objectRefKey(schema, name);
				const nameLower = name.toLowerCase();
				for (const schemaLower of path) {
					if (bySchema.get(schemaLower)?.has(nameLower)) return `${schemaLower}.${nameLower}`;
				}
				return `${homeLower}.${nameLower}`;
			};
			cache.set(homeLower, resolve);
			return resolve;
		},
		withTableRenamed(schemaName: string, oldName: string, newName: string): ObjectRefResolvers {
			// Copy the affected schema's Set and the outer Map shallowly — the base
			// snapshot must keep answering pre-rename.
			const schemaLower = schemaName.toLowerCase();
			const sibling = new Map(bySchema);
			const names = new Set(bySchema.get(schemaLower) ?? []);
			names.delete(oldName.toLowerCase());
			names.add(newName.toLowerCase());
			sibling.set(schemaLower, names);
			return buildResolvers(db, sibling);
		},
	};
}

/**
 * Per-home-schema {@link TableRenameTarget} factory for one `ALTER TABLE … RENAME TO`
 * statement: binds the renamed object's identity to a pre-mutation `resolve` and a
 * post-rename `resolveAfter` (the {@link ObjectRefResolvers.withTableRenamed} sibling),
 * both derived per body-owning home schema. One statement builds this once and hands
 * every walk the target for the walked body's owner, which is what lets the rewrite
 * enforce its post-condition — a rewritten reference must still resolve to the renamed
 * object — at the sink.
 */
export function tableRenameTargetsFor(
	resolvers: ObjectRefResolvers,
	schemaName: string,
	oldName: string,
	newName: string,
): (homeSchemaName: string) => TableRenameTarget {
	const after = resolvers.withTableRenamed(schemaName, oldName, newName);
	const cache = new Map<string, TableRenameTarget>();
	return homeSchemaName => {
		const homeLower = homeSchemaName.toLowerCase();
		const cached = cache.get(homeLower);
		if (cached) return cached;
		const target: TableRenameTarget = {
			oldName,
			newName,
			schemaName,
			resolve: resolvers.forHomeSchema(homeSchemaName),
			resolveAfter: after.forHomeSchema(homeSchemaName),
		};
		cache.set(homeLower, target);
		return target;
	};
}

/**
 * Single-home convenience over {@link snapshotObjectRefResolvers}, for callers
 * that walk bodies of one owning schema only (the DROP guards, a store module's
 * own-table rewrite). Same snapshot discipline: build before the statement's
 * first catalog mutation.
 */
export function buildObjectRefResolver(db: Database, homeSchemaName: string): ResolveObjectRef {
	return snapshotObjectRefResolvers(db).forHomeSchema(homeSchemaName);
}
