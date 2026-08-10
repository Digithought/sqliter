import type * as AST from '../parser/ast.js';
import { astToString } from '../emit/ast-stringify.js';
import type { LensDeploymentSnapshot, LensTableSnapshot } from './lens.js';

/**
 * Engine-emitted backfill DDL for lens basis re-decompositions
 * (docs/lens.md § The deployed basis representation).
 *
 * A basis re-decomposition (split / merge / rename) changes *how* a logical
 * relation is stored but not the relation itself:
 *
 *   logical = prior_lens.get(prior_basis) = new_lens.get(new_basis)
 *
 * so each new basis member is a projection of the logical relation, which the
 * engine already has as a query over the prior basis (`prior_lens.get`). Where
 * every column of a new basis member is reconstructible that way, the engine
 * generates the backfill — `insert into <member> select <cols> from (<prior get>)` —
 * itself; columns that need genuinely new data stay the application's to supply.
 *
 * This module is the **pure** classifier + generator. It diffs the prior →
 * current {@link LensDeploymentSnapshot} pair (the deterministic, serializable
 * deploy record — not live catalog state, which is why both snapshots are the
 * inputs rather than the differ re-reading slots) and yields one
 * {@link BackfillRow} per *new* basis relation.
 */

/** Per-relation backfill classification (see module doc). */
export type BackfillCategory =
	/** Every mapped column is reconstructible — fully engine-generated. */
	| 're-decomposition'
	/** Some reconstructible, some new — engine generates the reconstructible columns. */
	| 'partial'
	/** No column is reconstructible — entirely the application's. */
	| 'needs-data';

/** One classified backfill obligation for a new basis relation. */
export interface BackfillRow {
	/** The logical table the basis relation backs. */
	logicalTable: string;
	/** `schema.table` of the new basis member. */
	basisRelation: string;
	category: BackfillCategory;
	/**
	 * The generated `insert … select … from (<prior get>)` for the reconstructible
	 * columns; `null` when `needs-data` (or a deferred multi-member surrogate split).
	 */
	backfillSql: string | null;
	/** Basis columns the engine backfills. */
	generatedColumns: string[];
	/** Basis columns the application must supply (empty for `re-decomposition`). */
	missingColumns: string[];
	/** Human note: classification rationale, surrogate omissions, basis-hash drift. */
	reason: string;
}

/**
 * Classifies the basis re-decomposition between two deploys and generates the
 * engine-discharged backfill DDL. Rows are ordered by logical table then basis
 * relation. With no information-bearing change (no new basis relations) it yields
 * nothing.
 *
 * @param prev    the previous deploy's snapshot (the prior basis the backfill reads from).
 * @param current the current deploy's snapshot (the new basis being populated).
 * @param liveBasisHash when supplied, the freshly-recomputed hash of the basis declared
 *   schema; a mismatch against `current.basisHash` flags a "basis drifted out-of-band"
 *   warning in each row's `reason` (the prior get-body may no longer be valid).
 */
export function computeBasisBackfill(
	prev: LensDeploymentSnapshot,
	current: LensDeploymentSnapshot,
	liveBasisHash?: string,
): BackfillRow[] {
	const rows: BackfillRow[] = [];

	const driftNote = (liveBasisHash !== undefined && liveBasisHash !== current.basisHash)
		? ` [warning: basis schema '${current.basisSchemaName}' drifted out-of-band since the lens was last deployed (recorded hash ${current.basisHash || '∅'}, live ${liveBasisHash || '∅'}); the prior get-body may no longer be valid — re-apply the lens before backfilling]`
		: '';

	for (const [tableLower, curTable] of current.tables) {
		const prevTable = prev.tables.get(tableLower);
		// A logical table with no prior deploy is freshly declared, not a
		// re-decomposition — there is no prior get-body to reconstruct from.
		if (!prevTable) continue;

		rows.push(...classifyTable(prevTable, curTable, driftNote));
	}

	rows.sort((a, b) => {
		if (a.logicalTable !== b.logicalTable) return a.logicalTable < b.logicalTable ? -1 : 1;
		if (a.basisRelation !== b.basisRelation) return a.basisRelation < b.basisRelation ? -1 : 1;
		return 0;
	});
	return rows;
}

/** A new basis relation grouped with the columns mapped onto it by the current lens. */
interface NewRelationGroup {
	basisRelation: { schema: string; table: string };
	cols: ReadonlyArray<{ basisColumn: string; logicalColumn: string }>;
	/** Member columns a skeleton insert must supply (NOT NULL, no default, non-generated). */
	requiredBasisColumns: readonly string[];
}

/** Classifies every new basis relation backing one logical table. */
function classifyTable(
	prevTable: LensTableSnapshot,
	curTable: LensTableSnapshot,
	driftNote: string,
): BackfillRow[] {
	const prevRelations = new Set(prevTable.relationBacking.keys());

	const prevLogicalLower = new Set(prevTable.logicalColumns.map(c => c.toLowerCase()));
	const prevLowerToOriginal = new Map<string, string>();
	for (const c of prevTable.logicalColumns) prevLowerToOriginal.set(c.toLowerCase(), c);

	// Each *new* basis relation (one the prior lens did not back) is a backfill site.
	const groups = new Map<string, NewRelationGroup>();
	for (const [key, backing] of curTable.relationBacking) {
		if (prevRelations.has(key)) continue; // relation already existed under the prior lens
		groups.set(key, { basisRelation: backing.basisRelation, cols: backing.columns, requiredBasisColumns: backing.requiredBasisColumns });
	}

	// A surrogate shared key spread across >1 new member cannot be soundly
	// threaded yet (one surrogate evaluated once and reused across members) —
	// defer rather than emit an unsound per-member insert.
	const surrogate = curTable.surrogateMemberKeys;
	const newSurrogateMembers = surrogate
		? Array.from(groups.keys()).filter(k => surrogate.has(k))
		: [];
	const deferSurrogate = newSurrogateMembers.length > 1;

	const rows: BackfillRow[] = [];
	for (const [key, group] of groups) {
		const basisRelation = `${group.basisRelation.schema}.${group.basisRelation.table}`;

		if (deferSurrogate && surrogate?.has(key)) {
			rows.push({
				logicalTable: curTable.logicalTable,
				basisRelation,
				category: 'needs-data',
				backfillSql: null,
				generatedColumns: [],
				missingColumns: group.cols.map(c => c.basisColumn),
				reason: `multi-member surrogate split across ${newSurrogateMembers.length} new basis members; threading one surrogate across members is deferred to lens-multi-source-put-fanout — the application must supply this backfill` + driftNote,
			});
			continue;
		}

		rows.push(classifyRelation(prevTable, curTable, group, basisRelation, prevLogicalLower, prevLowerToOriginal, driftNote));
	}
	return rows;
}

