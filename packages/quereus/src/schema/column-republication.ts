import type * as AST from '../parser/ast.js';
import type { Database } from '../core/database.js';
import { isMaintainedTable } from './derivation.js';
import type { ObjectRefResolvers } from './object-ref-resolver.js';
import {
	PROBE_COLUMN_NAME,
	bodyExposesRenamedColumn,
	bodyPublishesColumnNamed,
	objectRefKey,
	renameColumnInAst,
} from './rename-rewriter.js';
import type { ResolveColumnInSource } from './rename-rewriter.js';
import { spineCloneAst } from '../util/ast-spine-clone.js';

/**
 * Column REPUBLICATION: which views / materialized views expose a table's
 * column as one of their own output columns — a bare passthrough projection
 * (`select x from t`), or a `*` / `t.*` whose frame binds the table.
 *
 * Two verbs consume the same lineage, which is why it lives here in `schema/`
 * rather than inside either verb's emitter:
 *
 * - `ALTER TABLE … RENAME COLUMN` re-targets its propagation on every
 *   republisher, breadth-first, because rewriting a body shifts the name that
 *   body PUBLISHES and its readers then need the same rename with the view as
 *   the target ({@link scanShiftedPublishers}, driven by
 *   `runtime/emit/column-rename-cascade.ts`).
 * - `ALTER TABLE … DROP COLUMN` refuses when a live rule (CHECK / DEFAULT /
 *   generated body / assertion) reads the column, and a rule can read it
 *   THROUGH a republisher without any body in the chain spelling the column's
 *   name (`create view v as select * from t` + a rule reading `v.x`). The
 *   drop guards therefore probe each reached body against every republication
 *   target ({@link collectColumnRepublication}), not against the base table
 *   alone — restoring the invariant that the drop refuses exactly the
 *   references a rename would have rewritten.
 */

/** One round's rename target: the object whose published column shifts old → new. */
export interface ColumnRenameCascadeTarget {
	/** Canonical `<schema>.<name>` key of the target (see {@link objectRefKey}). */
	targetKey: string;
	/** The target's bare name — what unqualified references in dependent bodies spell. */
	tableName: string;
}

/** Visited-set key for one (target, column) pair of a cascade / fixpoint round. */
export const visitKeyOf = (target: ColumnRenameCascadeTarget, oldColLower: string): string =>
	`${target.targetKey}:${oldColLower}`;

export interface ShiftScanOpts {
	/**
	 * Probe a spine clone with the round's rewrite applied first — the read-only
	 * pre-flight, whose bodies have not been rewritten yet. The live driver's
	 * scan runs after the round's in-place rewrites and reads the live ASTs.
	 */
	probeOnClone: boolean;
	/** MVs whose published names cannot shift (pre-existing staleness — the
	 *  backing columns are not renamed for those). */
	isMvExcluded: (mv: { schemaName: string; name: string; derivation: { stale?: boolean } }) => boolean;
	/** Called once per dependent whose published names the target's rename shifts. */
	onShifted: (dependent: ColumnRenameCascadeTarget) => void;
	/** Pre-flight only: a shifted dependent ALSO already publishes `newCol`. */
	onCollision?: (kind: 'view' | 'materialized view', schemaName: string, name: string) => void;
	/**
	 * Called for a view / MV with an EXPLICIT column list whose body republishes
	 * the column. Such an object never shifts a published name (the list pins
	 * them — why the rename skips it), but a column DROP changes the arity its
	 * `*` produces and breaks the object outright. Only the drop's fixpoint
	 * passes this; when absent the object is skipped without paying the probe,
	 * exactly as the cascade always has.
	 */
	onListedShifted?: (kind: 'view' | 'materialized view', schemaName: string, name: string) => void;
}

/**
 * One round's dependent scan, shared by the rename cascade (pre-flight and
 * live driver) and the drop fixpoint: every schema's plain views and
 * maintained tables. An explicit column list pins the published names (the
 * same guard `cte.columns` is inside the CTE exposure analysis), so a listed
 * object is never a shift target — it is reported through
 * {@link ShiftScanOpts.onListedShifted} instead, when that arm is wired.
 */
