import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { LensDeploymentSnapshot } from './lens.js';
import type { LensDeployReport } from './lens-prover.js';

const log = createLogger('schema:declared');

/** A rotated pair of lens deployment snapshots for one logical schema. */
export interface LensSnapshotPair {
	/** The deploy before `current` — the backfill differ's "prior basis". */
	previous?: LensDeploymentSnapshot;
	/** The most recent deploy. */
	current?: LensDeploymentSnapshot;
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
	 * Stores a declared schema
	 */
	setDeclaredSchema(schemaName: string, declaration: AST.DeclareSchemaStmt): void {
		this.declaredSchemas.set(schemaName.toLowerCase(), declaration);
		log('Stored declared schema for: %s', schemaName);
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

