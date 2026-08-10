/**
 * Conformance lock for the memory module's `checkUniqueViaIndex` per-column
 * UNIQUE-enforcement collation resolution (ticket
 * `unify-unique-enforcement-collation-resolver`, the "fourth copy").
 *
 * The shared {@link uniqueEnforcementCollations} helper resolves the enforcement
 * collation per constrained column from `(schema, uc)`, looking the index up BY
 * NAME via `uc.derivedFromIndex`. store/isolation import that helper directly, so
 * their copies cannot drift. Memory's `checkUniqueViaIndex` cannot share the
 * import: it reads the collation from the *live* `MemoryIndex` handle that
 * `findIndexForConstraint` returns —
 * `index.specColumns[i]?.collation ?? schema.columns[col].collation`. That
 * resolver now mirrors the helper: an index-derived UC resolves BY NAME via
 * `uc.derivedFromIndex`, with the column-set scan kept only as the non-derived
 * fallback. The two paths therefore agree per column even when two UNIQUE indexes
 * cover the SAME column-set with different collations — each UC resolves to its
 * OWN index, so neither under-enforces a coarser-declared UNIQUE
 * (`memory-multi-index-unique-collation-resolution`). A drift would re-open the
 * covering-MV subset-miss (or over-reject).
 *
 * This suite drives the shapes — single-index AND multi-index-same-column-set,
 * in BOTH index creation orders — through BOTH paths and asserts equal per-column
 * output. A drift here is a genuine finding (the two index-resolution paths
 * disagree on a shape that should agree), NOT a reason to widen the helper's
 * signature.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { uniqueEnforcementCollations } from '../src/schema/unique-enforcement.js';
import { normalizeCollationName } from '../src/util/comparison.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../src/vtab/memory/layer/manager.js';
import type { MemoryIndex } from '../src/vtab/memory/index.js';
import type { TableSchema, UniqueConstraintSchema } from '../src/schema/table.js';

/**
 * Reaches the {@link MemoryTableManager} backing a memory table — the engine no
 * longer addresses it directly (it routes through the backing-host capability),
 * so the test resolves it from the module's table map (cf.
 * `maintenance-replace-all.spec.ts`).
 */
function getBackingManager(schema: TableSchema): MemoryTableManager {
	expect(schema.vtabModule, `'${schema.name}' module`).to.be.instanceOf(MemoryTableModule);
	const manager = (schema.vtabModule as MemoryTableModule).tables
		.get(`${schema.schemaName}.${schema.name}`.toLowerCase());
	expect(manager, `memory manager for '${schema.name}'`).to.not.be.undefined;
	return manager!;
}

/**
 * The live `MemoryIndex` enforcing `uc`, resolved EXACTLY as
 * `MemoryTableManager.findIndexForConstraint` does for the non-MV path. The
 * constraint's OWN realizing structure is resolved BY NAME:
 *   - index-derived UC → `uc.derivedFromIndex`;
 *   - non-derived UC → its `_uc_*` covering index via `getImplicitCoveringStructure`.
 * Either falls back to the first secondary index whose column SET matches
 * `uc.columns` positionally only when the name does not resolve (defensive).
 * Fetched from the committed layer — the source `checkUniqueViaIndex` reads.
 */
function resolveLiveIndex(
	manager: MemoryTableManager,
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): MemoryIndex | undefined {
	if (uc.derivedFromIndex) {
		const byName = manager.currentCommittedLayer.getSecondaryIndex?.(uc.derivedFromIndex);
		if (byName) return byName;
	} else {
		const own = manager.getImplicitCoveringStructure(uc);
		if (own) {
			const byName = manager.currentCommittedLayer.getSecondaryIndex?.(own.indexName);
			if (byName) return byName;
		}
	}
	const idx = schema.indexes?.find(ix =>
		ix.columns.length === uc.columns.length &&
		ix.columns.every((col, i) => col.index === uc.columns[i]),
	);
	if (!idx) return undefined;
	return manager.currentCommittedLayer.getSecondaryIndex?.(idx.name);
}

/**
 * The `checkUniqueViaIndex` per-column collation expression evaluated against the
 * live index handle: `index.specColumns[i]?.collation ?? schema.columns[col].collation`.
 */
