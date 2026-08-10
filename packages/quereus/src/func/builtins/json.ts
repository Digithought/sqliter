import fastJsonPatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
const { applyPatch } = fastJsonPatch;

// moat-maker: Runtime validation library with TypeScript-like syntax
// Used for json_schema() function to validate JSON against structural schemas
import { validator } from 'moat-maker';

import { createLogger } from '../../common/logger.js';
import type { SqlValue, JSONValue } from '../../common/types.js';
import { createScalarFunction, createAggregateFunction } from '../registration.js';
import { coerceToJsonValue, resolveJsonPathForModify, prepareJsonValue, deepCopyJson, getJsonType } from './json-helpers.js';
import { ANY_RETURN, BOOLEAN_RETURN_NOT_NULL, INTEGER_RETURN, JSON_RETURN, TEXT_RETURN } from './return-types.js';
import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { EmissionContext } from '../../runtime/emission-context.js';
import type { Instruction, RuntimeContext } from '../../runtime/types.js';
import { asRun } from '../../runtime/types.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';
import { LiteralNode } from '../../planner/nodes/scalar.js';
import { emitPlanNode } from '../../runtime/emitters.js';

const log = createLogger('func:builtins:json');
const errorLog = log.extend('error');

// --- JSON Functions --- //

// json_valid(X)
export const jsonValidFunc = createScalarFunction(
	{ name: 'json_valid', numArgs: 1, deterministic: true, returnType: BOOLEAN_RETURN_NOT_NULL },
	(json: SqlValue): SqlValue => {
		if (json === null) return false;
		// Native objects are always valid JSON
		if (typeof json === 'object' && !(json instanceof Uint8Array)) return true;
		if (typeof json === 'number' || typeof json === 'boolean') return true;
		return coerceToJsonValue(json) !== undefined;
	}
);



/**
 * Custom emitter for json_schema that caches compiled validators in the EmissionContext.
 * This provides significant performance improvements for CHECK constraints and repeated validations.
 */
function emitJsonSchema(
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
	defaultEmit: (plan: ScalarFunctionCallNode, ctx: EmissionContext) => Instruction
): Instruction {
	// Check if the second argument (schema definition) is a constant
	const schemaDefArg = plan.operands[1];

	if (schemaDefArg?.nodeType === PlanNodeType.Literal) {
		const literalNode = schemaDefArg as LiteralNode;
		const schemaDef = literalNode.getValue();

		if (typeof schemaDef === 'string') {
			try {
				// Compile the validator once at emission time using moat-maker
				const parts = Object.assign([schemaDef], { raw: [schemaDef] }) as unknown as TemplateStringsArray;
				const compiledValidator = validator(parts);

				// Emit only the JSON argument (first operand)
				const jsonArgInstruction = emitPlanNode(plan.operands[0], ctx);

				function run(_rctx: RuntimeContext, ...args: SqlValue[]): SqlValue {
					const json = args[0];
					const data = coerceToJsonValue(json);
					if (data === undefined) return false;

					try {
						const isValid = compiledValidator.matches(data);
						return isValid;
					} catch (e) {
						errorLog('json_schema validation failed: %O', e);
						return false;
					}
				}

				return {
					params: [jsonArgInstruction],
					run: asRun(run),
					note: `json_schema(cached:${schemaDef.substring(0, 20)}...)`
				};
			} catch (e) {
				errorLog('Failed to compile schema at emission time: %O', e);
			}
		}
	}

	return defaultEmit(plan, ctx);
}

// json_schema(X, schema_def)
export const jsonSchemaFunc = createScalarFunction(
	{ name: 'json_schema', numArgs: 2, deterministic: true, returnType: BOOLEAN_RETURN_NOT_NULL },
	(json: SqlValue, schemaDef: SqlValue): SqlValue => {
		if (typeof schemaDef !== 'string') return false;

		const data = coerceToJsonValue(json);
		if (data === undefined) return false;

		try {
			const parts = Object.assign([schemaDef], { raw: [schemaDef] }) as unknown as TemplateStringsArray;
			const compiledValidator = validator(parts);
			const isValid = compiledValidator.matches(data);
			return isValid;
		} catch (e) {
			errorLog('json_schema validation failed: %O', e);
			return false;
		}
	}
);

