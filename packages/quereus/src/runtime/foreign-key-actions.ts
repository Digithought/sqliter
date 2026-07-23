import type { Database } from '../core/database.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../schema/table.js';
import { resolveReferencedColumns } from '../schema/table.js';
import type { ForeignKeyAction } from '../parser/ast.js';
import type { Row, SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { expressionToString, quoteIdentifier } from '../emit/ast-stringify.js';
import { sqlValueIdentical } from '../util/comparison.js';
import type { LensSlot } from '../schema/lens.js';
import { resolveSlotBasisSource } from '../schema/lens-prover.js';
import {
	findLogicalParentFkRefs,
	logicalToBasisColumnMap,
	matchingBasisFksForLensRef,
	basisFksOverriddenByDivergentLensFk,
	type LogicalParentFkRef,
} from '../schema/lens-fk-discovery.js';
import type { BatchableRestrictFk } from '../planner/building/foreign-key-builder.js';

const log = createLogger('runtime:fk-actions');

// ---------------------------------------------------------------------------
// Batched parent-side RESTRICT enforcement.
//
// For the statement shapes the batchability gate (`getBatchableRestrictFks`,
// planner/building/foreign-key-builder.ts) admits — non-lens-routed
// DELETE/UPDATE under ABORT/ROLLBACK where EVERY inbound FK is a non-self-ref
// RESTRICT — both per-row probes (the plan-time `NOT EXISTS` and the runtime
// pre-walk) are replaced by ONE chunked probe per FK at end of statement. The
// DML executor accumulates each affected row's OLD referenced-key tuple here
// during the row loop and flushes before the statement savepoint releases, so
// a violation still rolls the whole statement back exactly like a per-row
// abort under ABORT/ROLLBACK. See docs/runtime.md § Batched RESTRICT.
// ---------------------------------------------------------------------------

/** Per-FK accumulation state for one statement execution. */
export interface ParentRestrictBatchEntry extends BatchableRestrictFk {
	/** Deduplicated OLD referenced-key tuples, keyed by an injective serialization. */
	readonly keys: Map<string, SqlValue[]>;
}

export type ParentRestrictBatch = ParentRestrictBatchEntry[];

/** Keys probed per child-table query — a handful of compiles per statement, not one per row. */
const RESTRICT_BATCH_CHUNK = 500;

/**
 * Allocate the per-statement-execution accumulation state for the batchable
 * inbound RESTRICT FKs. Must be called once per execution (never cached on the
 * emit closure) so a re-run prepared statement starts empty.
 */
export function createParentRestrictBatch(fks: readonly BatchableRestrictFk[]): ParentRestrictBatch {
	return fks.map(fk => ({ ...fk, keys: new Map<string, SqlValue[]>() }));
}

/**
 * Injective serialization of a referenced-key tuple for dedup. Each segment is
 * type-tagged and (for variable-length payloads) length-prefixed, so two
 * distinct tuples can never collide — a collision would silently drop a probe.
 */
function serializeKeyTuple(values: SqlValue[]): string {
	let out = '';
	for (const v of values) {
		if (typeof v === 'number') out += `n${v};`;
		else if (typeof v === 'bigint') out += `i${v};`;
		else if (typeof v === 'string') out += `s${v.length}:${v};`;
		else if (v instanceof Uint8Array) out += `b${v.length}:${Array.from(v).join(',')};`;
		else out += `x${String(v)};`;
	}
	return out;
}

/**
 * Accumulate one mutated parent row's OLD referenced-key tuples into the batch
 * — the batched replacement for the per-row RESTRICT probes, applying the same
 * skip rules: MATCH SIMPLE (a tuple containing NULL is unreferenceable) and,
 * for UPDATE, the referenced-column-change short-circuit.
 */
export function accumulateParentRestrictKeys(
	batch: ParentRestrictBatch,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): void {
	for (const entry of batch) {
		// UPDATE: only rows that actually re-key a referenced column contribute.
		if (operation === 'update' && newRow !== undefined) {
			let anyChanged = false;
			for (const idx of entry.parentColIndices) {
				if (!sqlValueIdentical(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
					anyChanged = true;
					break;
				}
			}
			if (!anyChanged) continue;
		}

		// MATCH SIMPLE: NULL parent values cannot be referenced.
		const values = entry.parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
		if (values.some(v => v === null || v === undefined)) continue;

		const key = serializeKeyTuple(values);
		if (!entry.keys.has(key)) entry.keys.set(key, values);
	}
}

/**
 * End-of-statement flush: one chunked probe per inbound RESTRICT FK over the
 * accumulated key tuples. Fired by `runWithStatementSavepoints` after the row
 * loop and BEFORE the deferred-maintenance flush and the statement savepoint
 * release, so a hit throws the existing RESTRICT error shape and rolls the
 * whole statement back. Re-checks the `foreign_keys` pragma and the
 * trust-the-origin suppression at flush time, mirroring the per-row pre-check.
 *
 * The probe selects the FK columns (not `select 1`) so the violating key stays
 * available for a future richer message; the message itself is unchanged and
 * matcher-compatible (`/constraint|foreign|fk/i`). Comparison rides plain SQL
 * `=` / `IN` against the child column — identical collation semantics to the
 * per-row `NOT EXISTS` by construction.
 */
export async function flushParentRestrictBatch(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	batch: ParentRestrictBatch,
): Promise<void> {
	if (db._isFkRestrictSuppressed()) return;
	if (!db.options.getBooleanOption('foreign_keys')) return;

	for (const entry of batch) {
		if (entry.keys.size === 0) continue;
		const { childTable, fk } = entry;
		const childColQuoted = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
		const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
			? `${quoteIdentifier(childTable.schemaName)}.`
			: '';
		const from = `${schemaPrefix}${quoteIdentifier(childTable.name)}`;

		const tuples = [...entry.keys.values()];
		for (let i = 0; i < tuples.length; i += RESTRICT_BATCH_CHUNK) {
			const chunk = tuples.slice(i, i + RESTRICT_BATCH_CHUNK);
			let whereClause: string;
			let params: SqlValue[];
			if (childColQuoted.length === 1) {
				whereClause = `${childColQuoted[0]} in (${chunk.map(() => '?').join(', ')})`;
				params = chunk.map(t => t[0]);
			} else {
				whereClause = chunk
					.map(() => `(${childColQuoted.map(c => `${c} = ?`).join(' and ')})`)
					.join(' or ');
				params = chunk.flat();
			}
			const sql = `select ${childColQuoted.join(', ')} from ${from} where ${whereClause} limit 1`;

			log('RESTRICT batch check (%s): child=%s keys=%d', operation, childTable.name, chunk.length);

			const stmt = db.prepare(sql);
			try {
				stmt.bindAll(params);
				let referenced = false;
				for await (const _row of stmt._iterateRowsRaw()) {
					referenced = true;
					break;
				}
				if (referenced) {
					const opName = operation === 'delete' ? 'DELETE' : 'UPDATE';
					throw new QuereusError(
						`FOREIGN KEY constraint failed: ${opName} on '${parentTable.name}' violates RESTRICT from '${childTable.name}'`,
						StatusCode.CONSTRAINT,
					);
				}
			} finally {
				await stmt.finalize();
			}
		}
	}
}

/**
 * Executes cascading foreign key actions when a parent row is deleted or updated.
 *
 * @param db Database instance
 * @param parentTable Parent table schema being mutated
 * @param operation 'delete' or 'update'
 * @param oldRow The old row values from the parent table
 * @param newRow The new row values (undefined for delete)
 * @param lensRouted Whether this basis write was routed through a lens view. The
 *   divergent-basis-FK suppression (a logical FK overriding the physical basis action)
 *   applies ONLY then; a basis-direct write (`false`) bears its physical basis FK action
 *   unsuppressed — see {@link executeForeignKeyActionsAndLens}.
 * @param visitedTables Set of table names already visited (for cycle detection)
 */
export async function executeForeignKeyActions(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	lensRouted = false,
	visitedTables?: Set<string>,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const visited = visitedTables ?? new Set<string>();
	const parentKey = `${parentTable.schemaName}.${parentTable.name}`.toLowerCase();

	if (visited.has(parentKey)) {
		throw new QuereusError(
			`Foreign key cascade cycle detected involving table '${parentTable.name}'`,
			StatusCode.CONSTRAINT
		);
	}
	visited.add(parentKey);

	// Basis FKs a divergent non-RESTRICT logical FK overrides — their physical action is
	// suppressed here so the logical action (fired by the lens walker) governs alone.
	// ONLY for a lens-routed write: a basis-direct write bears no logical FK semantics, so
	// its physical basis action must run unsuppressed (else the cascade is dropped entirely
	// once the lens walker is gated off). Cheap-empty otherwise.
	const suppressed = lensRouted
		? basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager)
		: new Set<ForeignKeyConstraintSchema>();

	try {
		// Find all child tables with FKs referencing this parent. The reverse FK index is keyed
		// on the referenced schema.table, so the two discovery filters (referencedTable /
		// targetSchema match) are satisfied by the lookup and drop out; the per-FK body is
		// unchanged. The index returns the shared empty array (the O(1) gate) when nothing
		// references this parent — the common case short-circuits with no allocation.
		for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(parentTable.schemaName, parentTable.name)) {
			const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;

			// RESTRICT is handled by parent-side constraint checks, not actions
			if (action === 'restrict') continue;

			// Suppressed: a divergent non-RESTRICT logical FK over the same columns
			// replaces this basis action (the lens walker fires the logical action).
			if (suppressed.has(fk)) continue;

			const parentColIndices = resolveReferencedColumns(fk, parentTable);
			if (parentColIndices.length !== fk.columns.length) continue;

			// Get old parent values for the referenced columns
			const oldParentValues = parentColIndices.map(idx => oldRow[idx]);

			// Skip if any old value is NULL (NULLs don't participate in FK matching)
			if (oldParentValues.some(v => v === null || v === undefined)) continue;

			await executeSingleFKAction(
				db, childTable, fk, action, parentTable, parentColIndices,
				oldParentValues, operation === 'update' ? newRow : undefined,
				visited
			);
		}
	} finally {
		visited.delete(parentKey);
	}
}