/** Classifies one new basis relation and generates its backfill DDL (if any). */
function classifyRelation(
	prevTable: LensTableSnapshot,
	curTable: LensTableSnapshot,
	group: NewRelationGroup,
	basisRelation: string,
	prevLogicalLower: ReadonlySet<string>,
	prevLowerToOriginal: ReadonlyMap<string, string>,
	driftNote: string,
): BackfillRow {
	// A column is reconstructible iff the prior deploy's get-body already produced
	// the logical column it maps to (so the data exists in the prior basis).
	// Otherwise it is genuinely new and the application must supply it. A basis
	// column that maps to no logical column (e.g. a surrogate-key default) never
	// appears in the backing, so it is naturally omitted — the basis default mints it.
	const generated: Array<{ basisColumn: string; selectName: string }> = [];
	const missing: string[] = [];
	for (const c of group.cols) {
		const logicalLower = c.logicalColumn.toLowerCase();
		if (prevLogicalLower.has(logicalLower)) {
			generated.push({ basisColumn: c.basisColumn, selectName: prevLowerToOriginal.get(logicalLower)! });
		} else {
			missing.push(c.basisColumn);
		}
	}

	const category: BackfillCategory =
		generated.length === group.cols.length ? 're-decomposition'
		: generated.length === 0 ? 'needs-data'
		: 'partial';

	// A skeleton insert supplies only the reconstructible (generated) basis columns
	// and relies on the basis to mint the rest from their declared defaults. That is
	// sound iff every NOT-NULL, no-default, non-generated member column is among the
	// reconstructible ones — otherwise the omitted required column has no value source
	// and the insert fails an unguarded NOT NULL constraint. When it cannot run, null
	// the SQL out (the app must own the insert) but keep the category + reconstructible
	// record so the app still learns which columns are recoverable.
	const generatedLower = new Set(generated.map(g => g.basisColumn.toLowerCase()));
	const unsatisfiedRequired = group.requiredBasisColumns.filter(c => !generatedLower.has(c.toLowerCase()));
	const skeletonRunnable = unsatisfiedRequired.length === 0;

	const backfillSql = generated.length > 0 && skeletonRunnable
		? astToString(buildBackfillInsert(group.basisRelation, generated, prevTable.getBody))
		: null;

	let reason: string;
	if (category === 're-decomposition') {
		reason = `pure re-decomposition: every column of ${basisRelation} is reconstructible from the prior get-body for '${curTable.logicalTable}'`;
	} else if (category === 'partial') {
		reason = `partial re-decomposition: columns [${generated.map(g => g.basisColumn).join(', ')}] reconstruct from the prior get-body for '${curTable.logicalTable}'; columns [${missing.join(', ')}] are new and must be supplied by the application`;
	} else {
		reason = `needs-data: no column of ${basisRelation} existed in the prior basis for '${curTable.logicalTable}'; the application must supply this backfill`;
	}
	if (generated.length > 0 && !skeletonRunnable) {
		reason += `; cannot emit a runnable skeleton: basis column(s) [${unsatisfiedRequired.join(', ')}] are NOT NULL with no default and are not reconstructible from the prior get-body, so the application must own the insert`;
	}

	return {
		logicalTable: curTable.logicalTable,
		basisRelation,
		category,
		backfillSql,
		generatedColumns: generated.map(g => g.basisColumn),
		missingColumns: missing,
		reason: reason + driftNote,
	};
}

/**
 * Builds `insert into <basisRelation> (<basisCols>) select <logicalCols> from
 * (<prior get>) as __lens_prior` as an AST (stringified by the caller). The
 * SELECT pulls each logical column by name from the prior get-body subquery —
 * whose output columns are exactly the prior deploy's logical columns — and the
 * INSERT targets the corresponding basis column on the new member.
 */
function buildBackfillInsert(
	basisRelation: { schema: string; table: string },
	generated: ReadonlyArray<{ basisColumn: string; selectName: string }>,
	priorGetBody: AST.SelectStmt,
): AST.InsertStmt {
	const source: AST.SelectStmt = {
		type: 'select',
		columns: generated.map(g => ({
			type: 'column',
			expr: { type: 'column', name: g.selectName } as AST.ColumnExpr,
		})),
		from: [{
			type: 'subquerySource',
			subquery: priorGetBody,
			alias: '__lens_prior',
		} as AST.SubquerySource],
	};
	return {
		type: 'insert',
		table: { type: 'identifier', name: basisRelation.table, schema: basisRelation.schema } as AST.IdentifierExpr,
		columns: generated.map(g => g.basisColumn),
		source,
	};
}
