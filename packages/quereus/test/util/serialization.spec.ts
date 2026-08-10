import { expect } from 'chai';
import { describe, it } from 'mocha';
import { safeJsonStringify, jsonStringify, MAP_SUMMARY_ENTRY_CAP } from '../../src/util/serialization.js';

describe('safeJsonStringify Map rendering', () => {
	it('renders a Map as a bounded $map summary with size', () => {
		const m = new Map<string, number>([['a', 1], ['b', 2]]);
		const parsed = JSON.parse(safeJsonStringify(m)) as { $map: [string, unknown][]; size: number };
		expect(parsed.size).to.equal(2);
		expect(parsed.$map).to.deep.equal([['a', 1], ['b', 2]]);
	});

	it('renders entries in Map insertion order (not sorted by key)', () => {
		const m = new Map<string, number>();
		m.set('z', 26);
		m.set('a', 1);
		m.set('m', 13);
		const parsed = JSON.parse(safeJsonStringify(m)) as { $map: [string, unknown][] };
		expect(parsed.$map.map(([k]) => k)).to.deep.equal(['z', 'a', 'm']);
	});

	it('stringifies numeric (AttributeId-style) keys', () => {
		const m = new Map<number, string>([[5, 'five'], [42, 'answer']]);
		const parsed = JSON.parse(safeJsonStringify(m)) as { $map: [string, unknown][] };
		expect(parsed.$map).to.deep.equal([['5', 'five'], ['42', 'answer']]);
	});

	it('passes Map values back through the replacer (bigint handling)', () => {
		// One value fits in a safe integer (-> number), one overflows (-> string).
		const m = new Map<string, bigint>([['small', 7n], ['big', 9007199254740993n]]);
		const parsed = JSON.parse(safeJsonStringify(m)) as { $map: [string, unknown][]; size: number };
		expect(parsed.$map[0]).to.deep.equal(['small', 7]);
		expect(parsed.$map[1]).to.deep.equal(['big', '9007199254740993']);
		expect(parsed.size).to.equal(2);
	});

	it('handles nested Maps recursively', () => {
		const inner = new Map<string, number>([['x', 1]]);
		const outer = new Map<string, Map<string, number>>([['inner', inner]]);
		const parsed = JSON.parse(safeJsonStringify(outer)) as {
			$map: [string, { $map: [string, number][]; size: number }][];
			size: number;
		};
		expect(parsed.size).to.equal(1);
		expect(parsed.$map[0][0]).to.equal('inner');
		expect(parsed.$map[0][1]).to.deep.equal({ $map: [['x', 1]], size: 1 });
	});

	it('caps rendered entries at MAP_SUMMARY_ENTRY_CAP while size reports the true count', () => {
		const n = MAP_SUMMARY_ENTRY_CAP + 17;
		const m = new Map<number, number>();
		for (let i = 0; i < n; i++) m.set(i, i * 2);
		const parsed = JSON.parse(safeJsonStringify(m)) as { $map: [string, number][]; size: number };
		expect(parsed.size).to.equal(n);
		expect(parsed.$map).to.have.lengthOf(MAP_SUMMARY_ENTRY_CAP);
		// First N entries by insertion order are retained.
		expect(parsed.$map[0]).to.deep.equal(['0', 0]);
		const last = MAP_SUMMARY_ENTRY_CAP - 1;
		expect(parsed.$map[last]).to.deep.equal([String(last), last * 2]);
	});

	it('summarizes a Map nested inside a plain object', () => {
		const obj = { lineage: new Map<number, string>([[0, 'base'], [1, 'computed']]), other: 'x' };
		const parsed = JSON.parse(safeJsonStringify(obj)) as {
			lineage: { $map: [string, string][]; size: number };
			other: string;
		};
		expect(parsed.other).to.equal('x');
		expect(parsed.lineage).to.deep.equal({ $map: [['0', 'base'], ['1', 'computed']], size: 2 });
	});

	it('renders an empty Map as an empty summary', () => {
		const parsed = JSON.parse(safeJsonStringify(new Map())) as { $map: unknown[]; size: number };
		expect(parsed.$map).to.deep.equal([]);
		expect(parsed.size).to.equal(0);
	});

	it('still handles bigint and Uint8Array at the top level (no regression)', () => {
		expect(jsonStringify(7n)).to.equal('7');
		expect(jsonStringify(new Uint8Array([0xde, 0xad]))).to.equal('"0xdead"');
	});
});
