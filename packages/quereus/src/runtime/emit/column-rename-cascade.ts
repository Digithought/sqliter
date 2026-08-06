import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type * as AST from '../../parser/ast.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import type { ObjectRefResolvers } from '../../schema/object-ref-resolver.js';
import {
	bodyExposesRenamedColumn,
	bodyPublishesColumnNamed,
	objectRefKey,
	renameColumnInAst,
} from '../../schema/rename-rewriter.js';
import type { ResolveColumnInSource } from '../../schema/rename-rewriter.js';
import { spineCloneAst } from '../../util/ast-spine-clone.js';

/**
 * Worklist driver for `ALTER TABLE … RENAME COLUMN` propagation. Rewriting a
 * dependent view / materialized-view body can SHIFT THE NAME the object
 * publishes (a bare passthrough projection of the renamed column — or a `*`
 * covering the target — starts publishing the new name), and the objects
 * reading IT then need the same column rename applied with the view as the
 * target. This module owns that fixpoint:
 *
 *     queue ← [ renamed table ]
 *     while queue: run the ordinary all-schema propagation for the head,
 *       then enqueue every view / MV whose published names that round shifted.
 *
 * Each round re-enters the SAME per-schema propagation
 * (`propagateColumnRenameInSchema` / `propagateColumnRenameToMaterializedViews`
 * — threaded in by `propagateColumnRename` in alter-table.ts as the `runRound`
 * callback, to avoid an import cycle), so every dependent kind the first round
 * covers — dependent tables' CHECK / DEFAULT / GENERATED expressions, views,
 * materialized views, assertions — is covered at every depth.
 *
 * Views cannot be recursive and a maintained table cannot derive from itself,
 * so the visited set is insurance against a malformed catalog rather than an
 * expected cycle — but without it the loop would be unbounded.
 *
 * NOTE: each round costs a full all-schema propagation plus a full scan of every
 * schema's views and maintained tables, and the pre-flight additionally spine-clones
 * every scanned body per round — so one `RENAME COLUMN` is O(chain depth × catalog
 * size) AST walks. Depth is 1–3 for realistic catalogs and DDL is rare, so this is
 * not worth optimizing now; if a deep republishing chain over a large catalog ever
 * makes RENAME COLUMN slow, narrow each round to the objects that actually name the
 * round's target (an object-dependency index) instead of re-sweeping the catalog.
 */

/** One round's rename target: the object whose published column shifts old → new. */
export interface ColumnRenameCascadeTarget {
	/** Canonical `<schema>.<name>` key of the target (see {@link objectRefKey}). */
	targetKey: string;
	/** The target's bare name — what unqualified references in dependent bodies spell. */
	tableName: string;
}

const visitKeyOf = (target: ColumnRenameCascadeTarget, oldColLower: string): string =>
	`${target.targetKey}:${oldColLower}`;

/**
 * The live cascade. Breadth-first from the renamed table: run `runRound` (the
 * ordinary all-schema column-rename propagation) for the head, then scan for
 * views / MVs whose published names that round shifted and enqueue them as the
 * next targets. Each round's rewrites land in place before the scan runs, so
 * the scan reads post-rewrite bodies — {@link bodyExposesRenamedColumn}'s
 * documented contract.
 *
 * `preStaleMvs` is the statement's pre-notify staleness snapshot: a pre-stale
 * MV's backing columns are NOT renamed (its body may be rewritten, but only
 * REFRESH may reshape the backing — see `applyMaterializedViewRewrite`), so
 * its published names do not shift and its readers must NOT be rewritten.
 *
 * The caller runs `restoreUnaffectedMaterializedViews` once, AFTER the whole
 * cascade — not per round.
 */
export async function runColumnRenameCascade(
	db: Database,
	seed: ColumnRenameCascadeTarget,
	oldCol: string,
	newCol: string,
	preStaleMvs: ReadonlySet<string>,
	resolvers: ObjectRefResolvers,
	resolveColumnInSource: ResolveColumnInSource,
	runRound: (target: ColumnRenameCascadeTarget) => Promise<void>,
): Promise<void> {
	const oldColLower = oldCol.toLowerCase();
	const visited = new Set<string>();
	const queue: ColumnRenameCascadeTarget[] = [seed];
	while (queue.length > 0) {
		const target = queue.shift()!;
		const key = visitKeyOf(target, oldColLower);
		if (visited.has(key)) continue;
		visited.add(key);
		await runRound(target);
		scanShiftedPublishers(db, target, oldCol, newCol, resolvers, resolveColumnInSource, {
			probeOnClone: false,
			isMvExcluded: mv => preStaleMvs.has(objectRefKey(mv.schemaName, mv.name)),
			onShifted: dependent => queue.push(dependent),
		});
	}
}