/**
 * The combined physical + lens FK-action entry point the DML executor fires after
 * every basis row delete/update. Runs the physical {@link executeForeignKeyActions}
 * (cascade / set-null / set-default over declared basis `TableSchema.foreignKeys`)
 * and then the logical dual {@link executeLensForeignKeyActions} (the same actions
 * over a *logical* FK that lives only on a lens slot's `enforced-fk` obligation). A
 * single wrapper keeps the two sites from drifting — wherever a basis row write fires
 * physical FK actions, the logical cascade fires too. The physical half is unconditional;
 * the logical half fires ONLY for a write routed through a lens view (`lensRouted`), so a
 * basis-direct write bears solely its physical (basis-declared) FK semantics — consistent
 * with the plan-time lens RESTRICT collector and logical CHECK, which attach at the lens
 * boundary only. The lens half is a further cheap early return when `foreign_keys` is off
 * or no lens slot is backed by `parentTable`.
 */
export async function executeForeignKeyActionsAndLens(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	lensRouted = false,
): Promise<void> {
	await executeForeignKeyActions(db, parentTable, operation, oldRow, newRow, lensRouted);
	if (lensRouted) {
		await executeLensForeignKeyActions(db, parentTable, operation, oldRow, newRow);
	}
}

/**
 * Pre-walk the FK action graph rooted at `parentTable` and assert that no
 * RESTRICT child anywhere in the transitive cascade closure blocks the
 * mutation. Reads happen at call time — the caller is responsible for
 * invoking this BEFORE `vtab.update` runs, so OLD-value scans still resolve
 * for backends with rowid-mode FK columns (lamina) where post-mutation
 * scans would dereference through the new parent value.
 *
 * The walk:
 *   1. Runs the existing direct RESTRICT scan
 *      (`assertNoRestrictedChildrenForParentMutation`) for `parentTable`.
 *   2. For each child FK with action `cascade` / `setNull` / `setDefault`
 *      that would propagate a column change (UPDATE: parent's referenced
 *      column changed; DELETE: always), enumerates the matching child
 *      rows and computes the would-be post-cascade row. Recurses with the
 *      child as the new "parent" — for UPDATE with `cascade` the recursion
 *      carries the new FK column values forward; for DELETE the recursion
 *      treats the cascade as another DELETE; SET NULL recurses with the
 *      child's projected new row.
 *   3. Cycle detection via a `visited` set keyed by
 *      `${schemaName}.${tableName}` (matches the existing walker's key).
 *
 * `lensRouted` gates the two *logical* FK steps: the lens RESTRICT pre-check (step 1b)
 * and the divergent-basis-FK suppression (in step 1 and step 2). It is `true` only for a
 * write routed through a lens view, and is carried UNCHANGED into the recursion: the
 * nested levels form the transitive closure of *this* write, so a lens-routed top means
 * the whole closure inherits logical FK semantics. This is required to catch a logical
 * RESTRICT below an *agreeing* basis cascade — that basis cascade runs as a basis-direct
 * write at runtime (which never fires the deeper lens RESTRICT) and the agreeing lens
 * cascade is elided (so it never re-enters through the child view either), leaving this
 * pre-walk as the sole enforcer. A basis-direct top write passes `false`, so the whole
 * recursion stays basis-only.
 */
