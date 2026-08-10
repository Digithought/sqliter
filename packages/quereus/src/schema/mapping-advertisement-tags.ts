import type { SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import type { Schema } from './schema.js';
import type { TableSchema } from './table.js';
import type {
	MappingAdvertisement,
	DecompositionMember,
	LogicalColumnMapping,
	SharedKey,
	StorageShape,
	AttributePivot,
} from '../vtab/mapping-advertisement.js';
import { validateReservedTags } from './reserved-tags.js';
import { raiseReservedTagDiagnostics } from './reserved-tags-policy.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

/**
 * Shared tag→advertisement builder for generic modules (memory / store).
 *
 * A generic module doesn't intrinsically know how its basis tables decompose a
 * logical table; the developer declares the decomposition via reserved
 * `quereus.lens.decomp.*` tags on the basis tables (validated by the typed
 * registry in {@link ./reserved-tags.ts}). This builder reads those tags and
 * assembles the equivalent {@link MappingAdvertisement} list, which the module
 * returns from `getMappingAdvertisements`. See `docs/lens.md` § The Default
 * Mapper.
 *
 * Tag mini-language (the facet leads the key so each is a single-placeholder
 * registry template; one decomposition `<id>`'s facts are distributed across its
 * member basis tables):
 *
 * - decomposition-scoped (declared on ≥1 member, must agree across members):
 *   `quereus.lens.decomp.logical.<id>`     = logical table name
 *   `quereus.lens.decomp.role.<id>`        = primary-storage | auxiliary-access
 *   `quereus.lens.decomp.anchor.<id>`      = the anchor member relationId
 *   `quereus.lens.decomp.keykind.<id>`     = surrogate | logical-tuple
 *     (a surrogate's value comes from the anchor key column's declared `default`;
 *      no generator tag — the engine chooses no ID policy)
 * - member-scoped (declared on the member table they describe):
 *   `quereus.lens.decomp.member.<id>`      = this table's member relationId (default: table name)
 *   `quereus.lens.decomp.presence.<id>`    = mandatory | optional (default: mandatory)
 *   `quereus.lens.decomp.key.<id>`         = csv of this member's shared-key columns
 *   `quereus.lens.decomp.col.<id>.<logicalColumn>`     = basis column backing it on this member
 *   `quereus.lens.decomp.pivot.<id>.<entity|attribute|value>` = EAV pivot column on this member
 *
 * `<id>` and logical column names must not contain `.` in this encoding (they are
 * identifiers). A malformed tag (bad enum / mis-sited / bad value shape) fails
 * through {@link validateReservedTags}; a structurally-incomplete decomposition
 * (a member set with no logical/role/anchor/keykind) throws a clear error. Both
 * fire inside the compile-first loop, before any catalog mutation (atomic deploy).
 */
export function buildAdvertisementsFromTags(basisSchema: Schema): MappingAdvertisement[] {
	const decomps = new Map<string, DecompAccumulator>();

	for (const table of basisSchema.getAllTables()) {
		const decompTags = decompSubset(table.tags);
		if (!decompTags) continue;

		// Shape/site validation through the existing typed registry — a malformed
		// decomp tag fails the deploy the same atomic way validateLensTags does.
		raiseReservedTagDiagnostics(validateReservedTags(decompTags, 'physical-table'));

		for (const [key, rawValue] of Object.entries(decompTags)) {
			ingestTag(decomps, table, key, rawValue);
		}
	}

	const result: MappingAdvertisement[] = [];
	for (const [id, acc] of decomps) {
		result.push(assembleAdvertisement(basisSchema, id, acc));
	}
	return result;
}

const DECOMP_PREFIX = 'quereus.lens.decomp.';

/** Returns the decomp-only tag subset of a table, or undefined when it has none. */
function decompSubset(tags: Record<string, SqlValue> | undefined): Record<string, SqlValue> | undefined {
	if (!tags) return undefined;
	let out: Record<string, SqlValue> | undefined;
	for (const [key, value] of Object.entries(tags)) {
		if (!key.startsWith(DECOMP_PREFIX)) continue;
		(out ??= {})[key] = value;
	}
	return out;
}

/** Per-decomposition accumulation, decomposition-scoped facts plus member map. */
interface DecompAccumulator {
	logicalTable?: string;
	role?: string;
	anchor?: string;
	keykind?: string;
	/** Keyed by member relationId. */
	members: Map<string, MemberAccumulator>;
}

interface MemberAccumulator {
	relationId: string;
	tableName: string;
	presence?: string;
	keyColumns?: string[];
	/** logical-column-name -> basis column on this member. */
	columns: Map<string, string>;
	pivot: { entity?: string; attribute?: string; value?: string };
}

/** Routes one decomp tag into the accumulator. */
function ingestTag(
	decomps: Map<string, DecompAccumulator>,
	table: TableSchema,
	key: string,
	rawValue: SqlValue,
): void {
	const remainder = key.slice(DECOMP_PREFIX.length);
	const firstDot = remainder.indexOf('.');
	if (firstDot < 0) return; // no facet/id separator — registry would have flagged it
	const facet = remainder.slice(0, firstDot);
	const rest = remainder.slice(firstDot + 1);
	const value = rawValue == null ? '' : String(rawValue);

	// Decomposition-scoped facets: `rest` is the whole `<id>`.
	switch (facet) {
		case 'logical': setScoped(decomps, rest, 'logicalTable', value, key); return;
		case 'role': setScoped(decomps, rest, 'role', value, key); return;
		case 'anchor': setScoped(decomps, rest, 'anchor', value, key); return;
		case 'keykind': setScoped(decomps, rest, 'keykind', value, key); return;
	}

	// Member-scoped facets. `member`/`presence`/`key` carry `<id>`; `col`/`pivot`
	// carry `<id>.<extra>`.
	if (facet === 'member' || facet === 'presence' || facet === 'key') {
		const member = memberFor(decomps, rest, table);
		if (facet === 'member') member.relationId = value;
		else if (facet === 'presence') member.presence = value;
		else member.keyColumns = splitCsv(value);
		return;
	}
	if (facet === 'col' || facet === 'pivot') {
		const idDot = rest.indexOf('.');
		if (idDot < 0) {
			throw new QuereusError(
				`lens decomposition tag '${key}' is missing its '<id>.<name>' suffix`,
				StatusCode.ERROR,
			);
		}
		const id = rest.slice(0, idDot);
		const extra = rest.slice(idDot + 1);
		const member = memberFor(decomps, id, table);
		if (facet === 'col') {
			member.columns.set(extra, value);
		} else {
			if (extra !== 'entity' && extra !== 'attribute' && extra !== 'value') {
				throw new QuereusError(
					`lens decomposition tag '${key}' has unknown pivot facet '${extra}' (expected entity, attribute, or value)`,
					StatusCode.ERROR,
				);
			}
			member.pivot[extra] = value;
		}
	}
}

/** Sets a decomposition-scoped scalar, erroring on a conflicting prior value. */
function setScoped(
	decomps: Map<string, DecompAccumulator>,
	id: string,
	field: 'logicalTable' | 'role' | 'anchor' | 'keykind',
	value: string,
	key: string,
): void {
	const acc = decompFor(decomps, id);
	const prior = acc[field];
	if (prior !== undefined && prior !== value) {
		throw new QuereusError(
			`lens decomposition '${id}' has conflicting '${field}' across its member tables ('${prior}' vs '${value}', from tag '${key}')`,
			StatusCode.ERROR,
		);
	}
	acc[field] = value;
}

function decompFor(decomps: Map<string, DecompAccumulator>, id: string): DecompAccumulator {
	let acc = decomps.get(id);
	if (!acc) {
		acc = { members: new Map() };
		decomps.set(id, acc);
	}
	return acc;
}

function memberFor(decomps: Map<string, DecompAccumulator>, id: string, table: TableSchema): MemberAccumulator {
	const acc = decompFor(decomps, id);
	// Members are keyed by table name while accumulating; the member relationId
	// (which may be overridden) is resolved at assembly.
	let member = acc.members.get(table.name);
	if (!member) {
		member = { relationId: table.name, tableName: table.name, columns: new Map(), pivot: {} };
		acc.members.set(table.name, member);
	}
	return member;
}

/** Assembles one validated-shape advertisement from an accumulator. */
function assembleAdvertisement(
	basisSchema: Schema,
	id: string,
	acc: DecompAccumulator,
): MappingAdvertisement {
	const logicalTable = required(acc.logicalTable, id, 'logical');
	const role = required(acc.role, id, 'role') as MappingAdvertisement['role'];
	const anchorRelationId = required(acc.anchor, id, 'anchor');
	const keykind = required(acc.keykind, id, 'keykind') as SharedKey['kind'];

	const keyColumnsByRelation = new Map<string, readonly string[]>();
	const members: DecompositionMember[] = [];
	for (const member of acc.members.values()) {
		const columns: LogicalColumnMapping[] = [];
		for (const [logicalColumn, basisCol] of member.columns) {
			columns.push({ logicalColumn, basisExpr: columnExpr(basisCol) });
		}
		const decompMember: DecompositionMember = {
			relationId: member.relationId,
			relation: { schema: basisSchema.name, table: member.tableName },
			presence: (member.presence ?? 'mandatory') as DecompositionMember['presence'],
			columns,
			...(buildPivot(id, member)),
		};
		members.push(decompMember);
		keyColumnsByRelation.set(member.relationId, member.keyColumns ?? []);
	}

	// Deterministic order: anchor first, then by relationId.
	members.sort((a, b) => {
		if (a.relationId === anchorRelationId) return -1;
		if (b.relationId === anchorRelationId) return 1;
		return a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0;
	});

	const sharedKey: SharedKey = { kind: keykind, keyColumnsByRelation };
	const storage: StorageShape = { anchorRelationId, members, sharedKey };

	// The advertisement id IS the existence anchor's relationId (the IND contract,
	// `id === storage.anchorRelationId`), NOT the tag-key grouping segment `<id>`
	// (which only groups the distributed facts). The resolver enforces this.
	return { id: anchorRelationId, logicalTable, role, storage };
}

function buildPivot(id: string, member: MemberAccumulator): { attributePivot?: AttributePivot } {
	const { entity, attribute, value } = member.pivot;
	const present = [entity, attribute, value].filter(v => v !== undefined).length;
	if (present === 0) return {};
	if (present !== 3) {
		throw new QuereusError(
			`lens decomposition '${id}' member '${member.tableName}' has a partial attributePivot; declare all of entity/attribute/value or none`,
			StatusCode.ERROR,
		);
	}
	return { attributePivot: { entityColumn: entity!, attributeColumn: attribute!, valueColumn: value! } };
}

function required(value: string | undefined, id: string, facet: string): string {
	if (value === undefined || value.length === 0) {
		throw new QuereusError(
			`lens decomposition '${id}' is missing the required '${facet}' fact (tag 'quereus.lens.decomp.${facet}.${id}')`,
			StatusCode.ERROR,
		);
	}
	return value;
}

function columnExpr(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

/** Splits a validated csv-of-identifiers value into trimmed tokens. */
function splitCsv(value: string): string[] {
	return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
