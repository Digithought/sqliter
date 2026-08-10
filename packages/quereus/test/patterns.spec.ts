import { expect } from 'chai';
import {
	simpleLike,
	simpleGlob,
	compileLikeMatcher,
	compileGlobMatcher,
} from '../src/util/patterns.js';
import { Database } from '../src/index.js';

describe('pattern matching (util/patterns)', () => {
	// --- Semantics unchanged: LIKE ---
	describe('simpleLike semantics', () => {
		const cases: Array<[string, string, boolean]> = [
			['a%', 'apple', true],
			['A%', 'apple', false],       // case-sensitive by design
			['apple', 'APPLE', false],
			['_ra%', 'orange', true],
			['a_b', 'aäb', true],         // `_` matches one code point
			['_', '😀', true],            // non-BMP counts as one code point
			['%', '', true],
			['_', '', false],
			['', '', true],
			['', 'a', false],
			['12%', '1234', true],
		];
		for (const [pattern, text, expected] of cases) {
			it(`like(${JSON.stringify(pattern)}, ${JSON.stringify(text)}) === ${expected}`, () => {
				expect(simpleLike(pattern, text)).to.equal(expected);
			});
		}
	});

	// --- Semantics unchanged: GLOB ---
	describe('simpleGlob semantics', () => {
		const cases: Array<[string, string, boolean]> = [
			['ABC*', 'abcdef', false],    // case-sensitive
			['abc*', 'abcdef', true],
			['a*c', 'abbbc', true],
			['[abc]', 'a', true],
			['[abc]', 'd', false],
			['[a-c]', 'b', true],
			['[a-c]', 'd', false],
			['[^abc]', 'd', true],
			['[^abc]', 'a', false],
		];
		for (const [pattern, text, expected] of cases) {
			it(`glob(${JSON.stringify(pattern)}, ${JSON.stringify(text)}) === ${expected}`, () => {
				expect(simpleGlob(pattern, text)).to.equal(expected);
			});
		}

		it('invalid glob pattern (bad range) matches nothing, as before', () => {
			expect(simpleGlob('[z-a]', 'x')).to.equal(false);
		});
	});

	// --- Memoization: compile happens once per pattern ---
	describe('compile memoization', () => {
		it('returns the same matcher instance for repeated identical LIKE patterns', () => {
			// Reference identity proves the pattern was compiled once and reused —
			// the per-row scan does not rebuild the RegExp.
			const m1 = compileLikeMatcher('unique-like-%-pattern');
			const m2 = compileLikeMatcher('unique-like-%-pattern');
			expect(m1).to.equal(m2);
		});

		it('returns the same matcher instance for repeated identical GLOB patterns', () => {
			const g1 = compileGlobMatcher('unique-glob-*-pattern');
			const g2 = compileGlobMatcher('unique-glob-*-pattern');
			expect(g1).to.equal(g2);
		});

		it('returns distinct matchers for distinct patterns', () => {
			const a = compileLikeMatcher('distinct-a-%');
			const b = compileLikeMatcher('distinct-b-%');
			expect(a).to.not.equal(b);
		});

		it('LIKE and GLOB caches do not collide on identical strings', () => {
			// `[a-c]` is a character class in GLOB but three literal chars in LIKE.
			expect(simpleGlob('[a-c]', 'b')).to.equal(true);
			expect(simpleLike('[a-c]', 'b')).to.equal(false); // literal match only
			expect(simpleLike('[a-c]', '[a-c]')).to.equal(true);
		});

		it('cache is bounded — a flood of distinct patterns evicts the oldest', () => {
			// Cap is 256. Compile the probe, then flood with > cap distinct patterns
			// so the probe is evicted; recompiling it yields a fresh instance.
			const probe = 'evict-probe-%';
			const first = compileLikeMatcher(probe);
			for (let i = 0; i < 300; i++) {
				compileLikeMatcher(`flood-${i}-%`);
			}
			const afterFlood = compileLikeMatcher(probe);
			expect(afterFlood).to.not.equal(first);
		});
	});

	// --- Integration: emit-time literal fast path AND dynamic per-row path ---
	describe('LIKE operator end-to-end', () => {
		let db: Database;
		beforeEach(() => { db = new Database(); });
		afterEach(async () => { await db.close(); });

		async function collect(sql: string): Promise<unknown[]> {
			const rows: unknown[] = [];
			for await (const r of db.eval(sql)) rows.push(r);
			return rows;
		}

		it('literal-constant pattern (emit-time compiled) matches per row', async () => {
			await collect(`create table t (id integer primary key, name text)`);
			await collect(`insert into t values (1,'apple'),(2,'berry'),(3,'avocado')`);
			const rows = await collect(`select id from t where name like 'a%' order by id`);
			expect(rows).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('non-literal (per-row varying) pattern still matches via memoized path', async () => {
			await collect(`create table t (id integer primary key, name text, pat text)`);
			await collect(`insert into t values (1,'apple','a%'),(2,'berry','z%'),(3,'avocado','av%')`);
			// pattern operand is a column → not a literal → dynamic memoized path
			const rows = await collect(`select id from t where name like pat order by id`);
			expect(rows).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('NULL text and NULL pattern yield no match (NULL result)', async () => {
			await collect(`create table t (id integer primary key, name text)`);
			await collect(`insert into t values (1,'apple')`);
			expect(await collect(`select id from t where null like 'a%'`)).to.deep.equal([]);
			expect(await collect(`select id from t where 'apple' like null`)).to.deep.equal([]);
		});
	});
});
