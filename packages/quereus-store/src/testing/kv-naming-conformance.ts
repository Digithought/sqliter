/**
 * Shared physical-store-name distinctness battery — test-support; run under Mocha.
 *
 * Third sibling of {@link runKVStoreConformance} (the {@link KVStore} contract) and
 * {@link runKVProviderConformance} (the atomic multi-store commit). This one asserts a
 * single PROVIDER-level property that every backend must hold:
 *
 *   Two logical stores the engine considers distinct never share one physical store.
 *
 * Why it exists as a shared battery rather than a per-plugin test: the engine's only
 * collision guard, `StoreModule.assertStoreNameFree`, compares LOGICAL store names
 * (`{schema}.{table}` from `buildDataStoreName`) as plain JS strings. That guard stands
 * in for a physical collision check only while each provider's translation from the
 * logical name to its own native name (a LevelDB sublevel, an IndexedDB object store, a
 * SQLite table, an on-device LevelDB file) is INJECTIVE — two different logical names can
 * never come out the same. A provider that lowercases, strips punctuation, or otherwise
 * folds characters breaks that silently: two `create table`s both succeed and their rows
 * then interleave in one physical store. Nothing in the type system prevents the next
 * provider from reintroducing it, so the property is pinned behaviorally here.
 *
 * The battery needs nothing beyond the public {@link KVStoreProvider} surface, so it runs
 * for every backend: it writes a distinct marker into each store under ONE shared key and
 * checks each store still reads back its own marker. Two entries sharing a physical store
 * show up as one marker having overwritten another.
 *
 * A provider MAY reject a name its native namespace cannot represent — a throw from
 * `getStore`/`getIndexStore` passes that entry, and the rejected entries are reported so
 * the corpus cannot silently shrink to nothing. Silently folding two names onto one store
 * never passes. Entries marked {@link StoreSpec.mustAccept} (logical names using only
 * `[a-z0-9_.]`, which any KV namespace can represent) may not be rejected at all.
 *
 * Dependency and Mocha-global handling mirror kv-conformance.ts — see its header.
 *
 * NOTE: this asserts distinctness, not decodability. An injective encoding is what the
 * property needs; nothing here requires a provider to be able to recover the logical name
 * from the physical one, and no shipped provider does.
 *
 * NOTE: the marker check reads back through the very handles it wrote through, so a
 * provider that (a) caches one read-your-own-writes handle PER LOGICAL NAME — as
 * `IndexedDBProvider` does, wrapping each store in `CachedKVStore` — and (b) folds two
 * logical names onto one physical store BELOW that cache would serve each marker from its
 * own cache and pass. No shipped provider does both: the only caching provider names its
 * object stores verbatim, so its folding (if any) would happen at the cache key and be
 * caught. If a provider ever gains a lossy escape underneath a per-name cache, re-read the
 * markers through handles reopened after `closeStore`/`closeIndexStore` instead.
 */

import assert from 'node:assert/strict';
import type { KVStore, KVStoreProvider } from '../common/kv-store.js';
import { assertBytes, b } from './kv-assert.js';

// Module-local Mocha globals — see the same block in kv-conformance.ts for why these
// are declared per-module rather than pulled from @types/mocha.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const beforeEach: (fn: () => void | Promise<void>) => void;
declare const afterEach: (fn: () => void | Promise<void>) => void;

/**
 * Per-backend lifecycle adapter. The suite drives its own per-test lifecycle and calls
 * {@link makeNamingBackend} fresh for every test, so state never leaks between tests.
 */
export interface KVNamingBackend {
	/** Open a provider over a fresh, EMPTY physical keyspace. Called once per test. */
	open(): Promise<KVStoreProvider>;
	/** Release everything open() created (close the provider, rm dirs / delete dbs). */
	teardown(): Promise<void>;
}

/**
 * One logical store in the corpus — a table's data store, or (when `index` is set) one of
 * its secondary-index stores.
 */
