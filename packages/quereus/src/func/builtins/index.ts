import { absFunc, roundFunc1, roundFunc2, coalesceFunc,
	nullifFunc, typeofFunc, randomFunc, randomblobFunc, iifFunc, sqrtFunc,
	powFunc, powerFunc, floorFunc, ceilFunc, ceilingFunc,
	clampFunc,
	greatestFunc,
	leastFunc,
	chooseFunc} from './scalar.js';
import { lowerFunc, upperFunc } from './string.js';
import { lengthFunc, substrFunc, substringFunc, likeFunc, globFunc, trimFunc, ltrimFunc, rtrimFunc, replaceFunc,
	instrFunc, lpadFunc, rpadFunc, reverseFunc,
	stringConcatFunc,
	splitStringFunc,
	hexFunc, unhexFunc} from './string.js';
import { countStarFunc, sumFunc, avgFunc, minFunc, maxFunc, countXFunc, groupConcatFuncRev, totalFunc,
	varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc } from './aggregate.js';
import type { FunctionSchema } from '../../schema/function.js';
import { dateFunc, timeFunc, datetimeFunc, juliandayFunc, strftimeFunc,
	epochSFunc, epochMsFunc, epochSFracFunc,
	isISODateFunc, isISODateTimeFunc } from './datetime.js';
import { jsonValidFunc, jsonSchemaFunc, jsonTypeFunc, jsonExtractFunc, jsonQuoteFunc, jsonArrayFunc, jsonObjectFunc, jsonInsertFunc, jsonReplaceFunc, jsonSetFunc, jsonRemoveFunc,
	jsonArrayLengthFunc, jsonPatchFunc,
	jsonGroupArrayFunc, jsonGroupObjectFunc } from './json.js';
import { generateSeriesFunc } from './generation.js';
import { mutationOrdinalFunc } from './mutation.js';
import { queryPlanFunc, schedulerProgramFunc, stackTraceFunc, executionTraceFunc, rowTraceFunc, explainAssertionFunc, effectiveLensFunc, basisBackfillFunc, lensAdvisoriesFunc } from './explain.js';
import { schemaFunc, tableInfoFunc, functionInfoFunc, foreignKeyInfoFunc,
	indexInfoFunc, checkConstraintInfoFunc, uniqueConstraintInfoFunc, assertionInfoFunc,
	viewInfoFunc, columnInfoFunc } from './schema.js';
import { jsonEachFunc, jsonTreeFunc } from './json-tvf.js';
import { INTEGER_FUNC, REAL_FUNC, TEXT_FUNC, BLOB_FUNC, BOOLEAN_FUNC, DATE_FUNC, TIME_FUNC, DATETIME_FUNC, JSON_FUNC, TIMESPAN_FUNC } from './conversion.js';
import {
	timespanYearsFunc, timespanMonthsFunc, timespanWeeksFunc, timespanDaysFunc,
	timespanHoursFunc, timespanMinutesFunc, timespanSecondsFunc,
	timespanTotalSecondsFunc, timespanTotalMinutesFunc, timespanTotalHoursFunc, timespanTotalDaysFunc
} from './timespan.js';

// Additional useful functions integrated from examples

// Combine all built-in function definitions into a single array
export const BUILTIN_FUNCTIONS: FunctionSchema[] = [
	// Type Conversion Functions
	INTEGER_FUNC,
	REAL_FUNC,
	TEXT_FUNC,
	BLOB_FUNC,
	BOOLEAN_FUNC,
	DATE_FUNC,
	TIME_FUNC,
	DATETIME_FUNC,
	JSON_FUNC,
	TIMESPAN_FUNC,
	// Scalar Functions
	absFunc,
	roundFunc1,
	roundFunc2,
	coalesceFunc,
	nullifFunc,
	typeofFunc,
	randomFunc,
	randomblobFunc,
	iifFunc,
	sqrtFunc,
	powFunc,
	powerFunc,
	floorFunc,
	ceilFunc,
	ceilingFunc,
	clampFunc,
	greatestFunc,
	leastFunc,
	chooseFunc,
	// String Functions
	lowerFunc,
	upperFunc,
	lengthFunc,
	substrFunc,
	substringFunc,
	likeFunc,
	globFunc,
	trimFunc,
	ltrimFunc,
	rtrimFunc,
	replaceFunc,
	instrFunc,
	reverseFunc,
	lpadFunc,
	rpadFunc,
	hexFunc,
	unhexFunc,
	stringConcatFunc,
	splitStringFunc,
	// Aggregates
	countStarFunc,
	sumFunc,
	avgFunc,
	minFunc,
	maxFunc,
	countXFunc,
	groupConcatFuncRev,
	totalFunc,
	varPopFunc,
	varSampFunc,
	stdDevPopFunc,
	stdDevSampFunc,
	// Date/Time Functions
	dateFunc,
	timeFunc,
	datetimeFunc,
	juliandayFunc,
	strftimeFunc,
	epochSFunc,
	epochMsFunc,
	epochSFracFunc,
	isISODateFunc,
	isISODateTimeFunc,
	// Timespan Functions
	timespanYearsFunc,
	timespanMonthsFunc,
	timespanWeeksFunc,
	timespanDaysFunc,
	timespanHoursFunc,
	timespanMinutesFunc,
	timespanSecondsFunc,
	timespanTotalSecondsFunc,
	timespanTotalMinutesFunc,
	timespanTotalHoursFunc,
	timespanTotalDaysFunc,
	// JSON Functions
	jsonValidFunc,
	jsonSchemaFunc,
	jsonTypeFunc,
	jsonExtractFunc,
	jsonQuoteFunc,
	jsonArrayFunc,
	jsonObjectFunc,
	// JSON Manipulation
	jsonInsertFunc,
	jsonReplaceFunc,
	jsonSetFunc,
	jsonRemoveFunc,
	// Additional JSON
	jsonArrayLengthFunc,
	jsonPatchFunc,
	// JSON Aggregates
	jsonGroupArrayFunc,
	jsonGroupObjectFunc,
	// Generation functions
	generateSeriesFunc,
	// Mutation-context functions
	mutationOrdinalFunc,
	// Explain functions
	queryPlanFunc,
	schedulerProgramFunc,
	stackTraceFunc,
	executionTraceFunc,
	rowTraceFunc,
	explainAssertionFunc,
	effectiveLensFunc,
	basisBackfillFunc,
	lensAdvisoriesFunc,
	// Schema introspection functions
	schemaFunc,
	tableInfoFunc,
	functionInfoFunc,
	foreignKeyInfoFunc,
	indexInfoFunc,
	checkConstraintInfoFunc,
	uniqueConstraintInfoFunc,
	assertionInfoFunc,
	viewInfoFunc,
	columnInfoFunc,
	// JSON table-valued functions
	jsonEachFunc,
	jsonTreeFunc,
];

// Export registration utilities for easy access
export {
	createScalarFunction,
	createTableValuedFunction,
	createIntegratedTableValuedFunction as createDatabaseAwareTableValuedFunction,
	createAggregateFunction,
} from '../registration.js';