export function scanShiftedPublishers(
	db: Database,
	target: ColumnRenameCascadeTarget,
	oldCol: string,
	newCol: string,
	resolvers: ObjectRefResolvers,
	resolveColumnInSource: ResolveColumnInSource,
	opts: ShiftScanOpts,
): void {
	for (const schema of db.schemaManager._getAllSchemas()) {
		const resolve = resolvers.forHomeSchema(schema.name);
		const shifted = (body: AST.QueryExpr): boolean => {
			let probe = body;
			if (opts.probeOnClone) {
				probe = spineCloneAst(body);
				renameColumnInAst(probe, target.tableName, oldCol, newCol, resolve, target.targetKey, resolveColumnInSource);
			}
			return bodyExposesRenamedColumn(probe, target.tableName, oldCol, newCol, resolve, target.targetKey, resolveColumnInSource);
		};
		for (const view of Array.from(schema.getAllViews())) {
			if (view.columns && view.columns.length > 0) {
				if (opts.onListedShifted && shifted(view.selectAst)) {
					opts.onListedShifted('view', schema.name, view.name);
				}
				continue;
			}
			if (!shifted(view.selectAst)) continue;
			if (opts.onCollision && bodyPublishesColumnNamed(view.selectAst, newCol, resolve, resolveColumnInSource)) {
				opts.onCollision('view', schema.name, view.name);
			}
			opts.onShifted({ targetKey: objectRefKey(schema.name, view.name), tableName: view.name });
		}
		for (const table of Array.from(schema.getAllTables())) {
			if (!isMaintainedTable(table)) continue;
			if (opts.isMvExcluded(table)) continue;
			const d = table.derivation;
			if (d.columns && d.columns.length > 0) {
				if (opts.onListedShifted && shifted(d.selectAst)) {
					opts.onListedShifted('materialized view', schema.name, table.name);
				}
				continue;
			}
			if (!shifted(d.selectAst)) continue;
			if (opts.onCollision && bodyPublishesColumnNamed(d.selectAst, newCol, resolve, resolveColumnInSource)) {
				opts.onCollision('materialized view', schema.name, table.name);
			}
			opts.onShifted({ targetKey: objectRefKey(schema.name, table.name), tableName: table.name });
		}
	}
}

/** A listed view / MV a column drop would break outright — see {@link ColumnRepublication.brokenListed}. */
export interface BrokenListedRepublisher {
	/** Canonical `<schema>.<name>` key, for `ObjectReach.namerOf`. */
	key: string;
	/** Error-message spelling: `view 'v'` / `materialized view 'm'`. */
	describe: string;
}

/** What {@link collectColumnRepublication} returns — the drop guards' lineage answer. */
export interface ColumnRepublication {
	/**
	 * The seed plus every view / MV that republishes the column, transitively,
	 * breadth-first — the SEED FIRST, so a guard sweeping targets in order
	 * reports base-table matches with the message spelling it always has.
	 */
	targets: ReadonlyArray<ColumnRenameCascadeTarget>;
	/**
	 * Views / MVs with an EXPLICIT column list whose body republishes the
	 * column. These are NOT targets — a pinned list publishes no shifted name —
	 * but dropping the column changes the arity their `*` produces and breaks
	 * the object outright, so a rule whose reach names one at all must refuse.
	 */
	brokenListed: ReadonlyArray<BrokenListedRepublisher>;
}

/**
 * Read-only republication fixpoint for `ALTER TABLE … DROP COLUMN`: the same
 * breadth-first walk the rename cascade's pre-flight runs
 * (`assertColumnRenameCascadePublishable`), minus its collision arm, plus the
 * listed-object arm above.
 *
 * Nothing is renamed here, so each round probes with a SENTINEL new name
 * ({@link PROBE_COLUMN_NAME} — the same trick `columnReferencedInAst` uses):
 * `probeOnClone` applies the sentinel rename to a spine clone and asks
 * `bodyExposesRenamedColumn` against it, mutating nothing. Downstream rounds
 * keep asking about `columnName` unchanged — a republisher exposes the column
 * under its own name, which is what its readers spell.
 *
 * The pristine catalog gives the same answers the cascade's live rounds would,
 * for the pre-flight's own reason: a round only rewrites references binding
 * ITS OWN target, which no other round's exposure question consults.
 *
 * MATERIALIZED VIEWS are treated exactly like views — `isMvExcluded` never
 * fires — deliberately CONSERVATIVE: an MV's backing columns survive the drop,
 * so a rule reading the column through the MV would in fact keep working
 * (against frozen contents, with the MV marked stale and its next
 * `refresh materialized view` failing). Refusing anyway keeps one rule for
 * both object kinds and matches what the named-projection spelling already
 * does (pinned by 41.10.2 §27) and what `DROP TABLE` does for the same object.
 * The cascade's stale-MV exclusion is rename-specific (a pre-stale MV's
 * backing columns are not renamed) and has no drop analogue, so staleness is
 * not consulted at all.
 */
export function collectColumnRepublication(
	db: Database,
	seed: ColumnRenameCascadeTarget,
	columnName: string,
	resolvers: ObjectRefResolvers,
	resolveColumnInSource: ResolveColumnInSource,
): ColumnRepublication {
	const colLower = columnName.toLowerCase();
	const targets: ColumnRenameCascadeTarget[] = [seed];
	const brokenListed: BrokenListedRepublisher[] = [];
	const flaggedListed = new Set<string>();
	const visited = new Set<string>([visitKeyOf(seed, colLower)]);
	const queue: ColumnRenameCascadeTarget[] = [seed];
	while (queue.length > 0) {
		const target = queue.shift()!;
		scanShiftedPublishers(db, target, columnName, PROBE_COLUMN_NAME, resolvers, resolveColumnInSource, {
			probeOnClone: true,
			isMvExcluded: () => false,
			onShifted: dependent => {
				const key = visitKeyOf(dependent, colLower);
				if (visited.has(key)) return;
				visited.add(key);
				targets.push(dependent);
				queue.push(dependent);
			},
			onListedShifted: (kind, schemaName, name) => {
				const key = objectRefKey(schemaName, name);
				if (flaggedListed.has(key)) return;
				flaggedListed.add(key);
				brokenListed.push({ key, describe: `${kind} '${name}'` });
			},
		});
	}
	return { targets, brokenListed };
}
