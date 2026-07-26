/**
 * Tests for key-builder utilities.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import {
	buildDataStoreName,
	buildIndexStoreName,
	buildStatsStoreName,
	buildStatsKey,
	buildDataKey,
	buildIndexKey,
	buildCatalogKey,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	buildFullScanBounds,
	buildIndexPrefixBounds,
	buildPkPrefixBounds,
	buildCatalogScanBounds,
	STORE_SUFFIX,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
} from '../src/common/key-builder.js';
import { compareBytes } from '../src/common/bytes.js';

const encoder = new TextEncoder();

/** Lone high surrogate — no low surrogate follows. Not encodable as UTF-8. */
const LONE_HIGH = '\uD800';
/** Lone low surrogate — no high surrogate precedes. Not encodable as UTF-8. */
const LONE_LOW = '\uDC00';
/** U+10000 — the same two code-unit ranges, legally PAIRED. Must keep working. */
const ASTRAL = '\u{10000}';

describe('key-builder', () => {
	describe('constants', () => {
		it('STORE_SUFFIX has INDEX and STATS', () => {
			expect(STORE_SUFFIX.INDEX).to.equal('_idx_');
			expect(STORE_SUFFIX.STATS).to.equal('_stats');
		});

		it('CATALOG_STORE_NAME is __catalog__', () => {
			expect(CATALOG_STORE_NAME).to.equal('__catalog__');
		});

		it('STATS_STORE_NAME is __stats__', () => {
			expect(STATS_STORE_NAME).to.equal('__stats__');
		});
	});

	describe('buildDataStoreName', () => {
		it('returns lowercase schema.table', () => {
			expect(buildDataStoreName('Main', 'Users')).to.equal('main.users');
		});

		it('preserves dots and underscores', () => {
			expect(buildDataStoreName('my_schema', 'my_table')).to.equal('my_schema.my_table');
		});

		it('rejects a lone high surrogate in the table name', () => {
			expect(() => buildDataStoreName('main', LONE_HIGH)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone low surrogate in the table name', () => {
			expect(() => buildDataStoreName('main', LONE_LOW)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone surrogate embedded mid-identifier', () => {
			expect(() => buildDataStoreName('main', `us${LONE_HIGH}ers`)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone surrogate in the schema name', () => {
			expect(() => buildDataStoreName(LONE_HIGH, 'users')).to.throw(/unpaired surrogate/i);
		});

		it('two table names differing only in a lone surrogate both throw instead of colliding', () => {
			// Pre-fix both produced distinct JS strings that a provider's UTF-8 encoding then
			// folded onto ONE physical store (LevelDB: `main.%EF%BF%BD` for both), so the two
			// tables silently shared storage. Refused at the builder now.
			expect(() => buildDataStoreName('main', '\uD800')).to.throw(/unpaired surrogate/i);
			expect(() => buildDataStoreName('main', '\uD801')).to.throw(/unpaired surrogate/i);
		});

		it('still accepts a well-formed astral character', () => {
			expect(buildDataStoreName('main', `t${ASTRAL}`)).to.equal(`main.t${ASTRAL}`);
		});
	});

	describe('buildIndexStoreName', () => {
		it('returns lowercase schema.table_idx_name', () => {
			expect(buildIndexStoreName('Main', 'Users', 'ByEmail')).to.equal('main.users_idx_byemail');
		});

		it('rejects a lone high surrogate in the index name', () => {
			expect(() => buildIndexStoreName('main', 'users', LONE_HIGH)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone low surrogate in the index name', () => {
			expect(() => buildIndexStoreName('main', 'users', LONE_LOW)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone surrogate embedded mid-identifier', () => {
			expect(() => buildIndexStoreName('main', 'users', `by${LONE_LOW}email`)).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone surrogate in the table name', () => {
			expect(() => buildIndexStoreName('main', LONE_HIGH, 'byemail')).to.throw(/unpaired surrogate/i);
		});

		it('rejects a lone surrogate in the schema name', () => {
			expect(() => buildIndexStoreName(LONE_HIGH, 'users', 'byemail')).to.throw(/unpaired surrogate/i);
		});

		it('still accepts a well-formed astral character', () => {
			expect(buildIndexStoreName('main', 'users', `by${ASTRAL}`)).to.equal(`main.users_idx_by${ASTRAL}`);
		});
	});

	describe('buildStatsStoreName (deprecated)', () => {
		it('returns lowercase schema.table_stats', () => {
			expect(buildStatsStoreName('Main', 'Users')).to.equal('main.users_stats');
		});
	});

	describe('buildStatsKey', () => {
		it('returns UTF-8 encoded lowercase schema.table', () => {
			const key = buildStatsKey('Main', 'Users');
			expect(key).to.deep.equal(encoder.encode('main.users'));
		});

		it('rejects a table name carrying an unpaired surrogate', () => {
			expect(() => buildStatsKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
		});
	});

	describe('buildDataKey', () => {
		it('encodes single value', () => {
			const key = buildDataKey([42]);
			expect(key).to.be.instanceOf(Uint8Array);
			expect(key.length).to.be.greaterThan(0);
		});

		it('encodes multiple values', () => {
			const key = buildDataKey([1, 'hello']);
			expect(key).to.be.instanceOf(Uint8Array);
			expect(key.length).to.be.greaterThan(0);
		});
	});

	describe('buildIndexKey', () => {
		it('concatenates index key and pk key', () => {
			const key = buildIndexKey(['alice'], [1]);
			const indexOnly = buildDataKey(['alice']);
			const pkOnly = buildDataKey([1]);
			expect(key.length).to.equal(indexOnly.length + pkOnly.length);
		});

		it('applies DESC direction independently to index and pk halves', () => {
			// Same index value, differing pk direction: the PK half should differ.
			const noDir = buildIndexKey(['x'], [1], undefined, [false], [false]);
			const pkDesc = buildIndexKey(['x'], [1], undefined, [false], [true]);
			const idxDesc = buildIndexKey(['x'], [1], undefined, [true], [false]);
			expect(noDir).to.not.deep.equal(pkDesc);
			expect(noDir).to.not.deep.equal(idxDesc);
			expect(pkDesc).to.not.deep.equal(idxDesc);
		});
	});

	describe('buildDataKey with DESC direction', () => {
		it('PK DESC reverses byte-lex order', () => {
			const k1 = buildDataKey([1], undefined, [true]);
			const k2 = buildDataKey([2], undefined, [true]);
			const k3 = buildDataKey([3], undefined, [true]);
			// 3 < 2 < 1 in bytes
			const cmp = (a: Uint8Array, b: Uint8Array) => {
				for (let i = 0; i < Math.min(a.length, b.length); i++) {
					if (a[i] !== b[i]) return a[i] - b[i];
				}
				return a.length - b.length;
			};
			expect(cmp(k3, k2)).to.be.lessThan(0);
			expect(cmp(k2, k1)).to.be.lessThan(0);
		});

		it('composite PK mixed (ASC, DESC) preserves expected ordering', () => {
			// (category ASC, seq DESC): ('a',3) < ('a',2) < ('a',1) < ('b',3) ...
			const keys = [
				buildDataKey(['a', 1], undefined, [false, true]),
				buildDataKey(['a', 2], undefined, [false, true]),
				buildDataKey(['a', 3], undefined, [false, true]),
				buildDataKey(['b', 1], undefined, [false, true]),
			];
			const cmp = (a: Uint8Array, b: Uint8Array) => {
				for (let i = 0; i < Math.min(a.length, b.length); i++) {
					if (a[i] !== b[i]) return a[i] - b[i];
				}
				return a.length - b.length;
			};
			expect(cmp(keys[2], keys[1])).to.be.lessThan(0);
			expect(cmp(keys[1], keys[0])).to.be.lessThan(0);
			expect(cmp(keys[0], keys[3])).to.be.lessThan(0);
		});
	});

	describe('buildCatalogKey', () => {
		it('returns UTF-8 encoded lowercase schema.table', () => {
			const key = buildCatalogKey('Main', 'Users');
			expect(key).to.deep.equal(encoder.encode('main.users'));
		});

		it('rejects a table name carrying an unpaired surrogate', () => {
			expect(() => buildCatalogKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
		});

		it('rejects a schema name carrying an unpaired surrogate', () => {
			expect(() => buildCatalogKey('\uD800', 'users')).to.throw(/unpaired surrogate/i);
		});

		it('two names differing only in a lone surrogate no longer collide — the second throws instead', () => {
			// Pre-fix, both `buildCatalogKey('main', '\uD800')` and `buildCatalogKey('main', '\uD801')`
			// encoded to the identical UTF-8 bytes (U+FFFD folding), so the second CREATE TABLE's
			// catalog write silently clobbered the first. Both now throw instead of colliding.
			expect(() => buildCatalogKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
			expect(() => buildCatalogKey('main', '\uD801')).to.throw(/unpaired surrogate/i);
		});
	});

	describe('buildViewCatalogKey', () => {
		it('rejects a view name carrying an unpaired surrogate', () => {
			expect(() => buildViewCatalogKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
		});
	});

	describe('buildMaterializedViewCatalogKey', () => {
		it('rejects a materialized-view name carrying an unpaired surrogate', () => {
			expect(() => buildMaterializedViewCatalogKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
		});
	});

	describe('buildFullScanBounds', () => {
		it('returns unbounded scan (gte=empty, no lt)', () => {
			// Must not cap at 0xff: inverted NULL type prefix (0x00 ^ 0xff = 0xff)
			// for DESC columns would otherwise be excluded.
			const bounds = buildFullScanBounds();
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect((bounds as { lt?: Uint8Array }).lt).to.be.undefined;
		});
	});

	describe('buildIndexPrefixBounds', () => {
		it('returns unbounded full scan for empty prefix (no 0xff cap)', () => {
			// Index stores are per-index, so a full index scan must not cap at
			// [0xff]: a leading DESC NULL column encodes with a 0xff type byte and
			// would otherwise be excluded.
			const bounds = buildIndexPrefixBounds([]);
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.be.undefined;
		});

		it('returns prefix-based range for non-empty prefix', () => {
			const bounds = buildIndexPrefixBounds(['alice']);
			expect(bounds.gte.length).to.be.greaterThan(0);
			expect(bounds.lt!.length).to.be.greaterThan(0);
			// lt should be greater than gte
			const gteHex = Array.from(bounds.gte).map(b => b.toString(16).padStart(2, '0')).join('');
			const ltHex = Array.from(bounds.lt!).map(b => b.toString(16).padStart(2, '0')).join('');
			expect(ltHex > gteHex).to.be.true;
		});

		it('omits lt for an all-0xff prefix (leading DESC NULL)', () => {
			// NULL encodes as [0x00]; DESC inversion yields [0xff] — no finite
			// exclusive upper bound exists above an all-0xff prefix.
			const bounds = buildIndexPrefixBounds([null], undefined, [true]);
			expect(bounds.gte).to.deep.equal(new Uint8Array([0xff]));
			expect(bounds.lt).to.be.undefined;
		});
	});

	describe('buildPkPrefixBounds', () => {
		/** True when `key` falls within [gte, lt). */
		const within = (key: Uint8Array, bounds: { gte: Uint8Array; lt?: Uint8Array }): boolean =>
			compareBytes(key, bounds.gte) >= 0
			&& (bounds.lt === undefined || compareBytes(key, bounds.lt) < 0);

		/**
		 * Assert the bounds window selects exactly the keys whose row shares the
		 * prefix values — the property every consumer relies on.
		 */
		function expectExactSlice(
			rows: SqlValue[][],
			prefix: SqlValue[],
			matching: (row: SqlValue[]) => boolean,
			directions?: boolean[],
			collations?: (string | undefined)[],
		): void {
			const bounds = buildPkPrefixBounds(prefix, undefined, directions, collations);
			for (const row of rows) {
				const key = buildDataKey(row, undefined, directions, collations);
				expect(within(key, bounds)).to.equal(
					matching(row),
					`row [${row.join(', ')}] vs prefix [${prefix.join(', ')}]`,
				);
			}
		}

		it('empty prefix yields full-scan bounds (no 0xff cap)', () => {
			const bounds = buildPkPrefixBounds([]);
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.be.undefined;
		});

		it('integer prefix selects exactly the prefix-equal slice', () => {
			const rows: SqlValue[][] = [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'z'], [3, 'a']];
			expectExactSlice(rows, [2], r => r[0] === 2);
		});

		it('multi-column prefix selects exactly the prefix-equal slice', () => {
			const rows: SqlValue[][] = [
				['a', 1, 'x'], ['a', 1, 'y'], ['a', 2, 'x'], ['b', 1, 'x'], ['b', 2, 'y'],
			];
			expectExactSlice(rows, ['a', 1], r => r[0] === 'a' && r[1] === 1);
		});

		it('text prefix with embedded NUL and escape bytes stays exact', () => {
			// 'a\x00' and 'a\x01' exercise the NUL-termination escaping: the encoded
			// prefix of 'a' must NOT swallow 'a\x00b' (a distinct, longer first column).
			const rows: SqlValue[][] = [
				['a', 1], ['a\x00b', 1], ['a\x01b', 1], ['ab', 1], ['b', 1],
			];
			expectExactSlice(rows, ['a'], r => r[0] === 'a');
			expectExactSlice(rows, ['a\x00b'], r => r[0] === 'a\x00b');
			expectExactSlice(rows, ['a\x01b'], r => r[0] === 'a\x01b');
		});

		it('DESC leading column selects exactly the prefix-equal slice', () => {
			const rows: SqlValue[][] = [[1, 'a'], [2, 'a'], [2, 'b'], [3, 'a']];
			expectExactSlice(rows, [2], r => r[0] === 2, [true, false]);
		});

		it('NOCASE per-column collation folds case in the window', () => {
			// Keys are encoded NOCASE: 'Alice' and 'alice' share key bytes, so a
			// prefix of either selects both spellings; 'bob' stays outside.
			const rows: SqlValue[][] = [['alice', 1], ['Alice', 2], ['bob', 1]];
			expectExactSlice(
				rows,
				['ALICE'],
				r => (r[0] as string).toLowerCase() === 'alice',
				undefined,
				['NOCASE'],
			);
		});

		it('omits lt for an all-0xff prefix (leading DESC NULL) instead of an empty window', () => {
			const bounds = buildPkPrefixBounds([null], undefined, [true]);
			expect(bounds.gte).to.deep.equal(new Uint8Array([0xff]));
			expect(bounds.lt).to.be.undefined;
			// The NULL-prefixed key still falls inside the window.
			const key = buildDataKey([null, 5], undefined, [true, false]);
			expect(within(key, bounds)).to.be.true;
		});
	});

	describe('buildCatalogScanBounds', () => {
		it('returns full scan without schema filter', () => {
			const bounds = buildCatalogScanBounds();
			expect(bounds.gte).to.deep.equal(new Uint8Array(0));
			expect(bounds.lt).to.deep.equal(new Uint8Array([0xff]));
		});

		it('returns schema-prefixed range with filter', () => {
			const bounds = buildCatalogScanBounds('Main');
			const prefix = encoder.encode('main.');
			expect(bounds.gte).to.deep.equal(prefix);
			expect(bounds.lt.length).to.be.greaterThan(0);
		});
	});
});

