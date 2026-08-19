/**
 * Unit coverage for the benchmark harness's BACKEND dimension (`bench/lib/backends.mjs`)
 * — the rule that turns one workload definition into one benchmark per storage engine,
 * and the naming rule that keeps every pre-existing benchmark name meaning what it meant.
 *
 * `yarn bench` is not part of `yarn test`, so without this file the only thing checking
 * these rules is a person reading a table. `expandBackends` is a pure function over
 * plain objects, so every case here uses synthetic backends and synthetic workloads
 * rather than running a benchmark — the same approach `bench-calibration.spec.ts` takes
 * to calibration and `bench-comparison.spec.ts` takes to the comparison.
 *
 * The one thing these tests deliberately do NOT cover is the real `BACKENDS` array:
 * asserting on it would freeze a one-element list that the next ticket grows.
 */
import { expect } from 'chai';
import {
	BACKEND_SEPARATOR,
	benchmarkName,
	expandBackends,
} from '../bench/lib/backends.mjs';
import type { BenchBackend } from '../bench/lib/backends.mjs';
import { matchesFilter } from '../bench/lib/discover.mjs';

/** A backend descriptor whose `open` returns no real database. The cast is the honest
 * shape of these tests: `expandBackends` builds names and binds functions, and NOTHING
 * here ever calls `open`, so standing up a `Database` per case would only slow them
 * down. A case that needed a live handle would use a real backend instead. */
function backend(id: string, isDefault = false): BenchBackend {
	return { id, isDefault, label: `${id} backend`, open: async () => ({ db: null, close: async () => { } }) } as unknown as BenchBackend;
}

/** A workload, reduced to the one field `expandBackends` actually reads. */
const workload = (name: string) => ({ name });

/** The minimal binder: records which backend it was handed, so a test can assert the
 * expansion paired each workload with each backend rather than only naming them so. */
const bind = (w: { name: string }, b: { id: string }) => ({ fn: () => { }, boundTo: b.id, from: w.name });

const MEM = backend('mem', true);
const STORE = backend('store-mem');