jsonSchemaFunc.customEmitter = emitJsonSchema;

// json_type(X, P?)
export const jsonTypeFunc = createScalarFunction(
	{ name: 'json_type', numArgs: -1, deterministic: true, returnType: TEXT_RETURN },
	(json: SqlValue, path?: SqlValue): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;

		let targetValue: JSONValue | undefined = data;
		if (path !== undefined && path !== null) {
			if (typeof path !== 'string') return 'null';
			const resolved = resolveJsonPathForModify(data, path);
			targetValue = resolved?.exists ? resolved.value : undefined;
			if (targetValue === undefined) return null;
		}
		return getJsonType(targetValue as JSONValue);
	}
);

// json_extract(X, P1, P2, ...)
// ANY is declared deliberately, not forgotten: the result is whatever the path
// resolves to — a JSON object/array, a string, a number, a boolean — and nothing
// about the argument types narrows it. Every other JSON builtin declares a real type.
export const jsonExtractFunc = createScalarFunction(
	{ name: 'json_extract', numArgs: -1, deterministic: true, returnType: ANY_RETURN },
	(json: SqlValue, ...paths: SqlValue[]): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;

		if (paths.length === 0) return null;

		let extractedValue: JSONValue | undefined = undefined;
		for (const pathVal of paths) {
			if (typeof pathVal === 'string') {
				const resolved = resolveJsonPathForModify(data, pathVal);
				extractedValue = resolved?.exists ? resolved.value : undefined;
				if (extractedValue !== undefined) break;
			} else {
				return null;
			}
		}

		if (extractedValue === undefined) return null;
		if (extractedValue === null) return null;
		if (typeof extractedValue === 'boolean') return extractedValue;
		if (typeof extractedValue === 'number') return extractedValue;
		if (typeof extractedValue === 'string') return extractedValue;
		if (typeof extractedValue === 'object') {
			// Return nested objects/arrays as native JSON values
			return extractedValue as SqlValue;
		}
		return null;
	}
);

// json_quote(X) — serialized JSON *source text*, not a native JSON value
export const jsonQuoteFunc = createScalarFunction(
	{ name: 'json_quote', numArgs: 1, deterministic: true, returnType: TEXT_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return 'null';
		switch (typeof value) {
			case 'number':
				if (!Number.isFinite(value)) return 'null';
				return String(value);
			case 'boolean':
				return value ? 'true' : 'false';
			case 'string':
				return JSON.stringify(value);
			case 'bigint':
				return null;
			case 'object':
				if (value instanceof Uint8Array) return null;
				try {
					return JSON.stringify(value);
				} catch {
					return null;
				}
			default:
				return null;
		}
	}
);

