import type { Database } from '../core/database.js';
import { objectRefKey, type ResolveObjectRef } from './rename-rewriter.js';

/**
 * Per-home-schema {@link ResolveObjectRef} factory over ONE catalog snapshot.
 * The rename propagation walks dependents living in many schemas, and each
 * dependent's unqualified names resolve under ITS OWN home schema path — so
 * one statement needs one snapshot and many resolvers derived from it.
 */
export interface ObjectRefResolvers {
	/** Resolver for a stored body owned by `homeSchemaName`. Cached per home schema. */
	forHomeSchema(homeSchemaName: string): ResolveObjectRef;
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