/**
 * Read-only pre-flight for the cascade, run BEFORE the statement's first side
 * effect: walks the same fixpoint the live cascade will walk — probing spine
 * clones, mutating nothing — and refuses the statement when any round would
 * leave a view / materialized view publishing TWO columns of the new name
 * (it already publishes `newCol`, and the shifted passthrough would add a
 * second). This mirrors how the base-table verb refuses a rename that
 * collides with an existing column, and it must run pre-mutation: the live
 * cascade rewrites bodies in place with no rollback, so a mid-cascade throw
 * would strand a partial rename (the same reasoning the no-catch NOTE on
 * `reregisterRewrittenAssertion` records).
 *
 * The collision test runs against the PRISTINE body: before the rename the
 * target cannot publish `newCol`, so any `newCol` already published is
 * necessarily a different column (a case-only respelling is the one rename for
 * which that premise fails, and returns below before any scan). A `newCol`
 * publication some EARLIER round created is likewise never a distinct column —
 * it can only have come from an `oldCol` publication — which is why measuring
 * the collision on the pristine body is right rather than merely convenient.
 * The exposure test runs against a throwaway
 * clone with the round's rewrite applied, matching the live driver's
 * post-rewrite contract; the pre-mutation catalog gives the same answers the
 * live rounds see because a round only rewrites references binding ITS OWN
 * target, which no other round's exposure question consults.
 */
export function assertColumnRenameCascadePublishable(
	db: Database,
	seed: ColumnRenameCascadeTarget,
	oldCol: string,
	newCol: string,
	resolvers: ObjectRefResolvers,
	resolveColumnInSource: ResolveColumnInSource,
): void {
	const oldColLower = oldCol.toLowerCase();
	// A case-only respelling ('x' → 'X') merges no two name classes: the `newCol` a
	// dependent "already publishes" IS the renamed column itself, not a second one.
	// Skipping keeps the pristine-body collision test's premise — that the target
	// cannot publish `newCol` before the rename — true on every case it runs on.
	if (oldColLower === newCol.toLowerCase()) return;
	const visited = new Set<string>([visitKeyOf(seed, oldColLower)]);
	const queue: ColumnRenameCascadeTarget[] = [seed];
	while (queue.length > 0) {
		const target = queue.shift()!;
		scanShiftedPublishers(db, target, oldCol, newCol, resolvers, resolveColumnInSource, {
			probeOnClone: true,
			// Runs before the statement's first notify, so live staleness equals the
			// snapshot the driver will take.
			isMvExcluded: mv => mv.derivation.stale === true,
			onCollision: (kind, schemaName, name) => {
				const via = target.targetKey === seed.targetKey ? '' : ` (through '${target.tableName}')`;
				throw new QuereusError(
					`cannot rename column '${seed.tableName}.${oldCol}' to '${newCol}': `
						+ `${kind} '${schemaName}.${name}' already publishes a column named '${newCol}' and `
						+ `also republishes the renamed column${via}, so following the rename would make it `
						+ `publish two '${newCol}' columns. Alias one of the two in the ${kind}'s body, `
						+ `or choose a different name.`,
					StatusCode.ERROR,
				);
			},
			onShifted: dependent => {
				const key = visitKeyOf(dependent, oldColLower);
				if (visited.has(key)) return;
				visited.add(key);
				queue.push(dependent);
			},
		});
	}
}

interface ShiftScanOpts {
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
}

/**
 * One round's dependent scan, shared by the pre-flight and the live driver:
 * every schema's plain views and maintained tables, skipping any with an
 * explicit column list (a declared list pins the published names — the same
 * guard `cte.columns` is inside the CTE exposure analysis).
 */
function scanShiftedPublishers(
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
			if (view.columns && view.columns.length > 0) continue;
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
			if (d.columns && d.columns.length > 0) continue;
			if (!shifted(d.selectAst)) continue;
			if (opts.onCollision && bodyPublishesColumnNamed(d.selectAst, newCol, resolve, resolveColumnInSource)) {
				opts.onCollision('materialized view', schema.name, table.name);
			}
			opts.onShifted({ targetKey: objectRefKey(schema.name, table.name), tableName: table.name });
		}
	}
}
