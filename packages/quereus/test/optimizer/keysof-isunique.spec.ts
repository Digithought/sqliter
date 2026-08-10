import { expect } from 'chai';
import { keysOf, isUnique, type KeyRel } from '../../src/planner/util/fd-utils.js';
import type { ColRef, RelationType } from '../../src/common/datatype.js';
import type { FunctionalDependency, PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';

/**
 * Direct unit tests for the unified uniqueness read surface (`keysOf` /
 * `isUnique`). We build lightweight `KeyRel` stubs (just `getType()` +
 * `physical`) rather than full plan trees so each surface — declared keys, the
 * FD set, and `isSet` — can be exercised in isolation.
 */

function makeRel(opts: {
	columnCount: number;
	isSet?: boolean;
	keys?: ColRef[][];
	fds?: FunctionalDependency[];
}): KeyRel {
	const columns = Array.from({ length: opts.columnCount }, (_, i) => ({
		name: `c${i}`,
		type: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
	}));
	const type: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: opts.isSet ?? false,
		columns,
		keys: opts.keys ?? [],
		rowConstraints: [],
	} as RelationType;
	const physical = { fds: opts.fds } as PhysicalProperties;
	return { getType: () => type, physical };
}

function keyStrings(rel: KeyRel): string[] {
	return keysOf(rel).map(k => [...k].join(',')).sort();
}

describe('keysOf / isUnique (unified uniqueness surface)', () => {
	it('returns declared keys mapped to column indices', () => {
		const rel = makeRel({ columnCount: 3, keys: [[{ index: 0 }]] });
		expect(keyStrings(rel)).to.deep.equal(['0']);
		expect(isUnique([0], rel)).to.equal(true);
		expect(isUnique([0, 2], rel)).to.equal(true); // superset of the key
		expect(isUnique([1], rel)).to.equal(false);
	});

	it('derives keys from an FD set (K → all_other_cols)', () => {
		// FD {0} → {1,2}: column 0 is a key on a 3-column relation.
		const rel = makeRel({
			columnCount: 3,
			fds: [{ determinants: [0], dependents: [1, 2], kind: 'unique' }],
		});
		expect(keyStrings(rel)).to.deep.equal(['0']);
		expect(isUnique([0], rel)).to.equal(true);
		expect(isUnique([1, 2], rel)).to.equal(false);
	});

	it('treats `∅ → all_cols` as the empty (≤1-row) key', () => {
		const rel = makeRel({
			columnCount: 2,
			fds: [{ determinants: [], dependents: [0, 1], kind: 'unique' }],
		});
		// The empty key subsumes everything.
		expect(keyStrings(rel)).to.deep.equal(['']);
		expect(isUnique([], rel)).to.equal(true);
		expect(isUnique([0], rel)).to.equal(true);
	});

	it('falls back to the all-columns key for a set with no smaller key', () => {
		const rel = makeRel({ columnCount: 2, isSet: true });
		expect(keyStrings(rel)).to.deep.equal(['0,1']);
		expect(isUnique([0, 1], rel)).to.equal(true);
		expect(isUnique([0], rel)).to.equal(false);
	});

	it('returns no keys for a bag (not a set, no keys, no FDs)', () => {
		const rel = makeRel({ columnCount: 2, isSet: false });
		expect(keysOf(rel)).to.have.length(0);
		// Soundness: the all-columns set must NOT be reported unique for a bag.
		expect(isUnique([0, 1], rel)).to.equal(false);
		expect(isUnique([0], rel)).to.equal(false);
	});

	it('proves a superkey via FD closure even when absent from the minimal list', () => {
		// {0} → {1}, {1} → {2}. Closure of {0} covers all 3 columns, but the
		// only seed FD whose closure covers everything is {0} (deriveKeysFromFds
		// minimizes to {0}). A caller asking about {0} (a proper subset) should
		// get true via the closure branch.
		const rel = makeRel({
			columnCount: 3,
			fds: [
				{ determinants: [0], dependents: [1], kind: 'unique' },
				{ determinants: [1], dependents: [2], kind: 'determination' },
			],
		});
		expect(isUnique([0], rel)).to.equal(true);
		// {1} only determines {2}, not {0} ⇒ not a superkey.
		expect(isUnique([1], rel)).to.equal(false);
	});

	it('keeps only minimal keys (drops supersets)', () => {
		// Declared key {0} plus an FD-implied key {0,1}; the latter is a superset
		// and must be dropped.
		const rel = makeRel({
			columnCount: 3,
			keys: [[{ index: 0 }]],
			fds: [{ determinants: [0], dependents: [1, 2], kind: 'unique' }],
		});
		expect(keyStrings(rel)).to.deep.equal(['0']);
	});

	it('empty key subsumes all other declared/FD keys', () => {
		const rel = makeRel({
			columnCount: 2,
			keys: [[], [{ index: 0 }]],
		});
		expect(keyStrings(rel)).to.deep.equal(['']);
	});
});
