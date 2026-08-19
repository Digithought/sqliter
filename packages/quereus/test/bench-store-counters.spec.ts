/**
 * Unit coverage for the one piece of ARITHMETIC in the benchmark harness's store
 * backend: `readStoreCounters` (`bench/lib/store-counters.mjs`), which turns
 * `CountingKVStore`'s raw fields into the four counts a `@store-mem` row reports.
 *
 * It earns its own file because `getCount` does not mean what it says. `CountingKVStore`
 * deliberately routes every key of a `getMany` batch through its own counted `get`, so
 * `getCount` already includes every batched key, and the reads that were genuinely one
 * key at a time are `getCount - getManyKeyCount`. That subtraction is the only place the
 * harness can silently produce a wrong number that still looks like a right one — and
 * `yarn bench` is not part of `yarn test`, so without this file the only thing checking
 * it is a person reading a table.
 *
 * Nothing here loads `@quereus/store`: `readStoreCounters` reads four numeric fields off
 * whatever it is handed, so the doubles below are those four fields and nothing else.
 * The module's `@quereus/store` import is lazy, so importing this function does not need
 * the store package built.
 */
import { expect } from 'chai';
import { readStoreCounters } from '../bench/lib/store-counters.mjs';

/** The four fields `readStoreCounters` reads off a counted store. */
interface CountedFields {
	iterateEntryCount: number;
	getCount: number;
	getManyCalls: number;
	getManyKeyCount: number;
}

/** A `CountingKVStore` reduced to what the function under test actually touches. */
function counted(fields: Partial<CountedFields>): CountedFields {
	return { iterateEntryCount: 0, getCount: 0, getManyCalls: 0, getManyKeyCount: 0, ...fields };
}

/** The map shape the real counting provider fills, built from doubles. */
function storesFrom(entries: Record<string, Partial<CountedFields>>) {
	const map = new Map<string, CountedFields>();
	for (const [name, fields] of Object.entries(entries)) map.set(name, counted(fields));
	return map as unknown as Parameters<typeof readStoreCounters>[0];
}

describe('bench/lib/store-counters.mjs', () => {
	describe('readStoreCounters', () => {
		it('derives singleGets by subtracting the keys batched reads already counted', () => {
			// The real shape of `filtered-scan-index-10k@store-mem`'s data store: one
			// batched read of ten keys and nothing else. `getCount` is 10 because the
			// wrapper's `getMany` routed all ten through its own `get` — so the count of
			// reads that were genuinely one key at a time is ZERO, not ten.
			const block = readStoreCounters(storesFrom({
				'main.bench_t': { getCount: 10, getManyCalls: 1, getManyKeyCount: 10 },
			}));
			expect(block['main.bench_t']).to.deep.equal({
				iterateEntries: 0,
				getManyCalls: 1,
				getManyKeys: 10,
				singleGets: 0,
			});
		});

		it('reports as singleGets only the reads no batch accounted for', () => {
			// The regression this metric exists to catch, mid-flight: eight of the twelve
			// gets came from two batches, so four were issued one at a time.
			const block = readStoreCounters(storesFrom({
				'main.bench_t': { getCount: 12, getManyCalls: 2, getManyKeyCount: 8 },
			}));
			expect(block['main.bench_t'].singleGets).to.equal(4);
		});

		it('keeps an opened-but-never-read store, with four zeros', () => {
			// A store that was opened and never read is a DIFFERENT claim from one that was
			// never opened (which is absent from the block entirely), and the comparison
			// reports an appeared or vanished path as loudly as a changed count. Pruning
			// the zeros would erase that distinction.
			const block = readStoreCounters(storesFrom({ __stats__: {} }));
			expect(block.__stats__).to.deep.equal({
				iterateEntries: 0, getManyCalls: 0, getManyKeys: 0, singleGets: 0,
			});
		});

		it('orders stores by name, so a results file reads the same way every run', () => {
			const block = readStoreCounters(storesFrom({
				'main.z_t': {}, __catalog__: {}, 'main.a_t': {},
			}));
			expect(Object.keys(block)).to.deep.equal(['__catalog__', 'main.a_t', 'main.z_t']);
		});

		it('throws, naming the store, when getCount falls below getManyKeyCount', () => {
			// Impossible while `CountingKVStore.getMany` routes its keys through the
			// wrapper's own `get`. This is the tripwire for that contract changing
			// underneath the harness, which would otherwise publish a negative `singleGets`
			// as if it were a count. A guard nobody has watched fail is not a guard.
			expect(() => readStoreCounters(storesFrom({
				'main.bench_t': { getCount: 3, getManyCalls: 1, getManyKeyCount: 10 },
			}))).to.throw(/'main\.bench_t'.*getCount \(3\).*getManyKeyCount \(10\)/);
		});
	});
});
