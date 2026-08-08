import { expect } from 'chai';
import { evalArgsSync } from '../../src/runtime/emit/aggregate-setup.js';
import { aggregateCoercesArguments, coerceAggregateValue, coerceForAggregate } from '../../src/util/coercion.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { MaybePromise, SqlValue } from '../../src/common/types.js';

/**
 * `evalArgsSync` only reads the context to hand it to each evaluator, so a bare
 * sentinel object is enough — the aggregate emitters pass a real RuntimeContext.
 */
const RCTX = { marker: 'rctx' } as unknown as RuntimeContext;

type Evaluator = (ctx: RuntimeContext) => MaybePromise<SqlValue>;

/** Evaluator that resolves synchronously. */
const sync = (value: SqlValue): Evaluator => () => value;

/** Evaluator that resolves after `ticks` microtask hops. */
const deferred = (value: SqlValue, ticks = 1): Evaluator => async () => {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
	return value;
};

async function resolve(result: MaybePromise<SqlValue[]>): Promise<SqlValue[]> {
	return result instanceof Promise ? await result : result;
}

describe('evalArgsSync', () => {
	it('returns a plain array (no promise) when every evaluator is synchronous', () => {
		const result = evalArgsSync(RCTX, [sync(1), sync('two'), sync(null)]);
		expect(result).to.not.be.instanceOf(Promise);
		expect(result).to.deep.equal([1, 'two', null]);
	});

	it('returns an empty array for a zero-argument aggregate', () => {
		const result = evalArgsSync(RCTX, []);
		expect(result).to.not.be.instanceOf(Promise);
		expect(result).to.deep.equal([]);
	});

	it('passes the runtime context to every evaluator', () => {
		const seen: RuntimeContext[] = [];
		const capture: Evaluator = ctx => { seen.push(ctx); return 0; };
		const result = evalArgsSync(RCTX, [capture, capture]);
		expect(result).to.not.be.instanceOf(Promise);
		expect(seen).to.deep.equal([RCTX, RCTX]);
	});

	it('applies the transform to synchronous values', () => {
		const result = evalArgsSync(RCTX, [sync('12'), sync(3)], v => (typeof v === 'string' ? Number(v) : v));
		expect(result).to.deep.equal([12, 3]);
	});

	it('applies the transform to asynchronous values, including ones before and after the first pending arg', async () => {
		const result = await resolve(
			evalArgsSync(RCTX, [sync('1'), deferred('2'), sync('3')], v => (typeof v === 'string' ? Number(v) : v))
		);
		expect(result).to.deep.equal([1, 2, 3]);
	});

	it('preserves argument order when a later evaluator resolves sooner', async () => {
		const result = await resolve(evalArgsSync(RCTX, [deferred('slow', 5), deferred('fast', 1), sync('sync')]));
		expect(result).to.deep.equal(['slow', 'fast', 'sync']);
	});

	it('evaluates strictly sequentially — no evaluator starts before the previous settles', async () => {
		// Sibling scalar sub-programs share one RuntimeContext, so overlapping them would
		// let one operator's row slots race another's. Order must be start,end,start,end,…
		const events: string[] = [];
		const tracked = (name: string, ticks: number): Evaluator => async () => {
			events.push(`${name}:start`);
			for (let i = 0; i < ticks; i++) await Promise.resolve();
			events.push(`${name}:end`);
			return name;
		};

		const values = await resolve(evalArgsSync(RCTX, [tracked('a', 4), tracked('b', 1), tracked('c', 2)]));

		expect(values).to.deep.equal(['a', 'b', 'c']);
		expect(events).to.deep.equal([
			'a:start', 'a:end',
			'b:start', 'b:end',
			'c:start', 'c:end',
		]);
	});

	it('does not invoke evaluators after one that rejects', async () => {
		let laterInvoked = false;
		const boom: Evaluator = async () => { throw new Error('arg blew up'); };
		const later: Evaluator = () => { laterInvoked = true; return 1; };

		const result = evalArgsSync(RCTX, [sync(0), boom, later]);
		expect(result).to.be.instanceOf(Promise);
		try {
			await result;
			expect.fail('expected rejection');
		} catch (e) {
			expect((e as Error).message).to.equal('arg blew up');
		}
		expect(laterInvoked).to.equal(false);
	});

	it('propagates a synchronous throw without wrapping it in a promise', () => {
		const boom: Evaluator = () => { throw new Error('sync blew up'); };
		expect(() => evalArgsSync(RCTX, [sync(0), boom])).to.throw('sync blew up');
	});
});

describe('aggregate argument coercion', () => {
	it('routes the non-numeric aggregates away from coercion', () => {
		for (const name of ['count', 'COUNT', 'group_concat', 'GROUP_CONCAT', 'json_group_array', 'JSON_OBJECT']) {
			expect(aggregateCoercesArguments(name), name).to.equal(false);
		}
	});

	it('routes every other aggregate into coercion', () => {
		for (const name of ['sum', 'SUM', 'avg', 'min', 'max', 'total', 'my_custom_agg', '']) {
			expect(aggregateCoercesArguments(name), name).to.equal(true);
		}
	});

	it('converts only numeric-looking strings', () => {
		expect(coerceAggregateValue('42')).to.equal(42);
		expect(coerceAggregateValue(' 4.5 ')).to.equal(4.5);
		expect(coerceAggregateValue('abc')).to.equal('abc');
		expect(coerceAggregateValue('')).to.equal('');
		expect(coerceAggregateValue('   ')).to.equal('   ');
		expect(coerceAggregateValue(null)).to.equal(null);
		expect(coerceAggregateValue(7)).to.equal(7);
	});

	it('composes back into coerceForAggregate, the definition the emitters must match', () => {
		for (const name of ['sum', 'count', 'json_object', 'max']) {
			for (const value of ['42', 'abc', '', null, 7] as const) {
				const expected = aggregateCoercesArguments(name) ? coerceAggregateValue(value) : value;
				expect(coerceForAggregate(value, name), `${name}(${String(value)})`).to.equal(expected);
			}
		}
	});
});
