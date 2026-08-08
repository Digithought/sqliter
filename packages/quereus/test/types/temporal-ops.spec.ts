import { expect } from 'chai';
import {
	isTemporalKind,
	runTemporalCase,
	temporalKindOfType,
	temporalKindOfValue,
	temporalOpCase,
	temporalOpCaseKeys,
	unsupportedTemporalOp,
	type TemporalOperandKind,
} from '../../src/types/temporal-ops.js';
import { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESTAMP_TYPE, TIMESPAN_TYPE } from '../../src/types/temporal-types.js';
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, ANY_TYPE, NUMERIC_TYPE } from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { LogicalType } from '../../src/types/logical-type.js';
import { PhysicalType } from '../../src/types/logical-type.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';

/**
 * The operation table itself (`src/types/temporal-ops.ts`).
 *
 * The point of the table is that the planner and the evaluator read ONE description of
 * temporal arithmetic. This suite pins the table's own shape — every key well-formed,
 * every result type one of the five the type system actually has, `%` absent everywhere —
 * so a future edit cannot add a case the planner would announce as some unrelated type,
 * or quietly widen which declared types get specialized.
 */
describe('temporal operation table', () => {
	const ALL_KINDS: readonly TemporalOperandKind[] = ['date', 'time', 'datetime', 'timespan', 'number'];
	const ARITHMETIC_OPERATORS = ['+', '-', '*', '/', '%'];

	describe('table shape', () => {
		it('every key parses into (operator, known kind, known kind)', () => {
			for (const key of temporalOpCaseKeys()) {
				const parts = key.split('|');
				expect(parts, `key ${key}`).to.have.length(3);
				const [operator, left, right] = parts;
				expect(ARITHMETIC_OPERATORS, `key ${key}`).to.include(operator);
				expect(ALL_KINDS, `key ${key}`).to.include(left as TemporalOperandKind);
				expect(ALL_KINDS, `key ${key}`).to.include(right as TemporalOperandKind);
			}
		});

		it('every resultType is one of the five singletons temporal arithmetic can produce', () => {
			const expected: readonly LogicalType[] = [DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESPAN_TYPE, REAL_TYPE];
			for (const key of temporalOpCaseKeys()) {
				const [operator, left, right] = key.split('|');
				const entry = temporalOpCase(operator, left as TemporalOperandKind, right as TemporalOperandKind)!;
				expect(expected, `resultType of ${key} (${entry.resultType.name})`).to.include(entry.resultType);
			}
		});

		it('at least one operand of every case is temporal', () => {
			for (const key of temporalOpCaseKeys()) {
				const [, left, right] = key.split('|');
				expect(
					isTemporalKind(left as TemporalOperandKind) || isTemporalKind(right as TemporalOperandKind),
					`case ${key} has two non-temporal operands`,
				).to.equal(true);
			}
		});

		it('% has no case on any kind pair', () => {
			for (const left of ALL_KINDS) {
				for (const right of ALL_KINDS) {
					expect(temporalOpCase('%', left, right), `%|${left}|${right}`).to.equal(undefined);
				}
			}
		});

		it('the combinations documented as unsupported really are', () => {
			const unsupported: Array<[string, TemporalOperandKind, TemporalOperandKind]> = [
				['+', 'date', 'date'],
				['+', 'time', 'time'],
				['+', 'datetime', 'datetime'],
				['*', 'date', 'number'],
				['/', 'date', 'number'],
				['-', 'time', 'date'],
				['-', 'date', 'number'],
				['-', 'timespan', 'date'],
				['+', 'timespan', 'number'],
				['*', 'timespan', 'timespan'],
			];
			for (const [operator, left, right] of unsupported) {
				expect(temporalOpCase(operator, left, right), `${operator}|${left}|${right}`).to.equal(undefined);
			}
		});
	});

	describe('temporalKindOfType', () => {
		it('maps the four string temporal singletons to their kind', () => {
			expect(temporalKindOfType(DATE_TYPE)).to.equal('date');
			expect(temporalKindOfType(TIME_TYPE)).to.equal('time');
			expect(temporalKindOfType(DATETIME_TYPE)).to.equal('datetime');
			expect(temporalKindOfType(TIMESPAN_TYPE)).to.equal('timespan');
		});

		it('maps the numeric types to number', () => {
			expect(temporalKindOfType(INTEGER_TYPE)).to.equal('number');
			expect(temporalKindOfType(REAL_TYPE)).to.equal('number');
			expect(temporalKindOfType(NUMERIC_TYPE)).to.equal('number');
		});

		// TIMESTAMP is `isTemporal` but is an integer instant, not a string temporal, and
		// appears in no case. Pulling it into the table would change what `ts_col + 1`
		// announces and how it evaluates — this test is the tripwire for that.
		it('leaves TIMESTAMP unclassified so integer-instant arithmetic keeps its path', () => {
			expect(temporalKindOfType(TIMESTAMP_TYPE)).to.equal(undefined);
		});

		it('leaves types with no arithmetic meaning unclassified', () => {
			for (const type of [TEXT_TYPE, BLOB_TYPE, ANY_TYPE, NULL_TYPE, JSON_TYPE]) {
				expect(temporalKindOfType(type), type.name).to.equal(undefined);
			}
		});

		// registerType overwrites by name, so a plugin type named DATE is a DIFFERENT
		// object. Identity fails, no case is selected, and the pair falls back to runtime
		// sniffing — conservative, never a wrong announced type.
		it('does not classify a plugin type that shadows a built-in temporal name', () => {
			const impostor: LogicalType = { name: 'DATE', physicalType: PhysicalType.TEXT, isTemporal: true };
			expect(temporalKindOfType(impostor)).to.equal(undefined);
		});
	});

	describe('temporalKindOfValue', () => {
		const CASES: Array<[unknown, TemporalOperandKind | undefined]> = [
			['2024-01-15', 'date'],
			['2024-01-15T10:00:00', 'datetime'],
			['10:00:00', 'time'],
			['10:00:00.500', 'time'],
			['P10D', 'timespan'],
			['PT1H30M', 'timespan'],
			['-P10D', 'timespan'],
			[2, 'number'],
			[0.5, 'number'],
			// bigint is deliberately NOT 'number': the old cascade matched on
			// `typeof v === 'number'`, so `timespan * <bigint>` has always been
			// unsupported. Preserved as found.
			[9007199254740993n, undefined],
			['not-a-date', undefined],
			['', undefined],
			[null, undefined],
			[true, undefined],
		];

		for (const [value, kind] of CASES) {
			it(`${typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)} → ${kind}`, () => {
				expect(temporalKindOfValue(value as never)).to.equal(kind);
			});
		}
	});

	describe('isTemporalKind', () => {
		it('is true for the four temporal kinds and false for number/undefined', () => {
			expect(isTemporalKind('date')).to.equal(true);
			expect(isTemporalKind('time')).to.equal(true);
			expect(isTemporalKind('datetime')).to.equal(true);
			expect(isTemporalKind('timespan')).to.equal(true);
			expect(isTemporalKind('number')).to.equal(false);
			expect(isTemporalKind(undefined)).to.equal(false);
		});
	});

	describe('runTemporalCase', () => {
		const dateMinusDate = temporalOpCase('-', 'date', 'date')!;

		it('propagates null from either side before touching apply', () => {
			expect(runTemporalCase(dateMinusDate, null, '2024-01-15')).to.equal(null);
			expect(runTemporalCase(dateMinusDate, '2024-01-15', null)).to.equal(null);
			expect(runTemporalCase(dateMinusDate, null, null)).to.equal(null);
		});

		it('returns null when a value does not parse as the shape its kind promised', () => {
			expect(runTemporalCase(dateMinusDate, '2024-13-45', '2024-01-15')).to.equal(null);
		});

		it('lets an UNSUPPORTED error propagate rather than degrading it to null', () => {
			const scale = temporalOpCase('*', 'timespan', 'number')!;
			expect(() => runTemporalCase(scale, 'PT1H', 9007199254740993n))
				.to.throw(QuereusError, 'Unsupported temporal operation');
		});
	});

	describe('unsupportedTemporalOp', () => {
		it('throws one QuereusError with the message the tests assert on', () => {
			let caught: unknown;
			try { unsupportedTemporalOp(); } catch (e) { caught = e; }
			expect(caught).to.be.instanceOf(QuereusError);
			expect((caught as QuereusError).message).to.equal('Unsupported temporal operation');
			expect((caught as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		});
	});
});