// json_array(X, Y, ...) — returns native array
// NOTE: JSON_RETURN is nullable, but this one provably never returns null. Declaring the
// looser truth keeps every JSON-returning builtin on one constant. If a NOT NULL
// inference ever keys off scalar-function nullability, give this a not-null variant.
export const jsonArrayFunc = createScalarFunction(
	{ name: 'json_array', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(...args: SqlValue[]): SqlValue => {
		return args.map(arg => prepareJsonValue(arg));
	}
);

// json_object(N1, V1, N2, V2, ...) — returns native object
export const jsonObjectFunc = createScalarFunction(
	{ name: 'json_object', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(...args: SqlValue[]): SqlValue => {
		if (args.length % 2 !== 0) return null;
		const obj: Record<string, JSONValue> = {};
		for (let i = 0; i < args.length; i += 2) {
			const key = args[i];
			const value = args[i + 1];
			if (typeof key !== 'string') return null;
			obj[key] = prepareJsonValue(value);
		}
		return obj;
	}
);

// --- Additional JSON Functions --- //

// json_array_length(json, path?)
export const jsonArrayLengthFunc = createScalarFunction(
	{ name: 'json_array_length', numArgs: -1, deterministic: true, returnType: INTEGER_RETURN },
	(json: SqlValue, path?: SqlValue): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;

		let targetValue: JSONValue | undefined = data;
		if (path !== undefined && path !== null) {
			if (typeof path !== 'string') return 0;
			const resolved = resolveJsonPathForModify(data, path);
			targetValue = resolved?.exists ? resolved.value : undefined;
		}

		return Array.isArray(targetValue) ? targetValue.length : 0;
	}
);

// json_patch(json, patch) — returns native object
export const jsonPatchFunc = createScalarFunction(
	{ name: 'json_patch', numArgs: 2, deterministic: false, returnType: JSON_RETURN },
	(json: SqlValue, patchVal: SqlValue): SqlValue => {
		const data = coerceToJsonValue(json);
		const patchData = coerceToJsonValue(patchVal);

		if (data === undefined) return null;
		if (!Array.isArray(patchData)) return null;

		const patch = patchData as unknown as Operation[];
		if (!patch.every(op => typeof op === 'object' && op !== null && 'op' in op && 'path' in op)) {
			return null;
		}

		try {
			// deepCopy data since applyPatch mutates; native objects may be shared
			const dataCopy = deepCopyJson(data);
			const result = applyPatch(dataCopy, patch, true).newDocument;
			return result as SqlValue;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			errorLog('json_patch failed: %s, %O', e?.message, e);
			return null;
		}
	}
);

// --- Manipulation Functions --- //

// json_insert(JSON, PATH, VALUE, PATH, VALUE, ...) — returns native object
export const jsonInsertFunc = createScalarFunction(
	{ name: 'json_insert', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;
		if (args.length === 0 || args.length % 2 !== 0) return null;

		const currentData = deepCopyJson(data);

		for (let i = 0; i < args.length; i += 2) {
			const pathVal = args[i];
			const valueVal = args[i + 1];

			if (typeof pathVal !== 'string') return null;

			const preparedValue = prepareJsonValue(valueVal);
			const pathInfo = resolveJsonPathForModify(currentData, pathVal);

			if (pathInfo === null) continue;

			const { parent, key, exists } = pathInfo;

			if (!exists) {
				if (parent === null) continue;

				if (Array.isArray(parent) && typeof key === 'number') {
					if (key === parent.length) {
						parent.push(preparedValue);
					} else if (key < parent.length) {
						parent.splice(key, 0, preparedValue);
					}
				} else if (typeof parent === 'object' && parent !== null && !Array.isArray(parent) && typeof key === 'string') {
					(parent as Record<string, JSONValue>)[key] = preparedValue;
				}
			}
		}

		return currentData as SqlValue;
	}
);

// json_replace(JSON, PATH, VALUE, PATH, VALUE, ...) — returns native object
export const jsonReplaceFunc = createScalarFunction(
	{ name: 'json_replace', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;
		if (args.length === 0 || args.length % 2 !== 0) return null;

		let currentData = deepCopyJson(data);

		for (let i = 0; i < args.length; i += 2) {
			const pathVal = args[i];
			const valueVal = args[i + 1];

			if (typeof pathVal !== 'string') return null;

			const preparedValue = prepareJsonValue(valueVal);
			const pathInfo = resolveJsonPathForModify(currentData, pathVal);

			if (pathInfo === null) continue;

			const { parent, key, exists } = pathInfo;

			if (exists) {
				if (parent === null && key === '') {
					currentData = preparedValue;
				} else if (parent !== null && typeof key === 'string' && typeof parent === 'object' && !Array.isArray(parent)) {
					parent[key] = preparedValue;
				} else if (parent !== null && typeof key === 'number' && Array.isArray(parent)) {
					if (key >= 0 && key < parent.length) {
						parent[key] = preparedValue;
					}
				}
			}
		}

		return currentData as SqlValue;
	}
);

// json_set(JSON, PATH, VALUE, PATH, VALUE, ...) — returns native object
export const jsonSetFunc = createScalarFunction(
	{ name: 'json_set', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(json: SqlValue, ...args: SqlValue[]): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;
		if (args.length === 0 || args.length % 2 !== 0) return null;

		let currentData = deepCopyJson(data);

		for (let i = 0; i < args.length; i += 2) {
			const pathVal = args[i];
			const valueVal = args[i + 1];

			if (typeof pathVal !== 'string') return null;

			const preparedValue = prepareJsonValue(valueVal);
			const pathInfo = resolveJsonPathForModify(currentData, pathVal, true);

			if (pathInfo === null) continue;

			const { parent, key } = pathInfo;

			if (parent === null && key === '') {
				currentData = preparedValue;
			} else if (parent !== null) {
				if (typeof parent === 'object' && !Array.isArray(parent) && typeof key === 'string') {
					parent[key] = preparedValue;
				} else if (Array.isArray(parent) && typeof key === 'number') {
					if (key >= 0 && key < parent.length) {
						parent[key] = preparedValue;
					} else if (key === parent.length) {
						parent.push(preparedValue);
					} else if (key > parent.length) {
						while (parent.length < key) {
							parent.push(null);
						}
						parent.push(preparedValue);
					}
				}
			}
		}

		return currentData as SqlValue;
	}
);

// json_remove(JSON, PATH, PATH, ...) — returns native object
export const jsonRemoveFunc = createScalarFunction(
	{ name: 'json_remove', numArgs: -1, deterministic: true, returnType: JSON_RETURN },
	(json: SqlValue, ...paths: SqlValue[]): SqlValue => {
		const data = coerceToJsonValue(json);
		if (data === undefined) return null;
		if (paths.length === 0) return data as SqlValue;

		const currentData = deepCopyJson(data);

		for (const pathVal of paths) {
			if (typeof pathVal !== 'string') return null;

			const pathInfo = resolveJsonPathForModify(currentData, pathVal);

			if (pathInfo === null || !pathInfo.exists || pathInfo.parent === null) {
				continue;
			}

			const { parent, key } = pathInfo;

			if (Array.isArray(parent) && typeof key === 'number') {
				if (key >= 0 && key < parent.length) {
					parent.splice(key, 1);
				}
			} else if (typeof parent === 'object' && parent !== null && !Array.isArray(parent) && typeof key === 'string') {
				if (Object.prototype.hasOwnProperty.call(parent, key)) {
					delete (parent as Record<string, JSONValue>)[key];
				}
			}
		}

		return currentData as SqlValue;
	}
);

// --- Aggregate Functions --- //

// json_group_array(value) — returns native array
export const jsonGroupArrayFunc = createAggregateFunction(
	{ name: 'json_group_array', numArgs: 1, initialValue: [], returnType: JSON_RETURN },
	(acc: JSONValue[], value: SqlValue): JSONValue[] => {
		acc.push(prepareJsonValue(value));
		return acc;
	},
	(acc: JSONValue[]): SqlValue => {
		return acc.length > 0 ? acc : null;
	}
);

// json_group_object(name, value) — returns native object
export const jsonGroupObjectFunc = createAggregateFunction(
	{ name: 'json_group_object', numArgs: 2, initialValue: {}, returnType: JSON_RETURN },
	(acc: Record<string, JSONValue>, name: SqlValue, value: SqlValue): Record<string, JSONValue> => {
		if (name === null || name === undefined) {
			return acc;
		}
		acc[String(name)] = prepareJsonValue(value);
		return acc;
	},
	(acc: Record<string, JSONValue>): SqlValue => {
		return Object.keys(acc).length > 0 ? acc : null;
	}
);