interface StoreSpec {
	/** Human-readable identity, also the marker value written into the store. Unique. */
	readonly label: string;
	readonly schema: string;
	readonly table: string;
	/** Set for an index store; omitted for a data store. */
	readonly index?: string;
	/**
	 * True when the logical name uses only `[a-z0-9_.]` — representable in any conceivable
	 * native namespace, so a provider rejecting it is a defect rather than an honest
	 * "cannot represent this name".
	 */
	readonly mustAccept?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The single key every store's marker is written under. */
const MARKER_KEY = b(0x01);

/**
 * Logical stores that must all land on DIFFERENT physical stores.
 *
 * Every name here is one the shared builders accept (no unpaired surrogates — those are
 * refused above every provider by `assertKeyableIdentifiers`). The awkward ones are chosen
 * to break a specific plausible encoding:
 *
 *   - `a-b` / `a b` / `a.b` / `a_b` — collapse onto each other under any "fold everything
 *     outside `[a-zA-Z0-9_]` to `_`" sanitizer.
 *   - `café` / `weißbier` — non-ASCII, which a byte-range filter drops or folds.
 *   - `o'brien` — the quote character a SQL-identifier encoding has to deal with.
 *   - index `x` on `t` vs. index `x` on `t2` — an index store name must carry its table.
 *   - `other.t` vs `main.t` — same table name, different schema.
 *
 * Two near-miss pairs are deliberately ABSENT, because they compose to ONE logical name at
 * the BUILDER — so no provider can tell them apart and asserting distinctness here would
 * pin a failure nobody can fix. Both are guarded above the provider instead:
 *
 *   - schema `x` + table `y.z` vs. schema `x.y` + table `z` (both `x.y.z`) — a documented
 *     limitation of the `.`-joined name; see the NOTE on `buildDataStoreName`.
 *   - a table literally named `t_idx_x` vs. index `x` on table `t` (both `main.t_idx_x`) —
 *     `_idx_` is a legal substring of an ordinary identifier, so the join is likewise not
 *     boundary-safe. `StoreModuleBase.assertStoreNameFree` rejects whichever of the two is
 *     created second, which is what keeps them from ever coexisting.
 */
const DISTINCT_STORES: readonly StoreSpec[] = [
	{ label: 'main.t', schema: 'main', table: 't', mustAccept: true },
	{ label: 'main.t2', schema: 'main', table: 't2', mustAccept: true },
	{ label: 'main.a_b', schema: 'main', table: 'a_b', mustAccept: true },
	{ label: 'other.t', schema: 'other', table: 't', mustAccept: true },
	{ label: 'main.t_idx_x (index x on table t)', schema: 'main', table: 't', index: 'x', mustAccept: true },
	{ label: 'main.t2_idx_x (index x on table t2)', schema: 'main', table: 't2', index: 'x', mustAccept: true },
	{ label: 'main.a-b', schema: 'main', table: 'a-b' },
	{ label: 'main.a b', schema: 'main', table: 'a b' },
	{ label: 'main.a.b', schema: 'main', table: 'a.b' },
	{ label: 'main.café', schema: 'main', table: 'café' },
	{ label: "main.o'brien", schema: 'main', table: "o'brien" },
	{ label: 'main.weißbier', schema: 'main', table: 'weißbier' },
];

/** Open the store a spec names, through the provider's public surface. */
function openSpec(provider: KVStoreProvider, spec: StoreSpec): Promise<KVStore> {
	return spec.index === undefined
		? provider.getStore(spec.schema, spec.table)
		: provider.getIndexStore(spec.schema, spec.table, spec.index);
}

/** Read a store's marker back, or `'<none>'` when the key is absent. */
async function readMarker(store: KVStore): Promise<string> {
	const value = await store.get(MARKER_KEY);
	return value === undefined ? '<none>' : decoder.decode(value);
}

/**
 * Assert `provider` gives every logical store in {@link DISTINCT_STORES} its OWN physical
 * store: write one marker per store under a single shared key, then check each store still
 * reads back its own. A shared physical store shows up as one marker having replaced
 * another.
 *
 * Exported standalone (like {@link assertBoundedIterate}) so a spec can drive it against a
 * provider double built to violate the property and prove it rejects — a guard nobody has
 * watched fail is not a guard. See `test/store-name-distinctness.spec.ts`.
 *
 * @param provider - A provider over a fresh, EMPTY physical keyspace.
 * @param report - Where to record names the provider refused. Refusal is allowed (a
 *   namespace that genuinely cannot represent a name must reject it rather than fold it),
 *   but never silently: the battery logs whatever lands here.
 */
export async function assertStoreNamesDistinct(
	provider: KVStoreProvider,
	report: string[] = [],
): Promise<void> {
	const opened: Array<{ spec: StoreSpec; store: KVStore }> = [];

	for (const spec of DISTINCT_STORES) {
		try {
			opened.push({ spec, store: await openSpec(provider, spec) });
		} catch (e) {
			// A provider whose native namespace genuinely cannot represent this name is
			// allowed to refuse it — that is the safe outcome. Folding it onto another
			// store is not, and is what the marker check below catches.
			assert.ok(
				!spec.mustAccept,
				`${spec.label} uses only [a-z0-9_.] and must be representable, but the provider rejected it: ${String(e)}`,
			);
			report.push(`${spec.label} (${String(e)})`);
		}
	}

	// No explicit "did enough survive?" check is needed: the `mustAccept` entries above
	// cannot be refused, so the compared set never shrinks below them.
	for (const { spec, store } of opened) {
		await store.put(MARKER_KEY, encoder.encode(spec.label));
	}

	for (const { spec, store } of opened) {
		assert.strictEqual(
			await readMarker(store),
			spec.label,
			`store "${spec.label}" reads back another store's marker — the two share one physical store`,
		);
	}
}

/**
 * Register the store-name distinctness battery under `describe(name)`. Call once per
 * backend, from the same spec file that registers {@link runKVStoreConformance}.
 */
export function runStoreNameDistinctness(name: string, makeNamingBackend: () => KVNamingBackend): void {
	describe(name, () => {
		let backend: KVNamingBackend;
		let provider: KVStoreProvider;

		beforeEach(async () => {
			backend = makeNamingBackend();
			provider = await backend.open();
		});

		afterEach(async () => {
			await backend.teardown();
		});

		it('gives every distinct logical store its own physical store', async () => {
			const rejected: string[] = [];
			await assertStoreNamesDistinct(provider, rejected);
			if (rejected.length > 0) {
				// Visible on a passing run too: a provider that quietly grew its rejection set
				// would otherwise look identical to one that represents every name.
				console.warn(`${name}: names refused by the provider (allowed, but recorded): ${rejected.join('; ')}`);
			}
		});

		it('opens ONE physical store for either spelling of a case-insensitive identifier', async () => {
			// SQL identifiers are case-insensitive, and the shared builders lowercase, so two
			// spellings of one logical store must land on the same physical store — the mirror
			// image of the distinctness property, and just as easy to break (a provider that
			// lowercases only part of the name gets two stores for one index).
			const upperData = await provider.getStore('MAIN', 'T');
			await upperData.put(MARKER_KEY, encoder.encode('data'));
			const lowerData = await provider.getStore('main', 't');
			assertBytes(
				await lowerData.get(MARKER_KEY),
				encoder.encode('data'),
				'getStore("MAIN","T") and getStore("main","t") must be the same physical store',
			);

			const upperIndex = await provider.getIndexStore('main', 't', 'IdxName');
			await upperIndex.put(MARKER_KEY, encoder.encode('index'));
			const lowerIndex = await provider.getIndexStore('MAIN', 'T', 'idxname');
			assertBytes(
				await lowerIndex.get(MARKER_KEY),
				encoder.encode('index'),
				'getIndexStore(…,"IdxName") and getIndexStore(…,"idxname") must be the same physical store',
			);

			// …and the index store is still not the data store (a provider could satisfy both
			// checks above by returning one store for everything).
			assert.strictEqual(await readMarker(lowerData), 'data', 'the index write leaked into the data store');
		});

		it('keeps the reserved catalog and stats stores disjoint from same-named tables', async () => {
			const catalog = await provider.getCatalogStore();
			const stats = await provider.getStatsStore('main', 't');
			await catalog.put(MARKER_KEY, encoder.encode('catalog'));
			await stats.put(MARKER_KEY, encoder.encode('stats'));
			assert.strictEqual(await readMarker(catalog), 'catalog', 'the catalog and stats stores are the same physical store');

			// A user table may legally be named `__catalog__` or `__stats__`. Its data store
			// must not land on the reserved store of the same name — providers keep the
			// reserved names in a namespace their encoded table names cannot reach.
			const tableStores = new Map<string, KVStore>();
			for (const table of ['__catalog__', '__stats__']) {
				const store = await provider.getStore('main', table);
				tableStores.set(table, store);
				await store.put(MARKER_KEY, encoder.encode(`table ${table}`));
			}

			assert.strictEqual(await readMarker(catalog), 'catalog', 'a table named __catalog__ landed on the reserved catalog store');
			assert.strictEqual(await readMarker(stats), 'stats', 'a table named __stats__ landed on the reserved stats store');

			// …and the two user tables are distinct from EACH OTHER, not just from the
			// reserved pair — a provider that folded both onto one store would otherwise
			// leave the reserved markers intact and pass.
			for (const [table, store] of tableStores) {
				assert.strictEqual(
					await readMarker(store),
					`table ${table}`,
					`the user table "${table}" reads back another store's marker`,
				);
			}
		});
	});
}
