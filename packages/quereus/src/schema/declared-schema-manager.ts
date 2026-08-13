import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { LensDeploymentSnapshot } from './lens.js';
import type { LensDeployReport } from './lens-prover.js';
import { renderDeclaredSchemaCanonical } from './schema-hasher.js';

const log = createLogger('schema:declared');

/** A rotated pair of lens deployment snapshots for one logical schema. */
export interface LensSnapshotPair {
	/** The deploy before `current` — the backfill differ's "prior basis". */
	previous?: LensDeploymentSnapshot;
	/** The most recent deploy. */
	current?: LensDeploymentSnapshot;
}

/**
 * What both sides of the declarative reconciliation rendered to at the end of
 * the last successful `apply schema` whose migration plan came out **empty** —
 * i.e. the last apply at which this process observed, via a real diff, that the
 * catalog matches the declaration.
 *
 * On the next apply, both sides are re-rendered; if all three fields still
 * match, `computeSchemaDiff` / `generateMigrationPlan` are skipped. See
 * `docs/schema.md` § Applied-state snapshot.
 *
 * NOTE: the two renderings are retained per schema for as long as the declaration
 * lives — measured at 309 KB + 109 KB for the 112.7 KB / 54-table declaration of
 * `bench/apply-schema-unchanged.mjs`, i.e. roughly 4× the declaration's own DDL
 * text. Storing them (rather than hashing) is what makes the comparison exact.
 * If a host ever declares many large schemas and this shows up in a heap profile,
 * the trade to revisit is hashing the catalog rendering instead — FNV-1a over
 * 119 KB measured 1.46 ms, three times the string compare it would replace, plus
 * a small collision risk.
 */
export interface AppliedSchemaSnapshot {
	/** `renderDeclaredSchemaCanonical` of the declaration that was applied. */
	declaredRendering: string;
	/** `renderCatalogForComparison` of the live catalog after the apply completed. */
	catalogRendering: string;
	/** The effective `default_collation` — a differ input outside both renderings. */
	defaultCollation: string;
}

/**
 * Manages declared schemas and their associated seed data
 */
export class DeclaredSchemaManager {
	private declaredSchemas: Map<string, AST.DeclareSchemaStmt> = new Map();
	private seedData: Map<string, Map<string, SqlValue[][]>> = new Map(); // schemaName -> tableName -> rows
	/** Lens blocks keyed by *logical* schema name (the `for X` of `declare lens for X over Y`). */
	private lensDeclarations: Map<string, AST.DeclareLensStmt> = new Map();
	/**
	 * Rotated lens deployment snapshots keyed by *logical* schema name. Each
	 * `apply schema X` rotates (`previous = current; current = fresh`), so the
	 * prior deploy survives one re-apply — the source of truth the
	 * `quereus_basis_backfill` differ diffs (see `docs/lens.md`
	 * § The deployed basis representation).
	 */
	private deployedLensSnapshots: Map<string, LensSnapshotPair> = new Map();
	/**
	 * Latest lens deploy report (prover warnings + per-constraint obligations)
	 * keyed by *logical* schema name. Captured on each successful `apply schema X`.
	 * This is the **stable hook** the sibling acknowledgment ticket
	 * (`lens-advisory-acknowledgment`) reads to fingerprint / tally / expand the
	 * advisories. Errors never reach here — they throw atomically during deploy.
	 */
	private deployedLensReports: Map<string, LensDeployReport> = new Map();
	/**
	 * Memoized `renderDeclaredSchemaCanonical` per lowercased schema name. Paid
	 * once per `declare schema`, on the first apply after it — the apply that is
	 * going to do real work anyway.
	 */
	private declaredRenderings: Map<string, string> = new Map();
	/** Applied-state snapshots per lowercased schema name; see {@link AppliedSchemaSnapshot}. */
	private appliedSnapshots: Map<string, AppliedSchemaSnapshot> = new Map();

	/**
	 * Stores a declared schema
	 */
	setDeclaredSchema(schemaName: string, declaration: AST.DeclareSchemaStmt): void {
		this.declaredSchemas.set(schemaName.toLowerCase(), declaration);
		// Invalidate the memoized rendering — it describes the PREVIOUS declaration.
		//
		// The applied snapshot deliberately SURVIVES a re-declare. It records what
		// both sides rendered to, and the next apply re-renders the new declaration
		// and compares; a re-`declare schema` of byte-identical text therefore still
		// takes the fast path, while any real edit fails the compare. Clearing it
		// here would throw that away for no soundness gain.
		this.declaredRenderings.delete(schemaName.toLowerCase());
		log('Stored declared schema for: %s', schemaName);
	}

	/**
	 * Canonical, **tags-inclusive** rendering of the stored declaration for
	 * `schemaName` (memoized), or `undefined` when nothing is declared. This is
	 * the declared half of the applied-state snapshot compare — NOT the version
	 * hash, which strips tags (see {@link renderDeclaredSchemaCanonical}).
	 */
	getDeclaredRendering(schemaName: string): string | undefined {
		const key = schemaName.toLowerCase();
		const cached = this.declaredRenderings.get(key);
		if (cached !== undefined) return cached;
		const declaration = this.declaredSchemas.get(key);
		if (!declaration) return undefined;
		const rendering = renderDeclaredSchemaCanonical(declaration);
		this.declaredRenderings.set(key, rendering);
		return rendering;
	}

	/** The applied-state snapshot for `schemaName`, or `undefined` if none recorded. */
	getAppliedSnapshot(schemaName: string): AppliedSchemaSnapshot | undefined {
		return this.appliedSnapshots.get(schemaName.toLowerCase());
	}

