import { absFunc, roundFunc, coalesceFunc,
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
	splitStringFunc} from './string.js';
import { countStarFunc, sumFunc, avgFunc, minFunc, maxFunc, countXFunc, groupConcatFuncRev, totalFunc,
	varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc } from './aggregate.js';
import type { FunctionSchema } from '../../schema/function.js';
import { dateFunc, timeFunc, datetimeFunc, juliandayFunc, strftimeFunc } from './datetime.js';
import { jsonValidFunc, jsonTypeFunc, jsonExtractFunc, jsonQuoteFunc, jsonArrayFunc, jsonObjectFunc, jsonInsertFunc, jsonReplaceFunc, jsonSetFunc, jsonRemoveFunc,
	jsonArrayLengthFunc, jsonPatchFunc,
	jsonGroupArrayFunc, jsonGroupObjectFunc } from './json.js';
import { generateSeriesFunc } from './generation.js';
import { queryPlanFunc, schedulerProgramFunc, stackTraceFunc, executionTraceFunc, rowTraceFunc } from './explain.js';
import { schemaFunc, tableInfoFunc, functionInfoFunc } from './schema.js';
import { jsonEachFunc, jsonTreeFunc } from './json-tvf.js';

// Additional useful functions integrated from examples

// Combine all built-in function definitions into a single array
export const BUILTIN_FUNCTIONS: FunctionSchema[] = [
	// Scalar Functions
	absFunc,
	roundFunc,
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
	// JSON Functions
	jsonValidFunc,
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
	// Explain functions
	queryPlanFunc,
	schedulerProgramFunc,
	stackTraceFunc,
	executionTraceFunc,
	rowTraceFunc,
	// Schema introspection functions
	schemaFunc,
	tableInfoFunc,
	functionInfoFunc,
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