export async function assertTransitiveRestrictsForParentMutation(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	lensRouted = false,
	visited?: Set<string>,
): Promise<void> {
	log('TRANSITIVE entry: parent=%s op=%s lensRouted=%o fk-pragma=%o', parentTable.name, operation, lensRouted, db.options.getBooleanOption('foreign_keys'));
	// Trust-the-origin apply path: RESTRICT is enforced by the origin at its own commit,
	// so the receiver skips it (gating cascade-action propagation is intentionally NOT here).
	if (db._isFkRestrictSuppressed()) return;
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const visitedSet = visited ?? new Set<string>();
	const parentKey = `${parentTable.schemaName}.${parentTable.name}`.toLowerCase();
	if (visitedSet.has(parentKey)) return;
	visitedSet.add(parentKey);

	try {
		// Step 1: direct RESTRICT scan for this parent. The divergent-basis-FK suppression
		// inside it applies only when this top-level write is lens-routed (a basis-direct
		// write bears its physical basis RESTRICT unsuppressed).
		log('TRANSITIVE step1: parent=%s op=%s', parentTable.name, operation);
		await assertNoRestrictedChildrenForParentMutation(db, parentTable, operation, oldRow, newRow, lensRouted);

		// Step 1b: lens RESTRICT pre-check — the logical dual, keyed off the *logical* FK
		// action. Fired here (pre-basis-op, riding the same pre-mutation timing) so a logical
		// RESTRICT over a non-restrict basis FK observes the pre-cascade child state, which a
		// deferred commit-time `NOT EXISTS` cannot. ONLY for a lens-routed write — a logical FK
		// governs only writes through the lens; a basis-direct write bears no logical RESTRICT.
		// Direct (non-recursive): transitivity through basis cascades rides this enclosing walk
		// (a nested basis cascade re-enters the DML executor as a basis-direct write — its own
		// `lensRouted = false`; a genuine logical cascade re-enters through the child *view* and
		// gets a fresh `lensRouted = true`, so logical transitivity is preserved either way).
		if (lensRouted) {
			await assertLensRestrictsForParentMutation(db, parentTable, operation, oldRow, newRow);
		}

		// Step 2: recurse through cascading children that would propagate a
		// referenced-column change. For each FK whose action would rewrite or
		// delete child rows, scan the matching children NOW (pre-mutation, so
		// the parent's OLD values still resolve), compute the projected child
		// row, and recurse with that child as the new "parent".

		// Basis cascading FKs a divergent non-RESTRICT logical FK overrides — skip them in
		// the recursion: the physical cascade they walk will not run (the logical action
		// replaces it), and the logical action's own transitivity is enforced when its
		// child-view DML re-enters this walk at the next level. ONLY for a lens-routed write
		// (else the basis cascade governs unsuppressed and must be walked).
		const suppressed = lensRouted
			? basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager)
			: new Set<ForeignKeyConstraintSchema>();

		// The reverse FK index is keyed on the referenced schema.table, so the two discovery
		// filters (referencedTable / targetSchema match) are satisfied by the lookup and drop
		// out; the per-FK body below is unchanged.
		for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(parentTable.schemaName, parentTable.name)) {
			const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
			if (action !== 'cascade' && action !== 'setNull' && action !== 'setDefault') continue;

			// Suppressed: the logical action replaces this basis cascade, so the
			// physical cascade it would walk never runs — do not recurse through it.
			if (suppressed.has(fk)) continue;

			const parentColIndices = resolveReferencedColumns(fk, parentTable);
			if (parentColIndices.length !== fk.columns.length) continue;

			// MATCH SIMPLE: NULL parent values cannot be referenced.
			const oldParentValues = parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
			if (oldParentValues.some(v => v === null || v === undefined)) continue;

			// UPDATE-only short-circuit: skip if no referenced parent column changed.
			let newParentValues: SqlValue[] | undefined;
			if (operation === 'update' && newRow !== undefined) {
				let anyChanged = false;
				for (const idx of parentColIndices) {
					if (!sqlValueIdentical(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
						anyChanged = true;
						break;
					}
				}
				if (!anyChanged) continue;
				newParentValues = parentColIndices.map(idx => newRow[idx]) as SqlValue[];
			}

			// Scan child rows that match the OLD parent values.
			const childColQuoted = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
			const whereClause = childColQuoted.map(c => `${c} = ?`).join(' AND ');
			const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
				? `${quoteIdentifier(childTable.schemaName)}.`
				: '';
			const sql = `select * from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause}`;

			log('TRANSITIVE pre-walk: %s with params %o', sql, oldParentValues);

			// Cached internal statement leased for the whole scan (compiled once per
			// shape, not re-prepared per parent row). The recursion inside this loop
			// can re-enter with the SAME SQL text (self-referential / diamond FK graph)
			// while this statement is still iterating — that re-entry hits the cache's
			// busy-guard and gets its own fresh one-shot statement, never this live
			// cursor. See InternalStatementCache.iterate.
			for await (const childOldRow of db._internalStatementCache.iterate(sql, oldParentValues)) {
				let childNewRow: Row | undefined;
				let childOp: 'delete' | 'update';

				if (action === 'cascade' && operation === 'delete') {
					childOp = 'delete';
					childNewRow = undefined;
				} else if (action === 'cascade' && operation === 'update' && newParentValues) {
					childOp = 'update';
					const next = [...(childOldRow as Row)] as SqlValue[];
					for (let i = 0; i < fk.columns.length; i++) {
						next[fk.columns[i]] = newParentValues[i];
					}
					childNewRow = next as Row;
				} else if (action === 'setNull') {
					childOp = 'update';
					const next = [...(childOldRow as Row)] as SqlValue[];
					for (let i = 0; i < fk.columns.length; i++) {
						next[fk.columns[i]] = null;
					}
					childNewRow = next as Row;
				} else if (action === 'setDefault') {
					// SET DEFAULT recursion: pass the child OLD row as both
					// old and new. The recursion's column-change short-circuit
					// will treat this as "no FK column moved" and the per-target
					// cascade SQL (executeSingleFKAction) still fires its own
					// RESTRICT enforcement for non-rowid-chained backends. This
					// matches the coverage gap SET DEFAULT already has in
					// rowid-chained backends — no regression beyond status quo.
					childOp = 'update';
					childNewRow = childOldRow as Row;
				} else {
					continue;
				}

				// Recurse carrying the SAME `lensRouted`: the nested levels are the
				// transitive closure of *this* write, so when the top-level write is
				// lens-routed every level inherits the logical FK semantics. This is
				// load-bearing for a logical RESTRICT sitting below an *agreeing*
				// basis cascade (basis + logical both cascade): at runtime that basis
				// cascade executes as a basis-direct write — which does NOT fire the
				// deeper lens RESTRICT — and the agreeing lens cascade is elided, so it
				// never re-enters through the child view either. The ONLY place that
				// deeper RESTRICT is caught is this pre-walk recursing with the lens flag
				// still set. For a basis-direct top-level write `lensRouted` is already
				// false, so the recursion correctly stays basis-only throughout.
				await assertTransitiveRestrictsForParentMutation(
					db, childTable, childOp, childOldRow as Row, childNewRow, lensRouted, visitedSet,
				);
			}
		}
	} finally {
		visitedSet.delete(parentKey);
	}
}