describe('bench/lib/backends.mjs', () => {
	describe('benchmarkName', () => {
		it('publishes the BARE name for the default backend', () => {
			// The load-bearing rule: every benchmark name already on disk, every
			// `ratioGuards` entry and all of docs/benchmarking.md keep meaning what they
			// meant only because the default backend never suffixes.
			expect(benchmarkName('full-scan-10k', MEM)).to.equal('full-scan-10k');
		});

		it('appends the backend id for every other backend', () => {
			expect(benchmarkName('full-scan-10k', STORE)).to.equal(`full-scan-10k${BACKEND_SEPARATOR}store-mem`);
		});

		it('produces a name a plain substring --filter can still select', () => {
			const suffixed = `execution/${benchmarkName('full-scan-10k', STORE)}`;
			// Both readings the separator has to support: one backend across workloads,
			// and one workload across backends.
			expect(matchesFilter(suffixed, `${BACKEND_SEPARATOR}store-mem`)).to.equal(true);
			expect(matchesFilter(suffixed, 'full-scan-10k')).to.equal(true);
		});
	});

	describe('expandBackends', () => {
		it('emits one benchmark per workload per backend', () => {
			const expanded = expandBackends([MEM, STORE], [workload('a'), workload('b')], bind);
			expect(expanded).to.have.length(4);
		});

		it('emits WORKLOAD-MAJOR, so one workload\'s readings land on adjacent rows', () => {
			const expanded = expandBackends([MEM, STORE], [workload('a'), workload('b')], bind);
			expect(expanded.map((e) => e.name)).to.deep.equal([
				'a', `a${BACKEND_SEPARATOR}store-mem`, 'b', `b${BACKEND_SEPARATOR}store-mem`,
			]);
		});

		it('leaves a single-default-backend set naming every benchmark exactly as before', () => {
			// The whole acceptance condition of introducing the dimension at all: with one
			// backend, expansion is a no-op on the names.
			const expanded = expandBackends([MEM], [workload('a'), workload('b')], bind);
			expect(expanded.map((e) => e.name)).to.deep.equal(['a', 'b']);
		});

		it('hands each backend to the binder, so the two rows measure different engines', () => {
			const expanded = expandBackends([MEM, STORE], [workload('a')], bind);
			expect(expanded.map((e) => (e as unknown as { boundTo: string }).boundTo)).to.deep.equal(['mem', 'store-mem']);
		});

		it('keeps whatever the binder returned, other than the name', () => {
			const expanded = expandBackends([MEM], [workload('a')], bind);
			expect(expanded[0]).to.have.property('fn').that.is.a('function');
			expect((expanded[0] as unknown as { from: string }).from).to.equal('a');
		});

		it('rejects a set with no default, which would rename the whole suite', () => {
			expect(() => expandBackends([STORE], [workload('a')], bind)).to.throw(/isDefault/);
		});

		it('rejects a set with two defaults, which would emit the same bare name twice', () => {
			expect(() => expandBackends([MEM, backend('other', true)], [workload('a')], bind))
				.to.throw(/2 backends are marked isDefault/);
		});

		it('rejects a duplicated backend id', () => {
			expect(() => expandBackends([MEM, STORE, backend('store-mem')], [workload('a')], bind))
				.to.throw(/appears more than once/);
		});

		it('rejects an id that collides with a workload name already expanded', () => {
			// `x` on backend `store-mem` and a workload literally named `x@store-mem` produce
			// the same string. Caught here, where the message can name the backend, rather
			// than by `loadSuite`'s duplicate check, whose message names only the benchmark.
			expect(() => expandBackends([MEM, STORE], [workload('x'), workload(`x${BACKEND_SEPARATOR}store-mem`)], bind))
				.to.throw(/already taken/);
		});

		it('rejects a binder that names its own benchmark differently', () => {
			const misnaming = () => ({ name: 'something-else', fn: () => { } });
			expect(() => expandBackends([MEM], [workload('a')], misnaming)).to.throw(/must be named 'a'/);
		});

		it('rejects a workload with no name', () => {
			expect(() => expandBackends([MEM], [{} as { name: string }], bind)).to.throw(/non-empty string name/);
		});

		it('rejects an empty backend set rather than emitting nothing', () => {
			// Silently returning `[]` would read as "this suite has no benchmarks", which is
			// a claim about the suite rather than about the malformed set that caused it.
			expect(() => expandBackends([], [workload('a')], bind)).to.throw(/non-empty array/);
		});

		it('rejects a non-callable skipWorkload rather than ignoring it', () => {
			// The bad failure mode: a truthy non-function is skipped exactly like an absent
			// one, so a backend meant to DECLINE silently runs and fails instead.
			const bad = { ...backend('bad'), skipWorkload: 'nope' } as unknown as BenchBackend;
			expect(() => expandBackends([MEM, bad], [workload('a')], bind)).to.throw(/'skipWorkload' that is not a function/);
		});

		it('rejects a non-callable openCounting rather than ignoring it', () => {
			const bad = { ...backend('bad'), openCounting: {} } as unknown as BenchBackend;
			expect(() => expandBackends([MEM, bad], [workload('a')], bind)).to.throw(/'openCounting' that is not a function/);
		});
	});

	describe('expandBackends — the backend skip seam', () => {
		/** A backend that declines `workload`, naming it, so a test can tell WHICH workload
		 * the seam handed to `skipWorkload`. */
		function declining(id: string, decline: (w: { name: string }) => string | null): BenchBackend {
			return { ...backend(id), skipWorkload: decline } as unknown as BenchBackend;
		}

		it('leaves a benchmark with NO skip key when its backend declares no skipWorkload', () => {
			// Byte-identical to what the expansion produced before this seam existed — the
			// memory rows must not gain a `skip` they never had.
			const [row] = expandBackends([MEM], [workload('a')], bind);
			expect('skip' in row).to.equal(false);
		});

		it('attaches a skip that reports the backend\'s reason, per workload', async () => {
			const backendUnderTest = declining('store-mem', (w) => (w.name === 'b' ? 'not on this backend' : null));
			const rows = expandBackends([MEM, backendUnderTest], [workload('a'), workload('b')], bind);
			const byName = new Map(rows.map((r) => [r.name, r]));
			expect(await byName.get(`a${BACKEND_SEPARATOR}store-mem`)!.skip!()).to.equal(null);
			expect(await byName.get(`b${BACKEND_SEPARATOR}store-mem`)!.skip!()).to.equal('not on this backend');
			// The default backend is untouched by the other backend's decline.
			expect('skip' in byName.get('a')!).to.equal(false);
		});

		it('composes with a binder-supplied skip, backend first, without either overwriting the other', async () => {
			// The failure this rules out is silent: whichever of the two was assigned last
			// would win and the other would never be consulted.
			const binderSkip = () => 'binder says no';
			const bindWithSkip = () => ({ fn: () => { }, skip: binderSkip });
			const rows = expandBackends([MEM, declining('store-mem', () => null)], [workload('a')], bindWithSkip);
			const byName = new Map(rows.map((r) => [r.name, r]));
			// No backend skipWorkload at all: the binder's own function is passed through
			// unwrapped, so a binder that declines still declines.
			expect(byName.get('a')!.skip).to.equal(binderSkip);
			// Backend agrees to run → the binder's reason is still consulted.
			expect(await byName.get(`a${BACKEND_SEPARATOR}store-mem`)!.skip!()).to.equal('binder says no');
		});

		it('lets the backend\'s reason win when both decline', async () => {
			// Backend-first because a backend that cannot load makes any workload-intrinsic
			// reason moot, and its probe is the cheaper of the two.
			const bindWithSkip = () => ({ fn: () => { }, skip: () => 'binder says no' });
			const rows = expandBackends([MEM, declining('other', () => 'backend says no')], [workload('a')], bindWithSkip);
			const suffixed = rows.find((r) => r.name.endsWith('other'))!;
			expect(await suffixed.skip!()).to.equal('backend says no');
		});
	});
});