function viaLiveIndexCollations(
	index: MemoryIndex,
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): (string | undefined)[] {
	return uc.columns.map((col, i) => index.specColumns[i]?.collation ?? schema.columns[col].collation);
}

/** Compare collations the way the runtime does — an absent name behaves as BINARY,
 *  and SQLite treats collation names case-insensitively. */
const norm = (c: string | undefined): string => normalizeCollationName(c ?? 'BINARY');

interface Shape {
	name: string;
	ddl: string[];
	/** The base table whose UNIQUE constraint is under test. */
	table: string;
	/** Expected normalized per-column enforcement collation for `uniqueConstraints[0]`
	 *  (single-UC shapes — sanity floor that the shapes actually exercise the
	 *  distinctions they claim to). */
	expected?: string[];
	/** For multi-UC shapes — several UNIQUE structures over the SAME column-set, where
	 *  `uniqueConstraints[0]` no longer uniquely identifies the constraint under
	 *  test. Each entry picks a UC and asserts that UC's OWN per-column collation,
	 *  proving each resolves to its own index (not the first-listed one) regardless
	 *  of creation order. `index` is the derived UC's `derivedFromIndex` name, or
	 *  `null` to select the single NON-derived UC (table-level / column UNIQUE). */
	byIndex?: { index: string | null; expected: string[] }[];
}

const SHAPES: Shape[] = [
	{
		// Finer index than the column: BINARY index over a NOCASE column.
		name: 'finer (BINARY index / NOCASE column)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b collate binary)',
		],
		table: 't',
		expected: ['BINARY'],
	},
	{
		// Coarser index than the column: NOCASE index over a BINARY column.
		name: 'coarser (NOCASE index / BINARY column)',
		ddl: [
			'create table t (id integer primary key, b text collate binary)',
			'create unique index ix on t (b collate nocase)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		name: 'equal (NOCASE index / NOCASE column)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b collate nocase)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// No explicit index COLLATE — both paths fall back to the declared collation.
		name: 'plain (no index COLLATE)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix on t (b)',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// Composite: column 0 carries an explicit (finer) index COLLATE, column 1
		// has none and falls back to its declared collation — exercises index 1.
		name: 'composite (one finer, one plain)',
		ddl: [
			'create table t (id integer primary key, a text collate nocase, b text collate nocase)',
			'create unique index ix on t (a collate binary, b)',
		],
		table: 't',
		expected: ['BINARY', 'NOCASE'],
	},
	{
		// Non-derived, table-level UNIQUE: `derivedFromIndex` unset ⇒ the helper
		// falls back to declared per column; the auto-built `_uc_*` covering index
		// carries the declared collation, so the live path agrees.
		name: 'non-derived (table-level UNIQUE)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase, unique (b))',
		],
		table: 't',
		expected: ['NOCASE'],
	},
	{
		// Non-derived composite, for good measure: two declared collations, no index.
		name: 'non-derived composite (table-level UNIQUE)',
		ddl: [
			'create table t (id integer primary key, a text collate binary, b text collate nocase, unique (a, b))',
		],
		table: 't',
		expected: ['BINARY', 'NOCASE'],
	},
	{
		// Multi-index, SAME column-set, BINARY created FIRST. Two UNIQUE indexes over
		// `b` with differing collations: each derived UC must resolve to its OWN
		// index (by name), so the by-column-set first-match no longer steals the
		// coarser UC's collation. This is the shape the fix closes.
		name: 'multi-index same column-set (BINARY first)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix_binary on t (b collate binary)',
			'create unique index ix_nocase on t (b collate nocase)',
		],
		table: 't',
		byIndex: [
			{ index: 'ix_binary', expected: ['BINARY'] },
			{ index: 'ix_nocase', expected: ['NOCASE'] },
		],
	},
	{
		// Same shape, NOCASE created FIRST — proves order-independence (on `main` the
		// by-column-set scan made the answer depend on `schema.indexes` order).
		name: 'multi-index same column-set (NOCASE first)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix_nocase on t (b collate nocase)',
			'create unique index ix_binary on t (b collate binary)',
		],
		table: 't',
		byIndex: [
			{ index: 'ix_binary', expected: ['BINARY'] },
			{ index: 'ix_nocase', expected: ['NOCASE'] },
		],
	},
	{
		// NON-derived UNIQUE coexisting with a FINER same-column-set index, INDEX
		// created FIRST (the order-sensitive under-enforcement repro). The realization
		// guard refuses to reuse the BINARY `ix_binary` for the NOCASE-declared
		// `unique (b)` — it builds a distinct NOCASE `_uc_*`, and findIndexForConstraint
		// resolves the non-derived UC to THAT structure by name (not the earlier-listed
		// finer index). The derived UC from `ix_binary` still enforces BINARY. On main
		// this shape under-enforced: the non-derived UC reused/resolved to ix_binary.
		name: 'non-derived + finer index, same column-set (index first)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase)',
			'create unique index ix_binary on t (b collate binary)',
			'alter table t add constraint uq unique (b)',
		],
		table: 't',
		byIndex: [
			{ index: 'ix_binary', expected: ['BINARY'] },
			{ index: null, expected: ['NOCASE'] },
		],
	},
	{
		// Same coexistence, CONSTRAINT created FIRST (table-level UNIQUE), THEN the finer
		// index — order-independence. The non-derived UC's `_uc_*` is built at table
		// construction; the later finer index is independent. Both UCs still resolve to
		// their own structures.
		name: 'non-derived + finer index, same column-set (constraint first)',
		ddl: [
			'create table t (id integer primary key, b text collate nocase, constraint uq unique (b))',
			'create unique index ix_binary on t (b collate binary)',
		],
		table: 't',
		byIndex: [
			{ index: 'ix_binary', expected: ['BINARY'] },
			{ index: null, expected: ['NOCASE'] },
		],
	},
];