/**
 * Backend-agnostic RESTRICT pre-check fired by the runtime DML executor BEFORE
 * a parent DELETE or UPDATE hits the vtab. Mirrors the plan-time `NOT EXISTS`
 * synthesized by `buildParentSideFKChecks`, but uses a direct `select 1 ... limit 1`
 * against the child table so any vtab module sees a consistent enforcement path.
 *
 * The plan-time check remains in force; this runtime pass is defense-in-depth
 * for vtab modules where the embedded subquery's evaluation diverges from a
 * plain row scan (correlation handling, isolation snapshots, predicate
 * pushdown quirks, etc.).
 *
 * No-op when `foreign_keys` is off, when no FK references this parent table
 * with action `'restrict'`, when any old referenced value is NULL (MATCH SIMPLE),
 * or — for UPDATE — when no referenced parent column changed.
 *
 * `lensRouted` gates the divergent-basis-FK suppression: only a write through the lens
 * lets a divergent non-RESTRICT logical FK override (suppress) the basis RESTRICT. A
 * basis-direct write (`false`) enforces its physical basis RESTRICT unsuppressed.
 */
export async function assertNoRestrictedChildrenForParentMutation(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	lensRouted = false,
): Promise<void> {
	// Trust-the-origin apply path: RESTRICT is enforced by the origin at its own commit,
	// so the receiver skips it (gating cascade-action propagation is intentionally NOT here).
	if (db._isFkRestrictSuppressed()) return;
	if (!db.options.getBooleanOption('foreign_keys')) return;

	// Basis RESTRICT FKs a divergent non-RESTRICT logical FK overrides — their RESTRICT
	// pre-check is suppressed so the parent mutation a logical cascade must complete is
	// not aborted. ONLY for a lens-routed write: a basis-direct write bears no logical FK
	// semantics, so its physical basis RESTRICT must stand unsuppressed. Cheap-empty otherwise.
	const suppressed = lensRouted
		? basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager)
		: new Set<ForeignKeyConstraintSchema>();

	// The reverse FK index is keyed on the referenced schema.table, so the two discovery
	// filters (referencedTable / targetSchema match) are satisfied by the lookup and drop
	// out; the per-FK body below is unchanged.
	for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(parentTable.schemaName, parentTable.name)) {
		const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
		if (action !== 'restrict') continue;

		// Suppressed: a divergent non-RESTRICT logical FK over the same columns
		// replaces this basis RESTRICT (the logical cascade must run, not abort).
		if (suppressed.has(fk)) continue;

		const parentColIndices = resolveReferencedColumns(fk, parentTable);
		if (parentColIndices.length !== fk.columns.length) continue;

		// UPDATE: only enforce when at least one referenced parent column changed.
		if (operation === 'update' && newRow !== undefined) {
			let anyChanged = false;
			for (const idx of parentColIndices) {
				if (!sqlValueIdentical(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
					anyChanged = true;
					break;
				}
			}
			if (!anyChanged) continue;
		}

		// MATCH SIMPLE: NULL parent values cannot be referenced.
		const oldParentValues = parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
		if (oldParentValues.some(v => v === null || v === undefined)) continue;

		const childColNames = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
		const whereClause = childColNames.map(c => `${c} = ?`).join(' AND ');
		const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
			? `${quoteIdentifier(childTable.schemaName)}.`
			: '';
		const sql = `select 1 from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause} limit 1`;

		log('RESTRICT check (%s): %s with params %o', operation, sql, oldParentValues);

		// Cached internal statement (compiled once per shape) rather than a fresh
		// per-row prepare/finalize — see InternalStatementCache.
		if (await db._internalStatementCache.probe(sql, oldParentValues)) {
			const opName = operation === 'delete' ? 'DELETE' : 'UPDATE';
			throw new QuereusError(
				`FOREIGN KEY constraint failed: ${opName} on '${parentTable.name}' violates RESTRICT from '${childTable.name}'`,
				StatusCode.CONSTRAINT,
			);
		}
	}
}

