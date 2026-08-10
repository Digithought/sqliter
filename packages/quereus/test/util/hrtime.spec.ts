import { expect } from 'chai';
import { hrtimeNs } from '../../src/util/hrtime.js';

describe('hrtimeNs', () => {
	it('should return a bigint', () => {
		const result = hrtimeNs();
		expect(typeof result).to.equal('bigint');
	});

	it('should return non-decreasing values on successive calls', () => {
		const a = hrtimeNs();
		const b = hrtimeNs();
		expect(Number(b)).to.be.greaterThanOrEqual(Number(a));
	});

	it('should measure ~100ms elapsed time in the right ballpark', async () => {
		const start = hrtimeNs();
		await new Promise(resolve => setTimeout(resolve, 100));
		const elapsed = hrtimeNs() - start;

		// 80ms–200ms expressed in nanoseconds
		const ns80ms = 80_000_000n;
		const ns200ms = 200_000_000n;
		expect(Number(elapsed)).to.be.greaterThanOrEqual(Number(ns80ms));
		expect(Number(elapsed)).to.be.lessThanOrEqual(Number(ns200ms));
	});
});