describe('uniqueEnforcementCollations ⇔ memory checkUniqueViaIndex (#4 conformance lock)', () => {
	for (const shape of SHAPES) {
		it(`agree on: ${shape.name}`, async () => {
			const db = new Database();
			try {
				for (const stmt of shape.ddl) await db.exec(stmt);

				const schema = db.schemaManager.getTable('main', shape.table)!;
				expect(schema, `table '${shape.table}'`).to.not.be.undefined;
				const manager = getBackingManager(schema);

				// A single-UC shape checks `uniqueConstraints[0]`; a multi-UC shape
				// (two UNIQUE indexes over one column-set) picks each UC BY name so the
				// assertion is independent of the `uniqueConstraints` order.
				const checks = shape.byIndex
					? shape.byIndex.map(b => ({
						uc: b.index === null
							? schema.uniqueConstraints!.find(u => u.derivedFromIndex === undefined)!
							: schema.uniqueConstraints!.find(u => u.derivedFromIndex === b.index)!,
						expected: b.expected,
						label: b.index ?? 'non-derived',
					}))
					: [{ uc: schema.uniqueConstraints![0], expected: shape.expected!, label: 'uc[0]' }];

				for (const { uc, expected, label } of checks) {
					expect(uc, `UNIQUE constraint under test (${label})`).to.not.be.undefined;

					// The shared helper — resolves the index BY NAME (uc.derivedFromIndex).
					const helper = uniqueEnforcementCollations(schema, uc);

					// The memory #4 path — the live index findIndexForConstraint resolves.
					const index = resolveLiveIndex(manager, schema, uc);
					expect(index, `live enforcing MemoryIndex for the constraint (${label})`).to.not.be.undefined;
					const viaIndex = viaLiveIndexCollations(index!, schema, uc);

					expect(helper.length, `one collation per constrained column (${label})`).to.equal(uc.columns.length);
					expect(viaIndex.length, `live path matches arity (${label})`).to.equal(uc.columns.length);

					const helperNorm = helper.map(norm);
					const viaIndexNorm = viaIndex.map(norm);
					// The lock: the name-resolved helper and the live index findIndexForConstraint
					// resolves produce the same per-column enforcement collation.
					expect(helperNorm, `helper (by-name) vs live index must agree (${label})`)
						.to.deep.equal(viaIndexNorm);
					// Sanity floor: and they match the shape's intended distinction.
					expect(helperNorm, `shape exercises the intended collation (${label})`).to.deep.equal(expected);
				}
			} finally {
				await db.close();
			}
		});
	}
});
