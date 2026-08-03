/**
 * Unit tests for the read-side semantic-ordering key predicates
 * (src/common/pk-key-resolution.ts, src/common/json-key.ts), independent of any SQL
 * plumbing:
 *
 *  - `semanticKeyOrderIsFaithful` — the explicit per-TYPE allow-list behind the
 *    re-opened ordering advertisements and range windows. Deliberately an allow-list:
 *    a semantic-ordering type merely CARRYING a key transform must stay declined,
 *    because a transform is only required to be identity-faithful.
 *  - `semanticProbeIsKeyFaithful` — the per-VALUE gate on a seek bound, which nothing
 *    coerces to the column's declared type.
 *  - `jsonKeyEncodable` — the JSON arm of the probe gate: declines the node kinds the
 *    structural encoder either raises on (blob) or mis-positions (bigint), while
 *    letting an unpaired-surrogate string through so the encoder's raise stands.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { JSON_TYPE, TIMESPAN_TYPE, type LogicalType, type SqlValue } from '@quereus/quereus';
import { semanticKeyOrderIsFaithful, semanticProbeIsKeyFaithful } from '../src/common/pk-key-resolution.js';
import { jsonKeyEncodable } from '../src/common/json-key.js';

/** A semantic-ordering type that is NOT on the allow-list (name mismatch). */
const UNLISTED_SEMANTIC: LogicalType = { ...TIMESPAN_TYPE, name: 'FUTURE_SEMANTIC' };

describe('semanticKeyOrderIsFaithful', () => {
	it('asserts faithfulness for exactly TIMESPAN and JSON', () => {
		expect(semanticKeyOrderIsFaithful(TIMESPAN_TYPE)).to.be.true;
		expect(semanticKeyOrderIsFaithful(JSON_TYPE)).to.be.true;
	});

	it('matches by NAME, not object identity (dual-module-instance shape)', () => {
		expect(semanticKeyOrderIsFaithful({ ...TIMESPAN_TYPE })).to.be.true;
		expect(semanticKeyOrderIsFaithful({ ...JSON_TYPE })).to.be.true;
	});

	it('keeps the blanket decline for anything else', () => {
		expect(semanticKeyOrderIsFaithful(undefined)).to.be.false;
		expect(semanticKeyOrderIsFaithful(UNLISTED_SEMANTIC)).to.be.false;
		// A non-semantic type is not this predicate's question at all.
		expect(semanticKeyOrderIsFaithful({ ...TIMESPAN_TYPE, semanticOrdering: false })).to.be.false;
	});
});

describe('semanticProbeIsKeyFaithful', () => {
	it('answers true for any probe on a non-semantic-ordering type (nothing to check)', () => {
		for (const probe of ['x', 5, null, new Uint8Array([1])] as SqlValue[]) {
			expect(semanticProbeIsKeyFaithful(undefined, probe), String(probe)).to.be.true;
		}
	});

	it('accepts a parseable TIMESPAN string probe and rejects the two under-fetch shapes', () => {
		expect(semanticProbeIsKeyFaithful(TIMESPAN_TYPE, 'PT1H')).to.be.true;
		expect(semanticProbeIsKeyFaithful(TIMESPAN_TYPE, 'PT90M')).to.be.true;
		// Numeric probe: the comparator storage-class-short-circuits while the bytes
		// would window at NUMERIC(5) — no faithful position.
		expect(semanticProbeIsKeyFaithful(TIMESPAN_TYPE, 5)).to.be.false;
		// Unparseable text: groupKey falls back to TEXT-tagged raw text, compare to
		// BINARY text against the canonical spelling — two different positions.
		expect(semanticProbeIsKeyFaithful(TIMESPAN_TYPE, 'not a duration')).to.be.false;
	});

	it('routes a JSON probe through jsonKeyEncodable', () => {
		expect(semanticProbeIsKeyFaithful(JSON_TYPE, { a: 1 })).to.be.true;
		expect(semanticProbeIsKeyFaithful(JSON_TYPE, new Uint8Array([1]))).to.be.false;
		expect(semanticProbeIsKeyFaithful(JSON_TYPE, 2n)).to.be.false;
	});

	it('answers false for every probe of a semantic type outside the allow-list', () => {
		expect(semanticProbeIsKeyFaithful(UNLISTED_SEMANTIC, 'PT1H')).to.be.false;
	});
});

describe('jsonKeyEncodable', () => {
	it('accepts every JSON_TYPE.parse-producible shape', () => {
		const values: SqlValue[] = [
			null, true, false, 0, -2.5, 'abc', '', [], [1, 'x', null], {}, { a: [1, { b: 'c' }] },
		];
		for (const v of values) {
			expect(jsonKeyEncodable(v), JSON.stringify(v)).to.be.true;
		}
	});

	it('declines a blob or bigint at any depth', () => {
		// The nested shapes are not statically valid JSON SqlValues — which is the
		// point: only a runtime-supplied probe can carry them, hence the casts.
		expect(jsonKeyEncodable(new Uint8Array([1]))).to.be.false;
		expect(jsonKeyEncodable(2n)).to.be.false;
		expect(jsonKeyEncodable([1, new Uint8Array([1])] as unknown as SqlValue)).to.be.false;
		expect(jsonKeyEncodable({ a: { b: 2n } } as unknown as SqlValue)).to.be.false;
	});

	it('deliberately does NOT decline an unpaired surrogate — the encoder must raise', () => {
		expect(jsonKeyEncodable('\uD800')).to.be.true;
		expect(jsonKeyEncodable(['a\uD800b'])).to.be.true;
		expect(jsonKeyEncodable({ '\uD800': 1 })).to.be.true;
	});
});
