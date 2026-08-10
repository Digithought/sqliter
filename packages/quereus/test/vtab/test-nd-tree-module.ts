import type { Database as DatabaseType } from '../../src/core/database.js';
import { Database } from '../../src/index.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { Schema } from '../../src/schema/schema.js';
import type { MappingAdvertisement, LogicalColumnMapping } from '../../src/vtab/mapping-advertisement.js';
import { registerAccessFormRecognizer, functionNameRecognizer } from '../../src/planner/rules/access/lens-access-form-matcher.js';

/**
 * Synthetic nd-tree fixture for the access-shape read-path consumer
 * (`lens-access-shape-path-selection`). A real spatial module is unnecessary —
 * `AccessForm` is an open union, so the fixture advertises exotic forms with no
 * engine change, and the routed read executes as an ordinary in-memory
 * scan-and-filter over the auxiliary backing relation (routing/selection is what
 * the ticket exercises, not the auxiliary's internal access efficiency).
 *
 * The module is a {@link MemoryTableModule} subclass that returns whatever
 * advertisements a test assigns to {@link ads}; helpers build the canonical
 * nd-tree auxiliary advertisement, register the `nd_contains` scalar function the
 * predicate uses, and register the `contains`-form recognizer that keys off it.
 */
export class NdTreeModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

function keyMap(...entries: Array<[string, readonly string[]]>): ReadonlyMap<string, readonly string[]> {
	return new Map<string, readonly string[]>(entries);
}

/**
 * The canonical nd-tree auxiliary advertisement over a single backing member
 * keyed by the logical PK (logical-tuple), serving spatial forms over `coord`.
 * `member` maps both the key (`id`) and the access column (`coord`) to backing
 * columns so the rewrite can locate `coord`'s backing basis column.
 */
export function ndTreeAdvertisement(opts?: {
	id?: string;
	logicalTable?: string;
	backing?: { schema: string; table: string };
	keyColumn?: string;
	coordBasisColumn?: string;
	forms?: string[];
}): MappingAdvertisement {
	const id = opts?.id ?? 'Spatial_nd';
	const logicalTable = opts?.logicalTable ?? 'Spatial';
	const backing = opts?.backing ?? { schema: 'main', table: 'Spatial_nd' };
	const keyColumn = opts?.keyColumn ?? 'id';
	const coordBasis = opts?.coordBasisColumn ?? 'coord';
	const forms = opts?.forms ?? ['contains', 'knn', 'intersects'];
	return {
		id,
		logicalTable,
		role: 'auxiliary-access',
		storage: {
			anchorRelationId: id,
			members: [{
				relationId: id,
				relation: backing,
				presence: 'mandatory',
				columns: [colMap('id', keyColumn), colMap('coord', coordBasis)],
			}],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap([id, [keyColumn]]) },
		},
		access: { served: [{ columns: ['coord'], forms }] },
	};
}

let recognizerRegistered = false;

/**
 * Register the `nd_contains(coord, point)` scalar function (deterministic — equal
 * cells "contain" the point) and the `contains`-form recognizer that keys off it.
 * The recognizer registry is process-global; registering it more than once is
 * harmless (an extra recognizer that matches the same shape), but we guard it so
 * the registry stays clean across test files.
 */
export function registerNdTreeFixture(db: Database): void {
	db.createScalarFunction('nd_contains', { numArgs: 2, deterministic: true },
		(coord, point) => (coord === point ? 1 : 0));
	if (!recognizerRegistered) {
		registerAccessFormRecognizer('contains', functionNameRecognizer('nd_contains'));
		recognizerRegistered = true;
	}
}