/**
 * Runs `fn` (a cascade child-DML re-entry) with the Database's cascade-reentry
 * flag set, restoring the prior value in a `finally`. Wraps every physical + lens
 * cascade child write (cascade DELETE / UPDATE, SET NULL, SET DEFAULT) so a host
 * vtab can tell Quereus's own cascade re-entry from a direct user DML on the same
 * child table — see {@link Database._setFkCascadeReentry}. Save-and-restore (never
 * a blind reset to false) keeps nesting correct: an inner cascade restores to the
 * outer's `true`, the outermost to `false`, and a thrown cascade still restores the
 * prior value (the flag never latches on across statements).
 */
// NOTE: the flag is per-Database mutable state, held across the `await fn()` window by
// synchronous save/restore. Correct only while statements on one connection do not truly
// interleave (per-connection serialization holds today). The sibling `_fkRestrictSuppressed`
// is only ever set under the apply-path mutex; this flag is set on the general user-DML
// cascade path, so if Quereus ever runs concurrent statements on one Database a flag set by
// one cascade could be observed by an unrelated statement's write during that await gap —
// scope it to the executing statement/connection then.
async function withFkCascadeReentry<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const prior = db._setFkCascadeReentry(true);
	try {
		return await fn();
	} finally {
		db._setFkCascadeReentry(prior);
	}
}

