import { expect } from 'chai';
import {
	validateReservedTags,
	getReservedTag,
	getReservedTagByTemplate,
	RESERVED_TAGS,
	type TagSite,
} from '../../src/schema/reserved-tags.js';
import type { SqlValue } from '../../src/common/types.js';

/** Validate `tags` at `site` and return the diagnostics. */
function check(tags: Record<string, SqlValue>, site: TagSite) {
	return validateReservedTags(tags, site);
}

describe('Reserved tag registry', () => {
	describe('namespace gate', () => {
		it('passes free-form user tags through untouched', () => {
			const diags = check({ display_name: 'X', audit: true }, 'logical-table');
			expect(diags).to.have.length(0);
		});

		it('ignores user tags even alongside reserved ones', () => {
			const diags = check(
				{ display_name: 'X', 'quereus.id': 'v-1' },
				'view-ddl',
			);
			expect(diags).to.have.length(0);
		});

		it('returns no diagnostics for undefined tags', () => {
			expect(validateReservedTags(undefined, 'logical-table')).to.have.length(0);
		});
	});

	describe('unknown-reserved-tag', () => {
		it('flags a typo on an exact key', () => {
			const diags = check({ 'quereus.update.taget': 'a' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('unknown reserved tag');
		});

		it('flags a typo on a templated key', () => {
			const diags = check({ 'quereus.lens.akc.x': 'r' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});

		it('treats an empty template remainder as unknown (lens.access.)', () => {
			const diags = check({ 'quereus.lens.access.': 'lookup' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});

		it('treats an empty template remainder as unknown (lens.ack.)', () => {
			const diags = check({ 'quereus.lens.ack.': 'r' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('removed routing keys (target / exclude / delete_via / policy) are unknown everywhere', () => {
		// These four `quereus.update.*` routing keys were removed — routing is now
		// expressed per-row by writable presence/membership columns, not a tag. A stray
		// occurrence is the standard hard `unknown-reserved-tag` error at any site
		// (the registry is the single source of truth; no other call site special-cases
		// them). See ticket `remove-update-routing-tag-surface`.
		const REMOVED = [
			['quereus.update.target', 'base_a'],
			['quereus.update.exclude', 'base_b'],
			['quereus.update.delete_via', 'left_delete'],
			['quereus.update.policy', 'strict'],
		] as const;
		const SITES: TagSite[] = ['view-ddl', 'dml-stmt', 'physical-table'];

		for (const [key, value] of REMOVED) {
			for (const site of SITES) {
				it(`${key} @ ${site} → unknown-reserved-tag`, () => {
					const diags = check({ [key]: value }, site);
					expect(diags).to.have.length(1);
					expect(diags[0].reason).to.equal('unknown-reserved-tag');
					expect(diags[0].severity).to.equal('error');
				});
			}
		}
	});

	describe('tag-not-allowed-here', () => {
		it('rejects quereus.id on a logical-table site', () => {
			// The rename hints are legal only at the physical declarative sites + view-ddl.
			const diags = check({ 'quereus.id': 'tbl-1' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('not allowed');
		});

		it('rejects lens.ack on a view DDL site', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': 'r' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});

		it('rejects lens.access on a DML statement site', () => {
			const diags = check({ 'quereus.lens.access.vin': 'lookup' }, 'dml-stmt');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});
	});

	describe('invalid-tag-value: enum', () => {
		it('rejects an out-of-set lens.decomp.role (error)', () => {
			const diags = check({ 'quereus.lens.decomp.role.d1': 'bogus' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('invalid value');
		});

		it('rejects an out-of-set lens.decomp.presence (error)', () => {
			const diags = check({ 'quereus.lens.decomp.presence.d1': 'sometimes' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('accepts every enum member', () => {
			expect(check({ 'quereus.lens.decomp.role.d1': 'primary-storage' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.lens.decomp.role.d1': 'auxiliary-access' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.lens.decomp.presence.d1': 'mandatory' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.lens.decomp.presence.d1': 'optional' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.lens.decomp.keykind.d1': 'surrogate' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.lens.decomp.keykind.d1': 'logical-tuple' }, 'physical-table')).to.have.length(0);
		});
	});

	describe('invalid-tag-value: csv-of-identifiers', () => {
		it('accepts a comma-separated identifier list', () => {
			expect(check({ 'quereus.lens.decomp.key.d1': 'col_a, col_b' }, 'physical-table')).to.have.length(0);
		});

		it('rejects an empty value (error)', () => {
			const diags = check({ 'quereus.lens.decomp.key.d1': '' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('rejects an empty segment (error)', () => {
			const diags = check({ 'quereus.lens.decomp.key.d1': 'a, , b' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
		});
	});

	describe('invalid-tag-value: required-nonempty-rationale (warning)', () => {
		it('warns on an empty rationale', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': '' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('warning');
		});

		it('warns on a whitespace-only rationale', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': '   ' }, 'logical-constraint');
			expect(diags).to.have.length(1);
			expect(diags[0].severity).to.equal('warning');
		});

		it('accepts a non-empty rationale with no diagnostic', () => {
			const diags = check(
				{ 'quereus.lens.ack.no-backing-index:vin': 'low-write table; commit-time scan is acceptable' },
				'logical-table',
			);
			expect(diags).to.have.length(0);
		});
	});

	describe('invalid-tag-value: string', () => {
		it('accepts a lens.access hint at a logical table', () => {
			expect(check({ 'quereus.lens.access.vin': 'lookup' }, 'logical-table')).to.have.length(0);
		});

		it('rejects a non-text quereus.id value (error)', () => {
			const diags = check({ 'quereus.id': 42 }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});
	});

	describe('quereus.expose_implicit_index (boolean, constraint-only)', () => {
		it('accepts a boolean value at the physical-constraint site', () => {
			expect(check({ 'quereus.expose_implicit_index': true }, 'physical-constraint')).to.have.length(0);
			expect(check({ 'quereus.expose_implicit_index': false }, 'physical-constraint')).to.have.length(0);
		});

		it('rejects a non-boolean value (error)', () => {
			// catalog.ts reads it via a strict `=== true`, so only a real boolean is meaningful.
			const diags = check({ 'quereus.expose_implicit_index': 'true' }, 'physical-constraint');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('is not allowed on a table / column / index site (constraint-only)', () => {
			for (const site of ['physical-table', 'physical-column', 'physical-index'] as const) {
				const diags = check({ 'quereus.expose_implicit_index': true }, site);
				expect(diags, `expose_implicit_index @ ${site}`).to.have.length(1);
				expect(diags[0].reason).to.equal('tag-not-allowed-here');
			}
		});

		it('flags a typo as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.expose_implicit_indx': true }, 'physical-constraint');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('quereus.engine_managed (boolean, table-only)', () => {
		it('accepts a boolean value at the physical-table site', () => {
			expect(check({ 'quereus.engine_managed': true }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.engine_managed': false }, 'physical-table')).to.have.length(0);
		});

		it('rejects a non-boolean value (error)', () => {
			// catalog.ts reads it via a strict `=== true`, so only a real boolean is meaningful.
			const diags = check({ 'quereus.engine_managed': 'true' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('is not allowed on a column / constraint / index site (table-only)', () => {
			for (const site of ['physical-column', 'physical-constraint', 'physical-index', 'logical-column'] as const) {
				const diags = check({ 'quereus.engine_managed': true }, site);
				expect(diags, `engine_managed @ ${site}`).to.have.length(1);
				expect(diags[0].reason).to.equal('tag-not-allowed-here');
			}
		});

		it('flags a typo as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.engine_managd': true }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('quereus.lens.writable (boolean, logical-column only)', () => {
		it('accepts a boolean value at the logical-column site', () => {
			expect(check({ 'quereus.lens.writable': true }, 'logical-column')).to.have.length(0);
			expect(check({ 'quereus.lens.writable': false }, 'logical-column')).to.have.length(0);
		});

		it('rejects a non-boolean value (error)', () => {
			// The prover reads it via a strict `=== true`, so only a real boolean is meaningful.
			const diags = check({ 'quereus.lens.writable': 'yes' }, 'logical-column');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('is not allowed on a logical-table / logical-constraint / physical-column site (logical-column only)', () => {
			for (const site of ['logical-table', 'logical-constraint', 'physical-column'] as const) {
				const diags = check({ 'quereus.lens.writable': true }, site);
				expect(diags, `writable @ ${site}`).to.have.length(1);
				expect(diags[0].reason).to.equal('tag-not-allowed-here');
			}
		});

		it('flags a typo as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.lens.writabl': true }, 'logical-column');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('quereus.sync.replicate (boolean, view-ddl + physical-table)', () => {
		it('accepts a boolean value at the view-ddl and physical-table sites', () => {
			// The two authoring forms of a migration target: the materialized-view
			// form (view-ddl) and the canonical `create table … maintained as` form
			// (physical-table). Both true/false are well-shaped.
			for (const site of ['view-ddl', 'physical-table'] as const) {
				expect(check({ 'quereus.sync.replicate': true }, site), `replicate true @ ${site}`).to.have.length(0);
				expect(check({ 'quereus.sync.replicate': false }, site), `replicate false @ ${site}`).to.have.length(0);
			}
		});

		it('rejects a non-boolean value (error)', () => {
			// The store host reads it via a strict `=== true`, so only a real boolean is meaningful.
			const diags = check({ 'quereus.sync.replicate': 'true' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('is not allowed on a logical-column / logical-table site (governs a physical backing)', () => {
			for (const site of ['logical-column', 'logical-table'] as const) {
				const diags = check({ 'quereus.sync.replicate': true }, site);
				expect(diags, `replicate @ ${site}`).to.have.length(1);
				expect(diags[0].reason).to.equal('tag-not-allowed-here');
			}
		});

		it('flags a typo as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.sync.replicat': true }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('quereus.sync.evict (eviction-policy, view-ddl + physical-table)', () => {
		it('accepts \'never\', \'immediate\', and a non-negative ms (number or numeric string)', () => {
			for (const site of ['view-ddl', 'physical-table'] as const) {
				expect(check({ 'quereus.sync.evict': 'never' }, site), `never @ ${site}`).to.have.length(0);
				expect(check({ 'quereus.sync.evict': 'immediate' }, site), `immediate @ ${site}`).to.have.length(0);
				expect(check({ 'quereus.sync.evict': 86400000 }, site), `ms number @ ${site}`).to.have.length(0);
				expect(check({ 'quereus.sync.evict': '86400000' }, site), `ms string @ ${site}`).to.have.length(0);
				expect(check({ 'quereus.sync.evict': 0 }, site), `0 @ ${site}`).to.have.length(0);
			}
		});

		it('accepts the keyword case-insensitively', () => {
			expect(check({ 'quereus.sync.evict': 'Never' }, 'physical-table')).to.have.length(0);
			expect(check({ 'quereus.sync.evict': 'IMMEDIATE' }, 'physical-table')).to.have.length(0);
		});

		it('rejects a bad keyword / negative number (error)', () => {
			for (const bad of ['eventually', -1, 'soon', true] as const) {
				const diags = check({ 'quereus.sync.evict': bad }, 'physical-table');
				expect(diags, `bad value ${String(bad)}`).to.have.length(1);
				expect(diags[0].reason).to.equal('invalid-tag-value');
				expect(diags[0].severity).to.equal('error');
			}
		});

		it('is not allowed on a logical-column / logical-table site (governs a basis table)', () => {
			for (const site of ['logical-column', 'logical-table'] as const) {
				const diags = check({ 'quereus.sync.evict': 'never' }, site);
				expect(diags, `evict @ ${site}`).to.have.length(1);
				expect(diags[0].reason).to.equal('tag-not-allowed-here');
			}
		});

		it('flags a typo as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.sync.evic': 'never' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('getReservedTag (typed, exact key)', () => {
		it('reads a string value verbatim', () => {
			const tags = { 'quereus.lens.policy.error-on': 'lens.no-backing-index' };
			expect(getReservedTag(tags, 'quereus.lens.policy.error-on')).to.equal('lens.no-backing-index');
		});

		it('returns undefined for an absent key', () => {
			expect(getReservedTag({}, 'quereus.lens.policy.error-on')).to.be.undefined;
		});

		it('returns undefined for a null value', () => {
			expect(getReservedTag({ 'quereus.id': null }, 'quereus.id')).to.be.undefined;
		});
	});

	describe('getReservedTagByTemplate', () => {
		it('enumerates lens.ack instances with their code segment', () => {
			const tags = {
				'quereus.lens.ack.no-backing-index': 'r1',
				'quereus.lens.ack.weak-inverse': 'r2',
				display_name: 'ignored',
			};
			const instances = getReservedTagByTemplate(tags, 'quereus.lens.ack.<code>');
			expect(instances.map(i => i.segment).sort()).to.deep.equal(['no-backing-index', 'weak-inverse']);
		});

		it('captures the whole remainder of a lens.ack code (including :target)', () => {
			const tags = { 'quereus.lens.ack.no-backing-index:vin': 'rationale' };
			const instances = getReservedTagByTemplate(tags, 'quereus.lens.ack.<code>');
			expect(instances).to.have.length(1);
			expect(instances[0].segment).to.equal('no-backing-index:vin');
			expect(instances[0].value).to.equal('rationale');
		});

		it('skips an empty remainder', () => {
			const instances = getReservedTagByTemplate({ 'quereus.lens.ack.': 'r' }, 'quereus.lens.ack.<code>');
			expect(instances).to.have.length(0);
		});
	});

	describe('the retired quereus.update.default_for key is unknown everywhere', () => {
		// The first-class `with defaults (col = expr, …)` view clause replaced the
		// tag (docs/vu-inverses.md § View defaults). Like the routing
		// keys before it, a stray occurrence is the standard hard unknown-reserved-tag
		// error at every site — including its former homes (view-ddl / dml-stmt).
		const SITES: TagSite[] = ['view-ddl', 'dml-stmt', 'logical-table', 'physical-table'];
		for (const site of SITES) {
			it(`quereus.update.default_for.created @ ${site} → unknown-reserved-tag`, () => {
				const diags = check({ 'quereus.update.default_for.created': "epoch_ms('now')" }, site);
				expect(diags).to.have.length(1);
				expect(diags[0].reason).to.equal('unknown-reserved-tag');
				expect(diags[0].severity).to.equal('error');
			});
		}

		it('the removed routing keys are unknown at a DML statement site', () => {
			expect(check({ 'quereus.update.target': 'base_a' }, 'dml-stmt')[0].reason).to.equal('unknown-reserved-tag');
			expect(check({ 'quereus.update.exclude': 'base_b' }, 'dml-stmt')[0].reason).to.equal('unknown-reserved-tag');
			expect(check({ 'quereus.update.delete_via': 'left_delete' }, 'dml-stmt')[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('rename hints + physical declarative sites (differ path)', () => {
		const PHYSICAL_SITES: TagSite[] = [
			'physical-table',
			'physical-column',
			'view-ddl',
			'physical-index',
			'physical-constraint',
		];

		it('accepts quereus.id at every physical declarative site (incl. a hyphenated value)', () => {
			for (const site of PHYSICAL_SITES) {
				// The hyphenated value guards the `'string'` (NOT csv-of-identifiers)
				// decision — `'tbl-thing'` is a real id in 50.2-declare-schema-renames.
				expect(check({ 'quereus.id': 'tbl-thing' }, site), `quereus.id at ${site}`)
					.to.have.length(0);
			}
		});

		it('accepts quereus.previous_name at every physical declarative site', () => {
			for (const site of PHYSICAL_SITES) {
				expect(check({ 'quereus.previous_name': 'old_a, old_b' }, site), `previous_name at ${site}`)
					.to.have.length(0);
			}
		});

		it('flags a typo on previous_name as a single unknown-reserved-tag error', () => {
			const diags = check({ 'quereus.previuos_name': 'old' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
		});

		it('flags a typo on update.target at a physical site as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.update.taget': 'Car' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
		});

		it('keeps quereus.lens.decomp.* valid at physical-table (no regression)', () => {
			expect(check({ 'quereus.lens.decomp.role.d1': 'primary-storage' }, 'physical-table'))
				.to.have.length(0);
		});

		it('rejects a non-column-legal reserved key on a physical column', () => {
			// quereus.lens.access.<col> is logical-table only; mis-placed on a physical
			// column it is tag-not-allowed-here rather than silently escaping.
			const diags = check({ 'quereus.lens.access.x': 'lookup' }, 'physical-column');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});
	});

	describe('RESERVED_TAGS table', () => {
		it('is deeply frozen (array, each spec, and each spec.sites)', () => {
			expect(Object.isFrozen(RESERVED_TAGS)).to.equal(true);
			for (const spec of RESERVED_TAGS) {
				expect(Object.isFrozen(spec), `spec ${JSON.stringify(spec.key)} frozen`).to.equal(true);
				expect(Object.isFrozen(spec.sites), `spec ${JSON.stringify(spec.key)} sites frozen`).to.equal(true);
			}
		});

		it('seeds all documented keys (rename hints + expose_implicit_index + engine_managed + sync replicate/evict + lens advisory + writable intent + escalation policy + lens decomposition families)', () => {
			// 2 rename hints (quereus.id / quereus.previous_name) + 1 quereus.expose_implicit_index
			// + 1 quereus.engine_managed + 1 quereus.sync.replicate + 1 quereus.sync.evict
			// + 2 quereus.lens.{ack,access} + 1 quereus.lens.writable + 2 quereus.lens.policy.*
			// + 9 quereus.lens.decomp.* = 20.
			expect(RESERVED_TAGS).to.have.length(20);
			const keys = RESERVED_TAGS.map(s => (typeof s.key === 'string' ? s.key : s.key.template));
			expect(keys).to.include('quereus.id');
			expect(keys).to.include('quereus.previous_name');
			expect(keys).to.include('quereus.expose_implicit_index');
			expect(keys).to.include('quereus.engine_managed');
			expect(keys).to.include('quereus.sync.replicate');
			expect(keys).to.include('quereus.sync.evict');
			expect(keys).to.include('quereus.lens.writable');
			expect(keys).to.include('quereus.lens.policy.error-on');
			expect(keys).to.include('quereus.lens.policy.require-ack');
			expect(keys).to.include('quereus.lens.decomp.role.<id>');
			expect(keys).to.include('quereus.lens.decomp.col.<id_dot_column>');
			// The whole quereus.update.* family is gone (routing keys first, then default_for).
			expect(keys).to.not.include('quereus.update.default_for.<column>');
			expect(keys).to.not.include('quereus.update.target');
			expect(keys).to.not.include('quereus.update.exclude');
			expect(keys).to.not.include('quereus.update.delete_via');
			expect(keys).to.not.include('quereus.update.policy');
		});
	});
});
