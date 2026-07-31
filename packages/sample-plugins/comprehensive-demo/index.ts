/**
 * Comprehensive Demo Plugin for Quereus
 *
 * Demonstrates all three types of registrations in one plugin:
 * - Virtual Table: A simple in-memory key-value store
 * - Functions: Math utilities and data conversion
 * - Collations: Case-insensitive with Unicode normalization
 */

import {
	VirtualTable,
	FunctionFlags,
	createScalarFunction,
	createTableValuedFunction,
	scalarReturn,
	TEXT_RETURN,
	INTEGER_RETURN,
	REAL_RETURN,
	TEXT_TYPE,
} from '@quereus/quereus';
import type {
	Database,
	SqlValue,
	Row,
	CollationFunction,
	PluginRegistrations,
	VirtualTableModule,
	UpdateArgs,
	UpdateResult,
	FilterInfo,
} from '@quereus/quereus';
import type { TableSchema } from '@quereus/quereus';

export const manifest = {
	name: 'Comprehensive Demo',
	version: '1.0.0',
	author: 'Quereus Team',
	description: 'Demonstrates virtual tables, functions, and collations in a single plugin',
	provides: {
		vtables: ['key_value_store'],
		functions: ['math_round_to', 'hex_to_int', 'int_to_hex', 'data_summary'],
		collations: ['UNICODE_CI']
	}
};

// --- Virtual Table: Key-Value Store ---

class KeyValueTable extends VirtualTable {
	readonly store: Map<string, string>;

	constructor(db: Database, module: VirtualTableModule<KeyValueTable>, schemaName: string, tableName: string, store: Map<string, string>) {
		super(db, module, schemaName, tableName);
		this.store = store;
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		const snapshot = [...this.store.entries()];
		for (const [key, value] of snapshot) {
			yield [key, value];
		}
	}

	async update(args: UpdateArgs): Promise<UpdateResult> {
		switch (args.operation) {
			case 'insert': {
				const [key, value] = args.values as Row;
				this.store.set(String(key), String(value ?? ''));
				return { status: 'ok', row: args.values };
			}
			case 'update': {
				const oldKey = String((args.oldKeyValues as Row)[0]);
				const [newKey, newValue] = args.values as Row;
				this.store.delete(oldKey);
				this.store.set(String(newKey), String(newValue ?? ''));
				return { status: 'ok', row: args.values };
			}
			case 'delete': {
				const key = String((args.oldKeyValues as Row)[0]);
				this.store.delete(key);
				return { status: 'ok' };
			}
			default:
				return { status: 'ok' };
		}
	}
}

const storesByDb = new WeakMap<Database, Map<string, Map<string, string>>>();

function getOrCreateStore(db: Database, schemaName: string, tableName: string): Map<string, string> {
	let dbStores = storesByDb.get(db);
	if (!dbStores) {
		dbStores = new Map();
		storesByDb.set(db, dbStores);
	}
	const key = `${schemaName}.${tableName}`.toLowerCase();
	let store = dbStores.get(key);
	if (!store) {
		store = new Map();
		dbStores.set(key, store);
	}
	return store;
}

const keyValueModule: VirtualTableModule<KeyValueTable> = {
	async create(db: Database, tableSchema: TableSchema): Promise<KeyValueTable> {
		const store = getOrCreateStore(db, tableSchema.schemaName, tableSchema.name);
		const table = new KeyValueTable(db, keyValueModule, tableSchema.schemaName, tableSchema.name, store);
		table.tableSchema = tableSchema;
		return table;
	},

	async connect(db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string): Promise<KeyValueTable> {
		const store = getOrCreateStore(db, schemaName, tableName);
		return new KeyValueTable(db, keyValueModule, schemaName, tableName, store);
	},

	async destroy(db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string): Promise<void> {
		const dbStores = storesByDb.get(db);
		if (dbStores) {
			dbStores.delete(`${schemaName}.${tableName}`.toLowerCase());
		}
	}
};

// --- Functions: Math and Data Utilities ---

const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

function mathRoundTo(value: SqlValue, precision: SqlValue): SqlValue {
	if (value === null || value === undefined) return null;
	if (precision === null || precision === undefined) return null;

	const num = Number(value);
	const prec = Math.max(0, Math.floor(Number(precision)));
	const factor = Math.pow(10, prec);

	return Math.round(num * factor) / factor;
}

function hexToInt(hexStr: SqlValue): SqlValue {
	if (hexStr === null || hexStr === undefined) return null;

	const str = String(hexStr).replace(/^0x/i, '');
	const result = parseInt(str, 16);

	return isNaN(result) ? null : result;
}

function intToHex(intVal: SqlValue): SqlValue {
	if (intVal === null || intVal === undefined) return null;

	const num = Number(intVal);
	if (!Number.isInteger(num)) return null;

	return '0x' + num.toString(16).toUpperCase();
}

async function* dataSummary(jsonData: SqlValue): AsyncIterable<Row> {
	if (jsonData === null || jsonData === undefined) return;

	let data: unknown;
	try {
		data = JSON.parse(String(jsonData));
	} catch {
		yield ['error', 'Invalid JSON'];
		return;
	}

	if (Array.isArray(data)) {
		yield ['type', 'array'];
		yield ['length', data.length];
		if (data.length > 0) {
			yield ['first_element_type', typeof data[0]];
		}
	} else if (typeof data === 'object' && data !== null) {
		yield ['type', 'object'];
		const keys = Object.keys(data);
		yield ['key_count', keys.length];
		if (keys.length > 0) {
			yield ['first_key', keys[0]];
		}
	} else {
		yield ['type', typeof data];
		yield ['value', String(data)];
	}
}

// --- Collation: Unicode Case-Insensitive ---

const unicodeCaseInsensitive: CollationFunction = (a: string, b: string): number => {
	const normA = a.normalize('NFD').toLowerCase().normalize('NFC');
	const normB = b.normalize('NFD').toLowerCase().normalize('NFC');
	return normA < normB ? -1 : normA > normB ? 1 : 0;
};

// --- Plugin Registration ---

export default function register(_db: Database, _config: Record<string, SqlValue> = {}): PluginRegistrations {
	return {
		vtables: [
			{
				name: 'key_value_store',
				module: keyValueModule,
			}
		],

		functions: [
			{
				schema: createScalarFunction(
					{ name: 'math_round_to', numArgs: 2, flags: DETERMINISTIC_UTF8, returnType: REAL_RETURN },
					mathRoundTo,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'hex_to_int', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: INTEGER_RETURN },
					hexToInt,
				),
			},
			{
				schema: createScalarFunction(
					{ name: 'int_to_hex', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
					intToHex,
				),
			},
			{
				schema: createTableValuedFunction(
					{
						name: 'data_summary',
						numArgs: 1,
						flags: DETERMINISTIC_UTF8,
						returnType: {
							typeClass: 'relation' as const,
							isReadOnly: true,
							isSet: false,
							columns: [
								{ name: 'property', type: scalarReturn(TEXT_TYPE, false) },
								{ name: 'value', type: scalarReturn(TEXT_TYPE) },
							],
							keys: [],
							rowConstraints: [],
						},
					},
					dataSummary,
				),
			},
		],

		collations: [
			{ name: 'UNICODE_CI', func: unicodeCaseInsensitive }
		]
	};
}
