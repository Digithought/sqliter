import type { Row, SqlValue, JSONValue } from "../../common/types.js";
import { createTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import { coerceToJsonValue, evaluateJsonPathBasic, getJsonType } from "./json-helpers.js";
import { jsonStringify } from "../../util/serialization.js";
import { ANY_TYPE, INTEGER_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";

// `key`, `value` and `atom` are declared ANY, not TEXT: the walkers below emit
// them as the raw JSON scalars they encounter — `key` is a number for an array
// index and a string for an object member; `value`/`atom` carry numbers,
// booleans and strings verbatim (only a container `value` is stringified). A
// TEXT declaration would announce a value space the rows do not inhabit; ANY
// imposes no representation constraint and every consumer converts.
const JSON_MEMBER_COLUMN = { typeClass: 'scalar', logicalType: ANY_TYPE, nullable: true, isReadOnly: true } as const;

// JSON Each table-valued function
export const jsonEachFunc = createTableValuedFunction(
	{
		name: 'json_each',
		numArgs: -1, // Variable arguments (1 or 2)
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'key', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'value', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'atom', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'fullkey', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'path', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `id` (column 4) is assigned via an incrementing counter — unique per emitted row.
			// `key` is also unique (object keys are deduped; array indices are 0..n-1; scalars
			// emit a single row), so either choice would work; `id` is non-nullable.
			keys: [[{ index: 4 }]],
			deterministic: true,
		},
	},
	async function* (jsonInput: SqlValue, rootPath?: SqlValue): AsyncIterable<Row> {
		const parsedJson = coerceToJsonValue(jsonInput);
		if (parsedJson === undefined) {
			throw new QuereusError('Error: Invalid JSON provided to json_each', StatusCode.ERROR);
		}

		const rootPathStr = (typeof rootPath === 'string' && rootPath) ? rootPath : null;
		let startNode: JSONValue | undefined = parsedJson;

		if (rootPathStr) {
			startNode = evaluateJsonPathBasic(startNode, rootPathStr);
		}

		if (startNode === undefined) {
			return;
		}

		// json_each yields only the immediate children of the root container.
		// For scalars, yield a single row representing the scalar itself.
		let elementId = 0;
		const rootFullkey = '';

		if (Array.isArray(startNode)) {
			for (let i = 0; i < startNode.length; i++) {
				const childValue = startNode[i];
				const type = getJsonType(childValue);
				const isContainer = typeof childValue === 'object' && childValue !== null;
				const atom: SqlValue = isContainer ? null : childValue as SqlValue;
				const valueForColumn: SqlValue = isContainer ? jsonStringify(childValue) : childValue as SqlValue;
				const fullkey = `${rootFullkey}[${i}]`;

				yield [
					i,              // key
					valueForColumn, // value
					type,           // type
					atom,           // atom
					elementId++,    // id
					null,           // parent
					fullkey,        // fullkey
					rootFullkey     // path
				];
			}
		} else if (typeof startNode === 'object' && startNode !== null) {
			const keys = Object.keys(startNode).sort();
			for (const objKey of keys) {
				const childValue = (startNode as Record<string, JSONValue>)[objKey];
				const type = getJsonType(childValue);
				const isContainer = typeof childValue === 'object' && childValue !== null;
				const atom: SqlValue = isContainer ? null : childValue as SqlValue;
				const valueForColumn: SqlValue = isContainer ? jsonStringify(childValue) : childValue as SqlValue;
				const fullkey = `${rootFullkey}.${objKey}`;

				yield [
					objKey,         // key
					valueForColumn, // value
					type,           // type
					atom,           // atom
					elementId++,    // id
					null,           // parent
					fullkey,        // fullkey
					rootFullkey     // path
				];
			}
		} else {
			// Scalar input: yield just the scalar itself
			const type = getJsonType(startNode);
			yield [
				null,                    // key
				startNode as SqlValue,   // value
				type,                    // type
				startNode as SqlValue,   // atom
				elementId++,             // id
				null,                    // parent
				rootFullkey,             // fullkey
				rootFullkey              // path
			];
		}
	}
);

// JSON Tree table-valued function
export const jsonTreeFunc = createTableValuedFunction(
	{
		name: 'json_tree',
		numArgs: -1, // Variable arguments (1 or 2)
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'key', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'value', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'atom', type: JSON_MEMBER_COLUMN, generated: true },
				{ name: 'id', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'fullkey', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'path', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			// `id` (column 4) is assigned via an incrementing counter — unique per emitted row.
			keys: [[{ index: 4 }]],
			deterministic: true,
		},
	},
	async function* (jsonInput: SqlValue, rootPath?: SqlValue): AsyncIterable<Row> {
		const parsedJson = coerceToJsonValue(jsonInput);
		if (parsedJson === undefined) {
			throw new QuereusError('Error: Invalid JSON provided to json_tree', StatusCode.ERROR);
		}

		const rootPathStr = (typeof rootPath === 'string' && rootPath) ? rootPath : null;
		let startNode: JSONValue | undefined = parsedJson;

		if (rootPathStr) {
			startNode = evaluateJsonPathBasic(startNode, rootPathStr);
		}

		const localStack: { value: JSONValue; parentPath: string; parentKey: string | number | null; parentId: number; childrenPushed: boolean; }[] = [];
		let localElementIdCounter = 0;

		if (startNode !== undefined) {
			localStack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				childrenPushed: false,
			});
		}

		while (localStack.length > 0) {
			const state = localStack[localStack.length - 1];
			const value = state.value;
			const isContainer = typeof value === 'object' && value !== null;

			if (!state.childrenPushed) {
				const key = state.parentKey;
				const id = ++localElementIdCounter;
				const path = state.parentPath;
				const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
				const type = getJsonType(value);
				const atom = !isContainer ? value : null;
				const valueForColumn = isContainer ? jsonStringify(value) : value;

				const row: Row = [
					key,
					valueForColumn,
					type,
					atom,
					id,
					state.parentId,
					fullkey,
					path
				];
				state.childrenPushed = true;
				yield row;

				if (isContainer) {
					const parentIdForRow = id;
					const parentFullKeyForRow = fullkey;

					if (Array.isArray(value)) {
						for (let i = value.length - 1; i >= 0; i--) {
							localStack.push({
								value: value[i],
								parentPath: parentFullKeyForRow,
								parentKey: i,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					} else {
						const keys = Object.keys(value).sort().reverse();
						for (const objKey of keys) {
							localStack.push({
								value: (value as Record<string, JSONValue>)[objKey],
								parentPath: parentFullKeyForRow,
								parentKey: objKey,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					}
					continue;
				}
			}
			localStack.pop();
		}
	}
);