	/**
	 * Records the applied-state snapshot for `schemaName`. Callers must only do
	 * this after an apply that both succeeded and produced an empty migration
	 * plan — see the write site in `runtime/emit/schema-declarative.ts`.
	 */
	setAppliedSnapshot(schemaName: string, snapshot: AppliedSchemaSnapshot): void {
		this.appliedSnapshots.set(schemaName.toLowerCase(), snapshot);
		log('Recorded applied-state snapshot for: %s', schemaName);
	}

	/**
	 * Retrieves a declared schema
	 */
	getDeclaredSchema(schemaName: string): AST.DeclareSchemaStmt | undefined {
		return this.declaredSchemas.get(schemaName.toLowerCase());
	}

	/**
	 * Checks if a schema has been declared
	 */
	hasDeclaredSchema(schemaName: string): boolean {
		return this.declaredSchemas.has(schemaName.toLowerCase());
	}

	/**
	 * Stores seed data for a table in a schema
	 */
	setSeedData(schemaName: string, tableName: string, rows: SqlValue[][]): void {
		const lowerSchema = schemaName.toLowerCase();
		if (!this.seedData.has(lowerSchema)) {
			this.seedData.set(lowerSchema, new Map());
		}
		const schemaSeedData = this.seedData.get(lowerSchema)!;
		schemaSeedData.set(tableName.toLowerCase(), rows);
		log('Stored seed data for %s.%s (%d rows)', schemaName, tableName, rows.length);
	}

	/**
	 * Retrieves seed data for a table
	 */
	getSeedData(schemaName: string, tableName: string): SqlValue[][] | undefined {
		const schemaSeedData = this.seedData.get(schemaName.toLowerCase());
		if (!schemaSeedData) return undefined;
		return schemaSeedData.get(tableName.toLowerCase());
	}

	/**
	 * Gets all seed data for a schema
	 */
	getAllSeedData(schemaName: string): Map<string, SqlValue[][]> {
		return this.seedData.get(schemaName.toLowerCase()) || new Map();
	}

	/**
	 * Clears all seed data for a schema
	 */
	clearSeedData(schemaName: string): void {
		this.seedData.delete(schemaName.toLowerCase());
		log('Cleared seed data for: %s', schemaName);
	}

	/**
	 * Removes a declared schema and its seed data
	 */
	removeDeclaredSchema(schemaName: string): void {
		this.declaredSchemas.delete(schemaName.toLowerCase());
		this.seedData.delete(schemaName.toLowerCase());
		// Both derived caches go with the declaration: with nothing declared there is
		// nothing for a later apply to compare a surviving snapshot against.
		this.declaredRenderings.delete(schemaName.toLowerCase());
		this.appliedSnapshots.delete(schemaName.toLowerCase());
		this.lensDeclarations.delete(schemaName.toLowerCase());
		this.deployedLensSnapshots.delete(schemaName.toLowerCase());
		this.deployedLensReports.delete(schemaName.toLowerCase());
		log('Removed declared schema: %s', schemaName);
	}

	/**
	 * Stores (replacing any prior) the lens block for a logical schema. Keyed by
	 * the logical schema name (`for X`); re-declaring a lens for X overwrites,
	 * matching `declare schema`'s overwrite-on-redeclare. See docs/lens.md § D1.
	 */
	setLensDeclaration(logicalSchemaName: string, declaration: AST.DeclareLensStmt): void {
		this.lensDeclarations.set(logicalSchemaName.toLowerCase(), declaration);
		log('Stored lens declaration for: %s', logicalSchemaName);
	}

	/** Retrieves the lens block declared for a logical schema, if any. */
	getLensDeclaration(logicalSchemaName: string): AST.DeclareLensStmt | undefined {
		return this.lensDeclarations.get(logicalSchemaName.toLowerCase());
	}

	/**
	 * Rotates a freshly-built lens deployment snapshot in: the prior `current`
	 * becomes `previous`, dropping the snapshot from two deploys ago. A first
	 * deploy leaves `previous` undefined (⇒ no backfill rows).
	 */
	rotateDeployedLensSnapshot(logicalSchemaName: string, snapshot: LensDeploymentSnapshot): void {
		const key = logicalSchemaName.toLowerCase();
		const previous = this.deployedLensSnapshots.get(key)?.current;
		this.deployedLensSnapshots.set(key, { previous, current: snapshot });
		log('Rotated lens deployment snapshot for: %s', logicalSchemaName);
	}

	/** Retrieves the rotated `{ previous, current }` snapshot pair for a logical schema, if any. */
	getDeployedLensSnapshots(logicalSchemaName: string): LensSnapshotPair | undefined {
		return this.deployedLensSnapshots.get(logicalSchemaName.toLowerCase());
	}

	/**
	 * Stores (replacing any prior) the lens deploy report for a logical schema,
	 * captured on each successful `apply schema X`. The stable hook the sibling
	 * acknowledgment ticket consumes (see {@link deployedLensReports}).
	 */
	setDeployedLensReport(logicalSchemaName: string, report: LensDeployReport): void {
		this.deployedLensReports.set(logicalSchemaName.toLowerCase(), report);
	}

	/** Retrieves the latest lens deploy report for a logical schema, if any. */
	getDeployedLensReport(logicalSchemaName: string): LensDeployReport | undefined {
		return this.deployedLensReports.get(logicalSchemaName.toLowerCase());
	}
}

