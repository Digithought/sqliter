/**
 * Per-table pk-identity keying resolution.
 *
 * The sync layer files every per-row record (`cv:`/`tb:`/`cl:`) under the row's
 * IDENTITY — the same "same row?" answer the rest of the engine gives: each pk
 * column normalized under its KEY COLLATION ('apple' ≡ 'APPLE' under nocase) and
 * its logical type's semantic key transform ('PT1H' ≡ 'PT60M' for TIMESPAN).
 * This module resolves that keying from a table's schema, mirroring
 * `makePkKeySerializer` in `@quereus/isolation` (the overlay's row-alignment
 * key) so the two layers can never disagree on row identity.
 *
 * Identity is derived and lossy; the row's ADDRESS (a real, type-valid
 * `SqlValue[]` — any spelling from the equivalence class) lives in the record
 * value and on the wire. See docs/sync.md § Row identity vs. address.
 */

import {
	pkKeyCollationName,
	semanticKeyTransform,
	type KeyNormalizerResolver,
	type SqlValue,
	type TableSchema,
} from '@quereus/quereus';
import { BUILTIN_KEY_NORMALIZER_RESOLVER } from '@quereus/store';
import { encodePkIdentity, RAW_PK_KEYING, type PkKeying } from './keys.js';

/**
 * Resolves the pk keying for a `(schema, table)`. Throws when the table's
 * schema is unavailable (see {@link createPkKeyingResolver} — a raw fallback
 * there would flip every already-filed identity the moment the schema appears).
 */
export type PkKeyingResolver = (schemaName: string, tableName: string) => PkKeying;

/**
 * Resolve a table's {@link PkKeying} from its schema:
 *  - normalizers: each pk column's key collation via {@link pkKeyCollationName}
 *    (its own declared collation for a textual column — the store reconciles an
 *    undecorated text pk to the table key collation at CREATE, so the registered
 *    schema always carries it; BINARY for text-capable-but-not-textual columns;
 *    identity for never-text columns via `resolver(undefined)`).
 *  - transforms: the engine's {@link semanticKeyTransform} (the logical type's
 *    `groupKey` — today TIMESPAN → total seconds). Deliberately the ENGINE
 *    transform, not the store's byte-order variant: identity strings need
 *    equality, not memcmp order, so JSON's canonical text is already faithful.
 */
export function resolvePkKeying(schema: TableSchema, resolver: KeyNormalizerResolver): PkKeying {
	// Defensive `?? []` / logicalType guard: a real TableSchema always carries
	// primaryKeyDefinition and typed columns, but test oracles stub minimal
	// schemas ({ columns: [{ name }] } only). A missing piece degrades that
	// position to the identity normalizer (raw value identity) — the same
	// treatment a keyless stub got before — instead of crashing.
	const pkDef = schema.primaryKeyDefinition ?? [];
	return {
		normalizers: pkDef.map(def => {
			const column = schema.columns[def.index];
			return resolver(column?.logicalType ? pkKeyCollationName(column) : undefined);
		}),
		transforms: pkDef.map(def => semanticKeyTransform(schema.columns[def.index]?.logicalType)),
	};
}

/**
 * Build the {@link PkKeyingResolver} a `SyncManagerImpl` threads through its
 * metadata stores.
 *
 * - **No schema oracle** (relay-only deployment, e.g. a coordinator): every
 *   table resolves to {@link RAW_PK_KEYING}. Raw identity is STABLE there — an
 *   oracle can never appear later in the manager's life, so the identity never
 *   flips — and bigint-safe, unlike the former `JSON.stringify` encoding.
 * - **Oracle wired, table unknown**: THROW. There is no sound identity for a
 *   schemaless table, and silently falling back to raw values would orphan
 *   everything already filed the moment the schema appears. (The apply path
 *   never reaches here for an out-of-basis table — those changes are diverted
 *   to quarantine, whose keys use the raw encoding, before any keying lookup.)
 * - **Oracle wired, table known**: resolve via {@link resolvePkKeying}, cached
 *   per `TableSchema` OBJECT — replicated/local DDL registers a fresh frozen
 *   schema object, so the WeakMap invalidates on any schema change for free.
 */
export function createPkKeyingResolver(
	getTableSchema: ((schemaName: string, tableName: string) => TableSchema | undefined) | undefined,
	keyNormalizerResolver: KeyNormalizerResolver | undefined,
): PkKeyingResolver {
	if (!getTableSchema) {
		return () => RAW_PK_KEYING;
	}
	// Built-ins-only fallback (BINARY/NOCASE/RTRIM; throws on any other name) for
	// hosts that wired a schema oracle but no normalizer resolver — fails loud on
	// a custom collation rather than mis-keying it.
	const resolver = keyNormalizerResolver ?? BUILTIN_KEY_NORMALIZER_RESOLVER;
	const cache = new WeakMap<TableSchema, PkKeying>();
	return (schemaName, tableName) => {
		const schema = getTableSchema(schemaName, tableName);
		if (!schema) {
			throw new Error(
				`No table schema for ${schemaName}.${tableName} — sync pk identity is unresolvable `
					+ `(out-of-basis changes are quarantined, never keyed; see metadata/pk-identity.ts)`,
			);
		}
		let keying = cache.get(schema);
		if (!keying) {
			keying = resolvePkKeying(schema, resolver);
			cache.set(schema, keying);
		}
		return keying;
	};
}

/**
 * Closure form for one known schema — used where a caller already holds the
 * `TableSchema` (the store adapter's per-table row grouping).
 */
export function makePkIdentityEncoder(
	schema: TableSchema,
	resolver: KeyNormalizerResolver,
): (pk: SqlValue[]) => string {
	const keying = resolvePkKeying(schema, resolver);
	return pk => encodePkIdentity(pk, keying);
}
