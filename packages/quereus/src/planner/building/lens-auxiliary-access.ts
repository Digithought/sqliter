/**
 * Build-time construction of the {@link LensAuxiliaryAccessNode} read-path marker
 * (ticket `lens-access-shape-path-selection`). Wired from `planner/building/select.ts`
 * around an inlined lens view body, where the {@link PlanningContext} is in hand
 * so the auxiliary scans can be built with `buildTableReference` (proper attribute
 * ids + module context, ready for the Physical pass's access-path selection).
 *
 * Only **routable** auxiliaries are carried (D4/D5): an auxiliary needs a single-
 * member `storage` shape with a `logical-tuple` shared key aligned to the logical
 * primary key, the logical PK must resolve to the view body's output attributes,
 * and ≥1 advertised access column must be locatable on both the body and the
 * auxiliary's backing relation. An auxiliary that fails any of these (surrogate-
 * only key, served column that is not a logical column, …) is silently dropped;
 * if none are routable the marker is not built at all, leaving the view untouched.
 */

import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { LensSlot } from '../../schema/lens.js';
import type { MappingAdvertisement } from '../../vtab/mapping-advertisement.js';
import { LensAuxiliaryAccessNode, type AuxAccessColumn, type AuxJoinPair, type RoutableAuxiliary } from '../nodes/lens-auxiliary-access-node.js';
import { buildTableReference } from './table.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:lens-auxiliary-access');

/** An attribute located on a relation: its id, output column index, and scalar type. */
interface AttrRef { attrId: number; columnIndex: number; type: ScalarType }

/** Find an output attribute by (case-insensitive) name on a relation. */
function attrByName(rel: RelationalPlanNode, name: string): AttrRef | undefined {
	const attrs = rel.getAttributes();
	const lname = name.toLowerCase();
	for (let i = 0; i < attrs.length; i++) {
		if (attrs[i].name.toLowerCase() === lname) {
			return { attrId: attrs[i].id, columnIndex: i, type: attrs[i].type };
		}
	}
	return undefined;
}

/** Build the marker if ≥1 auxiliary is routable; otherwise return undefined. */
export function buildLensAuxiliaryAccessMarker(
	context: PlanningContext,
	slot: LensSlot,
	body: RelationalPlanNode,
): LensAuxiliaryAccessNode | undefined {
	const auxiliaries = slot.auxiliaryAccess;
	if (!auxiliaries || auxiliaries.length === 0) return undefined;

	// Logical PK column names, in declaration order.
	const pkColumns = slot.logicalTable.primaryKeyDefinition.map(pk => slot.logicalTable.columns[pk.index]?.name).filter((n): n is string => !!n);
	// Resolve the logical PK to the body's output attributes (D4 join-back side).
	const logicalPkAttrs: AttrRef[] = [];
	for (const name of pkColumns) {
		const a = attrByName(body, name);
		if (a) logicalPkAttrs.push(a);
	}

	const routables: RoutableAuxiliary[] = [];
	for (const advertisement of auxiliaries) {
		const routable = buildRoutable(context, advertisement, body, pkColumns, logicalPkAttrs);
		if (routable) routables.push(routable);
		else log('auxiliary %s not routable — degrading to scan', advertisement.id);
	}

	if (routables.length === 0) return undefined;
	return new LensAuxiliaryAccessNode(context.scope, body, routables);
}

function buildRoutable(
	context: PlanningContext,
	advertisement: MappingAdvertisement,
	body: RelationalPlanNode,
	pkColumns: readonly string[],
	logicalPkAttrs: readonly AttrRef[],
): RoutableAuxiliary | undefined {
	const storage = advertisement.storage;
	const access = advertisement.access;
	// D4: a routable auxiliary carries a single-member, logical-tuple-keyed storage
	// shape aligned to the logical PK; anything else degrades to scan (D5).
	if (!storage || !access || access.served.length === 0) return undefined;
	if (storage.members.length !== 1) return undefined;
	if (storage.sharedKey.kind !== 'logical-tuple') return undefined;
	if (pkColumns.length === 0 || logicalPkAttrs.length !== pkColumns.length) return undefined;

	const member = storage.members[0];
	const auxKeyBasisCols = storage.sharedKey.keyColumnsByRelation.get(member.relationId);
	if (!auxKeyBasisCols || auxKeyBasisCols.length !== pkColumns.length) return undefined;

	// Build the scan over the auxiliary's backing member relation.
	let auxScan: RelationalPlanNode;
	try {
		const from: AST.TableSource = {
			type: 'table',
			table: { type: 'identifier', name: member.relation.table, schema: member.relation.schema },
		};
		auxScan = buildTableReference(from, context);
	} catch (e) {
		log('auxiliary %s scan build failed: %O', advertisement.id, e);
		return undefined;
	}

	// Pair the logical PK to the auxiliary key positionally (D4).
	const joinPairs: AuxJoinPair[] = [];
	for (let i = 0; i < logicalPkAttrs.length; i++) {
		const auxKeyAttr = attrByName(auxScan, auxKeyBasisCols[i]);
		if (!auxKeyAttr) return undefined;
		joinPairs.push({ logicalPk: logicalPkAttrs[i], auxKey: auxKeyAttr });
	}

	// Locate each advertised access column on both the body and the auxiliary scan.
	// member.columns maps logical → basis expression; fall back to a name-match on
	// the auxiliary relation when the member does not map it.
	const memberBasisByLogical = new Map<string, string>();
	for (const m of member.columns) {
		if (m.basisExpr.type === 'column') memberBasisByLogical.set(m.logicalColumn.toLowerCase(), m.basisExpr.name);
	}
	const accessLogicalColumns = new Set<string>();
	for (const entry of access.served) for (const c of entry.columns) accessLogicalColumns.add(c.toLowerCase());

	const accessColumns: AuxAccessColumn[] = [];
	for (const logicalColumn of accessLogicalColumns) {
		const logicalAttr = attrByName(body, logicalColumn);
		if (!logicalAttr) continue; // form served, but column not a logical output (D5)
		const basisCol = memberBasisByLogical.get(logicalColumn) ?? logicalColumn;
		const auxAttr = attrByName(auxScan, basisCol);
		if (!auxAttr) continue; // column not projected by the auxiliary (D5)
		accessColumns.push({
			logicalColumn,
			logicalAttrId: logicalAttr.attrId,
			auxRef: auxAttr,
		});
	}

	if (accessColumns.length === 0) return undefined;

	return {
		advertisement,
		auxScan,
		joinPairs,
		accessColumns,
		served: access.served,
	};
}