async function executeSingleFKAction(
	db: Database,
	childTable: TableSchema,
	fk: ForeignKeyConstraintSchema,
	action: 'cascade' | 'setNull' | 'setDefault',
	parentTable: TableSchema,
	parentColIndices: number[],
	oldParentValues: SqlValue[],
	newRow: Row | undefined,
	_visited: Set<string>,
): Promise<void> {
	const childColNames = fk.columns.map(idx => childTable.columns[idx].name);
	const whereClause = childColNames
		.map(name => `"${name}" = ?`)
		.join(' AND ');
	const qualifiedChildTable = `"${childTable.schemaName}"."${childTable.name}"`;

	switch (action) {
		case 'cascade': {
			if (newRow === undefined) {
				// CASCADE DELETE: delete matching child rows
				const sql = `DELETE FROM ${qualifiedChildTable} WHERE ${whereClause}`;
				log('CASCADE DELETE: %s with params %o', sql, oldParentValues);
				await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			} else {
				// CASCADE UPDATE: update child FK columns to new parent values
				const newParentValues = parentColIndices.map(idx => newRow[idx]);
				const setClauses = childColNames
					.map(name => `"${name}" = ?`)
					.join(', ');
				const whereParamsClause = childColNames
					.map(name => `"${name}" = ?`)
					.join(' AND ');
				const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereParamsClause}`;
				const params = [...newParentValues, ...oldParentValues];
				log('CASCADE UPDATE: %s with params %o', sql, params);
				await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, params));
			}
			break;
		}
		case 'setNull': {
			const setClauses = childColNames.map(name => `"${name}" = NULL`).join(', ');
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
			log('SET NULL: %s with params %o', sql, oldParentValues);
			await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			break;
		}
		case 'setDefault': {
			const setClauses = childColNames.map((name, i) => {
				const col = childTable.columns[fk.columns[i]];
				const defaultVal = col.defaultValue;
				if (defaultVal === null || defaultVal === undefined) {
					return `"${name}" = NULL`;
				}
				// defaultValue is always an AST Expression — stringify it
				return `"${name}" = (${expressionToString(defaultVal)})`;
			}).join(', ');
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
			log('SET DEFAULT: %s with params %o', sql, oldParentValues);
			await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Lens cascade walker — the logical dual of executeForeignKeyActions.
//
// A logical FK lives only on a child lens slot's `enforced-fk` obligation (on no
// basis table), so executeForeignKeyActions — which scans declared
// `TableSchema.foreignKeys` — never sees it. When a lens-backed logical *parent* is
// deleted / re-keyed, the basis op runs but no logical cascade fires. This walker is
// fired (via executeForeignKeyActionsAndLens) right after each basis row write: it
// reverse-maps the basis parent table to the logical parent slot(s) it backs,
// discovers the referencing logical FKs, and — for the non-RESTRICT actions
// (cascade / set-null / set-default) — issues the propagating DML against the logical
// child *view*. Issuing against the view (not the basis child) re-enters the full
// lens write path, so the child's own constraints + any nested logical cascade fire,
// exactly as a user-issued `delete from x.child` would. Recursion + termination work
// identically to executeSingleFKAction's SQL-issuing path: each cascade is a real
// nested statement and a cycle terminates by data exhaustion.
// ---------------------------------------------------------------------------

/**
 * Propagates the non-RESTRICT parent-side actions (cascade / set-null / set-default)
 * of a *logical* FK through the lens when a lens-backed logical parent is deleted or
 * updated. The logical dual of {@link executeForeignKeyActions}.
 *
 * No-op (early return) when `foreign_keys` is off, or when the O(1)
 * `SchemaManager.basisTableBacksLogicalParentFk` gate says `basisParentTable` backs no
 * logical-FK-referenced parent slot — so non-lens DML pays one `Set.has`, not a scan
 * over the lens slots. On a gate hit the reverse-map slot scan below is the
 * confirmation: it walks every lens slot whose single basis spine is `basisParentTable`
 * (a multi-source / decomposition parent resolves to no single spine and never matches,
 * consistent with the gate's omission).
 */
export async function executeLensForeignKeyActions(
	db: Database,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const sm = db.schemaManager;
	// O(1) gate: nothing below can match when this basis table backs no logical-FK
	// parent slot — skip the slot scan entirely (the common non-lens / no-logical-FK case).
	if (!sm.basisTableBacksLogicalParentFk(basisParentTable.schemaName, basisParentTable.name)) return;

	const basisNameLower = basisParentTable.name.toLowerCase();
	const basisSchemaLower = basisParentTable.schemaName.toLowerCase();

	// Reverse-map basis → logical parent slots: every lens slot whose single basis
	// spine is `basisParentTable` (usually 0 or 1). A multi-source / decomposition
	// parent resolves to no single spine and never matches (documented boundary).
	for (const schema of sm._getAllSchemas()) {
		for (const parentSlot of schema.getAllLensSlots()) {
			const basis = resolveSlotBasisSource(parentSlot, sm);
			if (!basis) continue;
			if (basis.name.toLowerCase() !== basisNameLower) continue;
			if (basis.schemaName.toLowerCase() !== basisSchemaLower) continue;
			await executeLensFkActionsForParentSlot(db, parentSlot, basisParentTable, operation, oldRow, newRow);
		}
	}
}

/** A non-RESTRICT parent-side action propagated by the lens cascade walker. */
type LensFkAction = Extract<ForeignKeyAction, 'cascade' | 'setNull' | 'setDefault'>;

/**
 * Resolves a logical parent FK ref's referenced OLD (and, for UPDATE, NEW) values off the
 * basis parent write row — the extraction + skip logic shared by the lens cascade walker
 * ({@link executeLensFkActionsForParentSlot}) and the lens RESTRICT pre-check
 * ({@link assertLensRestrictsForParentMutation}), factored out so the two paths cannot drift.
 *
 * Maps each logical parent referenced column → its basis column (via `parentMap`) → basis
 * index, and reads the values off `oldRow` / `newRow` by basis index. Returns `undefined`
 * (⇒ skip this ref) when:
 *  - a referenced column has no plain basis projection (cannot read its basis value);
 *  - MATCH SIMPLE: any OLD referenced value is NULL (participates in no FK match); or
 *  - UPDATE: no referenced parent column actually changed (`sqlValueIdentical` short-circuit).
 */
function resolveLensFkParentReferencedValues(
	ref: LogicalParentFkRef,
	parentMap: Map<string, string>,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow: Row | undefined,
): { oldParentValues: SqlValue[]; newParentValues?: SqlValue[] } | undefined {
	// Logical referenced column → basis column → basis index. A column with no plain basis
	// projection disqualifies the ref (cannot read its basis value).
	const basisIndices: number[] = [];
	for (const logicalCol of ref.parentLogicalColumns) {
		const basisColName = parentMap.get(logicalCol.toLowerCase());
		const basisIdx = basisColName !== undefined
			? basisParentTable.columnIndexMap.get(basisColName.toLowerCase())
			: undefined;
		if (basisIdx === undefined) return undefined;
		basisIndices.push(basisIdx);
	}

	// MATCH SIMPLE: a NULL referenced value participates in no FK match.
	const oldParentValues = basisIndices.map(i => oldRow[i]) as SqlValue[];
	if (oldParentValues.some(v => v === null || v === undefined)) return undefined;

	// UPDATE short-circuit: skip when no referenced parent column actually changed.
	let newParentValues: SqlValue[] | undefined;
	if (operation === 'update' && newRow !== undefined) {
		let anyChanged = false;
		for (const i of basisIndices) {
			if (!sqlValueIdentical(oldRow[i] as SqlValue, newRow[i] as SqlValue)) { anyChanged = true; break; }
		}
		if (!anyChanged) return undefined;
		newParentValues = basisIndices.map(i => newRow[i]) as SqlValue[];
	}

	return { oldParentValues, newParentValues };
}

/**
 * Fires the logical cascade for one logical parent slot backed by `basisParentTable`.
 * For each referencing logical FK with a non-RESTRICT op-action it: elides when an
 * equivalent basis FK with an **agreeing** op-action already propagates over the basis
 * (a divergent basis action is instead suppressed and the logical action wins — see
 * {@link basisFksOverriddenByDivergentLensFk}), applies MATCH SIMPLE + the UPDATE
 * referenced-column-change short-circuit, and issues the logical-child DML.
 */
async function executeLensFkActionsForParentSlot(
	db: Database,
	parentSlot: LensSlot,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow: Row | undefined,
): Promise<void> {
	const sm = db.schemaManager;
	const refs = findLogicalParentFkRefs(parentSlot, sm);
	if (refs.length === 0) return;

	// Maps each logical parent referenced column → its basis column, so the OLD/NEW
	// referenced values can be read off the basis write row by basis index.
	const parentMap = logicalToBasisColumnMap(parentSlot);

	for (const ref of refs) {
		const { fk } = ref;
		const rawAction = operation === 'delete' ? fk.onDelete : fk.onUpdate;
		if (rawAction !== 'cascade' && rawAction !== 'setNull' && rawAction !== 'setDefault') continue;
		const action: LensFkAction = rawAction;

		// Action-aware elision (compose with the physical walker): elide the lens cascade
		// only when an equivalent basis FK exists whose op-action AGREES with the logical
		// action — then the physical executeForeignKeyActions already propagates the same
		// action over the basis (and the logical view reflects it), so firing on top would
		// double-mutate. When the matches DIVERGE (e.g. logical set-null over basis cascade,
		// or logical cascade over basis restrict) the logical action wins: the basis FK is
		// suppressed at every enforcement site (basisFksOverriddenByDivergentLensFk) and the
		// lens cascade fires here. With no match the basis enforces nothing ⇒ fire. The two
		// halves are exact complements in the single-equivalent-basis-FK case (one action).
		const matches = matchingBasisFksForLensRef(ref, parentSlot, basisParentTable, sm);
		const agree = matches.length > 0
			&& matches.every(m => (operation === 'delete' ? m.onDelete : m.onUpdate) === action);
		if (agree) {
			log('lens cascade %s on %s: elided — basis child carries an AGREEING equivalent FK (the physical walker propagates over the basis)',
				fk.name ?? '<anon>', parentSlot.logicalTable.name);
			continue;
		}

		// Read the parent's referenced OLD (and NEW) values off the basis row, applying the
		// shared MATCH SIMPLE + UPDATE referenced-column-change skip rules. `undefined` ⇒
		// skip this ref (unmappable column, NULL referenced value, or no key change).
		const values = resolveLensFkParentReferencedValues(ref, parentMap, basisParentTable, operation, oldRow, newRow);
		if (!values) continue;

		await issueLensFkAction(db, ref, action, operation, values.oldParentValues, values.newParentValues);
	}
}

/**
 * Issues the propagating DML against the logical child *view* — the logical dual of
 * {@link executeSingleFKAction}. Uses the logical child schema / table / column names
 * and binds the OLD parent values (and NEW for cascade-update) as parameters (never
 * inlined). The default for SET DEFAULT is the **logical** child column's
 * `defaultValue` AST (stringified), or NULL when none. Because the target is the
 * registered logical view, the DML re-enters the lens write path and its own
 * constraints + nested cascades fire.
 */
async function issueLensFkAction(
	db: Database,
	ref: LogicalParentFkRef,
	action: LensFkAction,
	operation: 'delete' | 'update',
	oldParentValues: SqlValue[],
	newParentValues: SqlValue[] | undefined,
): Promise<void> {
	const childTable = ref.childSlot.logicalTable;
	const childLogicalColumns = ref.childLogicalColumns;
	const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
		? `${quoteIdentifier(childTable.schemaName)}.`
		: '';
	const qualifiedChild = `${schemaPrefix}${quoteIdentifier(childTable.name)}`;
	const whereClause = childLogicalColumns.map(c => `${quoteIdentifier(c)} = ?`).join(' and ');

	switch (action) {
		case 'cascade': {
			if (operation === 'delete') {
				const sql = `delete from ${qualifiedChild} where ${whereClause}`;
				log('LENS CASCADE DELETE: %s with params %o', sql, oldParentValues);
				await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			} else {
				// CASCADE UPDATE: rewrite the child FK columns to the NEW parent values
				// (SET) for rows that still reference the OLD values (WHERE).
				const setClauses = childLogicalColumns.map(c => `${quoteIdentifier(c)} = ?`).join(', ');
				const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
				const params = [...(newParentValues ?? []), ...oldParentValues];
				log('LENS CASCADE UPDATE: %s with params %o', sql, params);
				await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, params));
			}
			break;
		}
		case 'setNull': {
			const setClauses = childLogicalColumns.map(c => `${quoteIdentifier(c)} = null`).join(', ');
			const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
			log('LENS SET NULL: %s with params %o', sql, oldParentValues);
			await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			break;
		}
		case 'setDefault': {
			const setClauses = childLogicalColumns.map((c, i) => {
				const defaultVal = childTable.columns[ref.fk.columns[i]]?.defaultValue;
				if (defaultVal === null || defaultVal === undefined) return `${quoteIdentifier(c)} = null`;
				// The logical child column's default AST, stringified (parametrizing it is
				// unnecessary — a default is a constant expression).
				return `${quoteIdentifier(c)} = (${expressionToString(defaultVal)})`;
			}).join(', ');
			const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
			log('LENS SET DEFAULT: %s with params %o', sql, oldParentValues);
			await withFkCascadeReentry(db, () => db._internalStatementCache.run(sql, oldParentValues));
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Lens RESTRICT pre-check — the logical dual of assertNoRestrictedChildrenForParentMutation.
//
// A *logical* FK with a RESTRICT op-action over a *non-restrict basis* FK (or no basis FK)
// cannot be enforced by the deferred plan-time `NOT EXISTS` the collector retains: a
// same-statement basis CASCADE / SET NULL / SET DEFAULT mutates the basis children
// mid-statement, so the deferred check would observe the *post-cascade* state and pass.
// Mirroring the physical RESTRICT pre-check, this scan is fired BEFORE the basis op (it
// rides assertTransitiveRestrictsForParentMutation, which the DML executor invokes before
// vtab.update), so it observes the *pre-cascade* child state and rejects the mutation.
//
// Keyed off the *logical* FK action (the physical pre-check is keyed off the basis action
// and scans declared TableSchema.foreignKeys, so it never sees a logical-only FK). The scan
// is direct (non-recursive); transitivity rides the enclosing basis transitive walk.
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic RESTRICT pre-check for a *logical* parent-side FK, the logical dual of
 * {@link assertNoRestrictedChildrenForParentMutation}. Fired by the runtime DML executor
 * (via {@link assertTransitiveRestrictsForParentMutation}) BEFORE the basis parent DELETE /
 * UPDATE hits the vtab, so it observes the pre-cascade child state — the timing a deferred
 * `NOT EXISTS` cannot achieve against a same-statement basis cascade.
 *
 * No-op (early return) when `foreign_keys` is off, or when the O(1)
 * `SchemaManager.basisTableBacksLogicalParentFk` gate says `basisParentTable` backs no
 * logical-FK-referenced parent slot — so non-lens DML pays one `Set.has`, not a scan over
 * the lens slots. On a gate hit the reverse-map slot scan below confirms; the
 * single-source-spine boundary is identical to the cascade walker's
 * ({@link executeLensForeignKeyActions}).
 */
export async function assertLensRestrictsForParentMutation(
	db: Database,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	// Trust-the-origin apply path: RESTRICT is enforced by the origin at its own commit,
	// so the receiver skips it (gating cascade-action propagation is intentionally NOT here).
	if (db._isFkRestrictSuppressed()) return;
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const sm = db.schemaManager;
	// O(1) gate: nothing below can match when this basis table backs no logical-FK
	// parent slot — skip the slot scan entirely (the common non-lens / no-logical-FK case).
	if (!sm.basisTableBacksLogicalParentFk(basisParentTable.schemaName, basisParentTable.name)) return;

	const basisNameLower = basisParentTable.name.toLowerCase();
	const basisSchemaLower = basisParentTable.schemaName.toLowerCase();

	// Reverse-map basis → logical parent slots: every lens slot whose single basis spine is
	// `basisParentTable` (usually 0 or 1). A multi-source / decomposition parent resolves to
	// no single spine and never matches (the documented boundary).
	for (const schema of sm._getAllSchemas()) {
		for (const parentSlot of schema.getAllLensSlots()) {
			const basis = resolveSlotBasisSource(parentSlot, sm);
			if (!basis) continue;
			if (basis.name.toLowerCase() !== basisNameLower) continue;
			if (basis.schemaName.toLowerCase() !== basisSchemaLower) continue;
			await assertLensRestrictsForParentSlot(db, parentSlot, basisParentTable, operation, oldRow, newRow);
		}
	}
}

/**
 * Enforces the RESTRICT logical FKs referencing one logical parent slot backed by
 * `basisParentTable`. For each referencing logical FK with a RESTRICT op-action it reads the
 * parent's referenced OLD values off the basis write row (shared
 * {@link resolveLensFkParentReferencedValues} — MATCH SIMPLE + UPDATE short-circuit) and
 * scans the logical child view for a surviving reference, throwing on a match.
 */
async function assertLensRestrictsForParentSlot(
	db: Database,
	parentSlot: LensSlot,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow: Row | undefined,
): Promise<void> {
	const sm = db.schemaManager;
	const refs = findLogicalParentFkRefs(parentSlot, sm);
	if (refs.length === 0) return;

	// Maps each logical parent referenced column → its basis column, so the OLD referenced
	// values can be read off the basis write row by basis index.
	const parentMap = logicalToBasisColumnMap(parentSlot);

	for (const ref of refs) {
		const { fk } = ref;
		const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
		// Only RESTRICT is enforced here — the non-RESTRICT actions are *propagated* by the
		// cascade walker (executeLensForeignKeyActions), not rejected.
		if (action !== 'restrict') continue;

		const values = resolveLensFkParentReferencedValues(ref, parentMap, basisParentTable, operation, oldRow, newRow);
		if (!values) continue;

		await assertNoLensChildReferences(db, ref, parentSlot, operation, values.oldParentValues);
	}
}

/**
 * Scans the logical child *view* (schema-qualified, logical column names — exactly what
 * {@link issueLensFkAction} reads) for a row still referencing the OLD parent values, and
 * throws a RESTRICT {@link QuereusError} (message parallel to the physical pre-check's,
 * matcher-compatible with `/constraint|foreign|fk/i`) when one survives.
 */
async function assertNoLensChildReferences(
	db: Database,
	ref: LogicalParentFkRef,
	parentSlot: LensSlot,
	operation: 'delete' | 'update',
	oldParentValues: SqlValue[],
): Promise<void> {
	const childTable = ref.childSlot.logicalTable;
	const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
		? `${quoteIdentifier(childTable.schemaName)}.`
		: '';
	const qualifiedChild = `${schemaPrefix}${quoteIdentifier(childTable.name)}`;
	const whereClause = ref.childLogicalColumns.map(c => `${quoteIdentifier(c)} = ?`).join(' and ');
	const sql = `select 1 from ${qualifiedChild} where ${whereClause} limit 1`;

	log('LENS RESTRICT check (%s): %s with params %o', operation, sql, oldParentValues);

	// Cached internal statement (compiled once per shape) rather than a fresh
	// per-row prepare/finalize — see InternalStatementCache.
	if (await db._internalStatementCache.probe(sql, oldParentValues)) {
		const opName = operation === 'delete' ? 'DELETE' : 'UPDATE';
		throw new QuereusError(
			`FOREIGN KEY constraint failed: ${opName} on '${parentSlot.logicalTable.name}' violates RESTRICT from '${childTable.name}'`,
			StatusCode.CONSTRAINT,
		);
	}
}
