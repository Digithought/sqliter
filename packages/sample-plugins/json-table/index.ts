/**
 * JSON_TABLE Plugin for Quereus
 *
 * Demonstrates how to create a virtual table module for Quereus.
 * Reads JSON data from URLs or files as if it were a SQL table.
 *
 * Usage:
 *   CREATE TABLE my_data (value text) USING json_table(
 *     url = 'https://api.example.com/data.json',
 *     path = '$.items[*]'
 *   );
 */

import { VirtualTable } from '@quereus/quereus';
import type {
	Database,
	SqlValue,
	Row,
	PluginRegistrations,
	VirtualTableModule,
	UpdateArgs,
	UpdateResult,
	FilterInfo,
} from '@quereus/quereus';
import type { TableSchema } from '@quereus/quereus';

export const manifest = {
	name: 'JSON Table',
	version: '1.0.0',
	author: 'Quereus Team',
	description: 'Virtual table module for reading JSON data from URLs or files',
	provides: {
		vtables: ['json_table']
	}
};

function evaluateJsonPath(data: unknown, path: string): unknown[] {
	if (!path || path === '$') {
		return Array.isArray(data) ? data : [data];
	}

	if (path.startsWith('$.') && path.endsWith('[*]')) {
		const property = path.slice(2, -3);
		const value = (data as Record<string, unknown>)[property];
		return Array.isArray(value) ? value : [];
	}

	if (path.startsWith('$.')) {
		const property = path.slice(2);
		const value = (data as Record<string, unknown>)[property];
		return Array.isArray(value) ? value : [value];
	}

	return Array.isArray(data) ? data : [data];
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, SqlValue> {
	const result: Record<string, SqlValue> = {};

	for (const [key, value] of Object.entries(obj)) {
		const newKey = prefix ? `${prefix}_${key}` : key;

		if (value === null || value === undefined) {
			result[newKey] = null;
		} else if (typeof value === 'object' && !Array.isArray(value)) {
			Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
		} else if (Array.isArray(value)) {
			result[newKey] = JSON.stringify(value);
		} else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
			result[newKey] = value;
		} else {
			result[newKey] = String(value);
		}
	}

	return result;
}

async function fetchJsonData(url: string, config: Record<string, SqlValue>): Promise<unknown> {
	const timeout = (config.timeout as number) || 30000;

	if (url.startsWith('http://') || url.startsWith('https://')) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					'User-Agent': (config.user_agent as string) || 'Quereus JSON_TABLE Plugin/1.0.0',
					'Accept': 'application/json'
				}
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			return await response.json();
		} catch (error) {
			clearTimeout(timeoutId);
			throw new Error(`Failed to fetch JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (url.startsWith('file:')) {
		try {
			const fs = await import('fs/promises');
			const filePath = url.replace(/^file:\/\//, '');
			const content = await fs.readFile(filePath, 'utf-8');
			return JSON.parse(content);
		} catch (error) {
			throw new Error(`Failed to read JSON file ${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(`Unsupported URL scheme: ${url}`);
}

class JsonTable extends VirtualTable {
	private data: unknown[] | null = null;
	private columns: string[] | null = null;
	private readonly options: Record<string, SqlValue>;

	constructor(
		db: Database,
		module: VirtualTableModule<JsonTable>,
		schemaName: string,
		tableName: string,
		tableSchema: TableSchema,
		options: Record<string, SqlValue>,
	) {
		super(db, module, schemaName, tableName);
		this.tableSchema = tableSchema;
		this.options = options;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.data !== null) return;

		const args = this.options;
		const url = typeof args.url === 'string' ? args.url : '';
		const inline = typeof args.inline === 'string' ? args.inline : undefined;
		const path = typeof args.path === 'string' ? args.path : '$';

		let rawData: unknown;
		if (inline !== undefined) {
			try {
				rawData = JSON.parse(inline);
			} catch {
				rawData = [];
			}
		} else {
			rawData = await fetchJsonData(url, args);
		}

		const items = evaluateJsonPath(rawData, path);
		this.data = Array.isArray(items) ? items : [];

		this.columns = this.tableSchema?.columns && this.tableSchema.columns.length > 0
			? this.tableSchema.columns.map(c => c.name)
			: ['value'];
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		await this.ensureLoaded();
		const cols = this.columns!;

		for (const item of this.data!) {
			if (cols.length === 1 && cols[0] === 'value') {
				yield [typeof item === 'object' ? JSON.stringify(item) : item as SqlValue];
			} else {
				const flat = typeof item === 'object' && item !== null
					? flattenObject(item as Record<string, unknown>)
					: { value: item as SqlValue };
				yield cols.map(name => Object.prototype.hasOwnProperty.call(flat, name) ? flat[name] : null);
			}
		}
	}

	async update(_args: UpdateArgs): Promise<UpdateResult> {
		throw new Error('json_table is read-only');
	}
}

const tableSchemas = new Map<string, TableSchema>();

function schemaKey(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`.toLowerCase();
}

const jsonTableModule: VirtualTableModule<JsonTable> = {
	async create(db: Database, tableSchema: TableSchema): Promise<JsonTable> {
		tableSchemas.set(schemaKey(tableSchema.schemaName, tableSchema.name), tableSchema);
		const options = (tableSchema.vtabArgs ?? {}) as Record<string, SqlValue>;
		return new JsonTable(db, jsonTableModule, tableSchema.schemaName, tableSchema.name, tableSchema, options);
	},

	async connect(db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string, options: unknown, tableSchema?: TableSchema): Promise<JsonTable> {
		const cached = tableSchemas.get(schemaKey(schemaName, tableName));
		const schema = tableSchema ?? cached ?? {
			name: tableName,
			schemaName,
			columns: [],
			columnIndexMap: new Map(),
			primaryKeyDefinition: [],
			checkConstraints: [],
			isTemporary: false,
			isView: false,
			vtabModuleName: 'json_table',
			vtabArgs: options ?? {}
		} as unknown as TableSchema;
		const effectiveOptions = (options ?? schema.vtabArgs ?? {}) as Record<string, SqlValue>;
		return new JsonTable(db, jsonTableModule, schemaName, tableName, schema, effectiveOptions);
	},

	async destroy(_db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string): Promise<void> {
		tableSchemas.delete(schemaKey(schemaName, tableName));
	}
};

export default function register(_db: Database, _config: Record<string, SqlValue> = {}): PluginRegistrations {
	return {
		vtables: [
			{
				name: 'json_table',
				module: jsonTableModule,
			}
		]
	};
}
