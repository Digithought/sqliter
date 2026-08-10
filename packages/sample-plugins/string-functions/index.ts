/**
 * String Functions Plugin for Quereus
 *
 * Provides additional string manipulation functions beyond the built-ins:
 * - reverse(text) - Reverses a string
 * - title_case(text) - Converts to title case
 * - repeat(text, count) - Repeats a string N times
 * - slugify(text) - Converts text to URL-friendly slug
 * - word_count(text) - Counts words in text
 * - str_concat(...args) - Concatenates strings (variadic)
 * - str_stats(text) - Table-valued function returning string statistics
 */

import {
	createScalarFunction,
	createTableValuedFunction,
	FunctionFlags,
	scalarReturn,
	TEXT_RETURN,
	INTEGER_RETURN,
	TEXT_TYPE,
	INTEGER_TYPE,
} from '@quereus/quereus';
import type { Database, SqlValue, Row, PluginRegistrations } from '@quereus/quereus';

export const manifest = {
	name: 'String Functions',
	version: '1.0.0',
	description: 'Additional string manipulation functions for Quereus',
	provides: {
		functions: true,
	},
};

const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

function reverse(text: SqlValue): SqlValue {
	if (text === null || text === undefined) return null;
	return String(text).split('').reverse().join('');
}

function titleCase(text: SqlValue): SqlValue {
	if (text === null || text === undefined) return null;
	return String(text).toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function repeat(text: SqlValue, count: SqlValue): SqlValue {
	if (text === null || text === undefined) return null;
	if (count === null || count === undefined) return null;

	const str = String(text);
	const num = Math.max(0, Math.floor(Number(count)));

	if (num === 0) return '';
	if (num > 1000) throw new Error('Repeat count too large (max 1000)');

	return str.repeat(num);
}

function slugify(text: SqlValue): SqlValue {
	if (text === null || text === undefined) return null;

	return String(text)
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function wordCount(text: SqlValue): SqlValue {
	if (text === null || text === undefined) return 0;

	const str = String(text).trim();
	if (str === '') return 0;

	return str.split(/\s+/).length;
}

function strConcat(...args: SqlValue[]): SqlValue {
	const validArgs = args.filter(arg => arg !== null && arg !== undefined);
	return validArgs.map(arg => String(arg)).join('');
}

async function* strStats(text: SqlValue): AsyncIterable<Row> {
	if (text === null || text === undefined) {
		yield ['length', 0];
		yield ['words', 0];
		yield ['chars', 0];
		yield ['lines', 0];
		return;
	}

	const str = String(text);
	const words = str.trim() === '' ? 0 : str.trim().split(/\s+/).length;
	const chars = str.replace(/\s/g, '').length;
	const lines = str.split('\n').length;

	yield ['length', str.length];
	yield ['words', words];
	yield ['chars', chars];
	yield ['lines', lines];
}

export default function register(_db: Database, _config: Record<string, SqlValue> = {}): PluginRegistrations {
	return {
		functions: [
			{
				schema: createScalarFunction(
					{ name: 'reverse', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					reverse,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'title_case', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					titleCase,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'repeat', numArgs: 2, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					repeat,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'slugify', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					slugify,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'word_count', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: INTEGER_RETURN },
					wordCount,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'str_concat', numArgs: -1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					strConcat,
				),
			},
			{
				schema: createTableValuedFunction(
					{
						name: 'str_stats',
						numArgs: 1,
						flags: DETERMINISTIC_UTF8,
						returnType: {
							typeClass: 'relation' as const,
							isReadOnly: true,
							isSet: false,
							columns: [
								{ name: 'metric', type: scalarReturn(TEXT_TYPE, false) },
								{ name: 'value', type: scalarReturn(INTEGER_TYPE, false) },
							],
							keys: [],
							rowConstraints: [],
						},
					},
					strStats,
				),
			},
		],
	};
}
