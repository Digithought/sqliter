# Quereus Plugin System (package.json–centric)

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Quereus plugins are standard ESM packages that declare their capabilities in `package.json` and expose a single runtime entry. At runtime, the module provides registrations for:

- **Virtual Tables** — Custom data sources that appear as SQL tables
- **Functions** — Custom SQL functions (scalar, aggregate, table-valued)
- **Collations** — Custom text sorting and comparison behaviors

This document standardizes how plugins are published, discovered, and loaded using `package.json`. There is no legacy mode to support.

## Authoring a plugin

### package.json requirements

- Use ESM: set `"type": "module"`.
- Add `keywords: ["quereus-plugin"]` for discovery.
- Expose a dedicated plugin entry using the `exports` subpath `./plugin`:

```json
{
  "name": "@acme/quereus-plugin-foo",
  "type": "module",
  "version": "1.2.3",
  "description": "Foo sources as virtual tables + helpers",
  "author": "Acme Inc.",
  "keywords": ["quereus-plugin"],
  "exports": {
    "./plugin": {
      "types": "./dist/plugin.d.ts",
      "browser": "./dist/plugin.browser.js",
      "default": "./dist/plugin.js"
    }
  },
  "peerDependencies": {
    "@quereus/quereus": "^0.24.0"
  },
  "engines": {
    "quereus": "^0.24.0"
  },
  "quereus": {
    "provides": {
      "vtables": ["foo_items"],
      "functions": ["foo_hash"],
      "collations": ["FOO_NATURAL"]
    },
    "settings": [
      { "key": "api_key", "label": "API Key", "type": "string" },
      { "key": "timeout", "label": "Timeout (ms)", "type": "number", "default": 5000 },
      { "key": "debug", "label": "Debug", "type": "boolean", "default": false }
    ]
  }
}
```

Notes:
- Root fields like `name`, `version`, `description`, `author` are canonical — do not duplicate them under `quereus`.
- Place plugin‑specific metadata under the top‑level `quereus` object:
  - `quereus.provides` — capabilities for display and review
  - `quereus.settings` — configuration schema for UIs/hosts
- Version gating should be declared at the root via `engines.quereus` or `peerDependencies['@quereus/quereus']`. Hosts should error if the declared range is incompatible.

### Runtime module contract

The export at `exports['./plugin']` must be an ES module that exports a default `register(db, config)` function. Plugin metadata is read from `package.json` at load time.

```typescript
// ./dist/plugin.ts
import type { Database, SqlValue } from '@quereus/quereus';

export default function register(
  db: Database,
  config: Record<string, SqlValue> = {}
) {
  return {
    vtables: [/* vtable registrations */],
    functions: [/* function registrations */],
    collations: [/* collation registrations */]
  };
}
```

The plugin's metadata is automatically extracted from `package.json` when the plugin is loaded. The loader looks for:
- Root fields: `name`, `version`, `description`, `author`
- Plugin-specific metadata under `quereus` object: `provides`, `settings`, `pragmaPrefix`, `capabilities`

### Registration Function

The default export receives the database instance and user configuration and returns registrations. See examples below for virtual tables, functions, and collations.

## Virtual Table Plugins

Virtual tables allow you to expose external data sources as SQL tables. Use the exported TypeScript types for full type safety.

**For comprehensive module authoring guidance**, including optimization integration, the Retrieve boundary architecture, and best practices, see the [Module Authoring Guide](module-authoring.md). This section covers plugin packaging; the authoring guide covers module implementation details.

**For reactive patterns with mutation and schema change events**, see [Database-Level Event System](module-events.md).

### Basic Virtual Table

```typescript
import {
  VirtualTable,
  VirtualTableModule,
  BaseModuleConfig,
  Database,
  TableSchema,
  Row,
  BestAccessPlanRequest,
  BestAccessPlanResult,
  AccessPlanBuilder
} from 'quereus';

// Configuration interface for your module
interface MyTableConfig extends BaseModuleConfig {
  initialData?: Row[];
}

// Virtual table implementation extending the base class
class MyTable extends VirtualTable {
  private data: Row[] = [];

  constructor(
    db: Database, 
    module: VirtualTableModule<any, any>, 
    schemaName: string, 
    tableName: string,
    config: MyTableConfig
  ) {
    super(db, module, schemaName, tableName);
    this.data = config.initialData || [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];
  }

  // Modern query planning interface
  getBestAccessPlan(request: BestAccessPlanRequest): BestAccessPlanResult {
    // For simple tables, use full scan
    return AccessPlanBuilder.fullScan(this.data.length)
      .setHandledFilters(request.filters.map(() => false))
      .setExplanation('Simple table scan')
      .build();
  }

  // Query implementation using async iterator
  async* query(): AsyncIterable<Row> {
    for (const row of this.data) {
      yield row;
    }
  }

  // Update operations (INSERT, UPDATE, DELETE)
  async update(operation: any, values: Row | undefined, oldKeyValues?: Row, onConflict?: ConflictResolution): Promise<Row | undefined> {
    if (operation === 'INSERT' && values) {
      this.data.push(values);
      return values;
    }
    // Handle UPDATE and DELETE as needed
    return undefined;
  }

  async disconnect(): Promise<void> {
    // Cleanup resources
  }
}

// Module implementation
class MyTableModule implements VirtualTableModule<MyTable, MyTableConfig> {
  async create(db: Database, tableSchema: TableSchema): Promise<MyTable> {
    const config: MyTableConfig = {}; // Parse from tableSchema if needed
    return new MyTable(db, this, tableSchema.schemaName, tableSchema.tableName, config);
  }

  async connect(
    db: Database,
    pAux: unknown,
    moduleName: string,
    schemaName: string,
    tableName: string,
    options: MyTableConfig
  ): Promise<MyTable> {
    return new MyTable(db, this, schemaName, tableName, options);
  }

  getBestAccessPlan(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult {
    return AccessPlanBuilder.fullScan(100) // Estimated row count
      .setHandledFilters(request.filters.map(() => false))
      .build();
  }

  async destroy(): Promise<void> {
    // Cleanup persistent resources
  }
}

export default function register(db: Database, config: MyTableConfig) {
  return {
    vtables: [
      {
        name: 'my_table',
        module: new MyTableModule(),
        auxData: config
      }
    ]
  };
}
```

### Modern Query Planning

For advanced optimization, implement the modern planning interface:

```typescript
import {
  BestAccessPlanRequest,
  BestAccessPlanResult,
  AccessPlanBuilder,
  ConstraintOp,
  PredicateConstraint
} from 'quereus';

class AdvancedTable extends VirtualTable {
  getBestAccessPlan(request: BestAccessPlanRequest): BestAccessPlanResult {
    // Check for equality constraints on indexed columns
    const eqConstraints = request.filters.filter(f => 
      f.op === '=' && f.usable && this.isIndexedColumn(f.columnIndex)
    );

    if (eqConstraints.length > 0) {
      // Use index for equality lookups
      const handledFilters = request.filters.map(f => 
        eqConstraints.includes(f)
      );
      
      return AccessPlanBuilder.eqMatch(1) // Expect 1 row for unique lookup
        .setHandledFilters(handledFilters)
        .setOrdering(this.getIndexOrdering())
        .setIsSet(true) // Guarantees unique rows
        .setExplanation('Index equality seek on primary key')
        .build();
    }

    // Fall back to full scan
    return AccessPlanBuilder.fullScan(this.getEstimatedRowCount())
      .setHandledFilters(request.filters.map(() => false))
      .build();
  }

  private isIndexedColumn(columnIndex: number): boolean {
    // Check if column has an index
    return columnIndex === 0; // Example: first column is indexed
  }

  private getIndexOrdering() {
    return [{ columnIndex: 0, desc: false }];
  }
}
```

### Legacy Compatibility

For compatibility with older planning systems, also implement `xBestIndex`:

```typescript
xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
  // Convert legacy IndexInfo to modern BestAccessPlanRequest
  const filters: PredicateConstraint[] = indexInfo.aConstraint.map(constraint => ({
    columnIndex: constraint.iColumn,
    op: this.mapConstraintOp(constraint.op),
    usable: constraint.usable
  }));

  const request: BestAccessPlanRequest = {
    columns: this.getColumnMetadata(),
    filters: filters
  };

  const result = this.getBestAccessPlan(request);
  
  // Map back to legacy IndexInfo format
  indexInfo.estimatedCost = result.cost;
  indexInfo.estimatedRows = BigInt(result.rows || 0);
  indexInfo.orderByConsumed = result.providesOrdering !== undefined;
  
  return StatusCode.OK;
}
```

### Usage

```sql
-- Create table using the plugin
CREATE TABLE users USING my_table();

-- Query the table
SELECT * FROM users WHERE id > 1;
```

## Catalog Introspection for Declarative Schema

Declarative schema diffing is performed in the engine. Modules continue to use the DDL‑oriented interface for creation and alteration. Optionally, a module can expose its current catalog so Quereus can compute precise diffs and produce canonical DDL.

Optional API:

```typescript
interface CatalogObject {
  kind: 'table' | 'index' | 'view' | 'domain' | 'collation';
  schemaName: string;
  name: string;
  ddl: string;                // Canonical DDL for this object
}

interface VirtualTableModule<...> {
  // Return module's catalog across all schemas or limited to one
  xGetCatalog?(db: Database, options?: { schema?: string }): Promise<ReadonlyArray<CatalogObject>> | ReadonlyArray<CatalogObject>;
}
```

Notes:
- Engine diff compares declared schema against the union of module catalogs and in‑engine state.
- `diff schema` outputs canonical DDL statements; users may run them or invoke `apply schema` to auto‑execute.
- `using ...` remains optional in declarations; default module selection is respected.

## Function Plugins

Functions extend SQL with custom computational logic. For the complete list of built-in functions (scalar, aggregate, window, JSON, date/time), see the [Built-in Functions Reference](functions.md).

Build every function schema with one of the `create*` helpers (`createScalarFunction`, `createTableValuedFunction`, `createAggregateFunction`). They fill in the defaults and are type-checked against the schema the engine actually expects — see [Declaring return types](#declaring-return-types) for what a `returnType` must look like and what happens if it is wrong.

### Scalar Functions

Return a single value:

```typescript
import { createScalarFunction, FunctionFlags, TEXT_RETURN } from '@quereus/quereus';
import type { Database, SqlValue } from '@quereus/quereus';

const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

function reverse(text: SqlValue): SqlValue {
  if (text === null || text === undefined) return null;
  return String(text).split('').reverse().join('');
}

export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  return {
    functions: [
      {
        schema: createScalarFunction(
          { name: 'reverse', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
          reverse
        )
      }
    ]
  };
}
```

### Table-Valued Functions

Return multiple rows. The implementation is an **async generator** (its declared type is `(...args) => MaybePromise<AsyncIterable<Row>>`), and each row it yields is an **array of values in declared column order** — not an object keyed by column name:

```typescript
import { createTableValuedFunction, FunctionFlags, scalarReturn, INTEGER_TYPE, TEXT_TYPE } from '@quereus/quereus';
import type { Database, Row, SqlValue } from '@quereus/quereus';

const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

async function* splitString(text: SqlValue, delimiter: SqlValue): AsyncIterable<Row> {
  if (text === null || text === undefined) return;

  const parts = String(text).split(String(delimiter ?? ','));
  for (let i = 0; i < parts.length; i++) {
    yield [i + 1, parts[i].trim()];
  }
}

export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  return {
    functions: [
      {
        schema: createTableValuedFunction(
          {
            name: 'split_string',
            numArgs: 2,
            flags: DETERMINISTIC_UTF8,
            returnType: {
              typeClass: 'relation',
              isReadOnly: true,
              isSet: false,
              columns: [
                { name: 'ordinal', type: scalarReturn(INTEGER_TYPE, false) },
                { name: 'value', type: scalarReturn(TEXT_TYPE, false) }
              ],
              keys: [],
              rowConstraints: []
            }
          },
          splitString
        )
      }
    ]
  };
}
```

Declared columns are what makes `select ordinal, value from split_string(...)` and `... where value = 'b'` resolve; a table-valued function that declares none has no referenceable column names.

### Aggregate Functions

Accumulate values across rows:

```typescript
import { createAggregateFunction, FunctionFlags, TEXT_RETURN } from '@quereus/quereus';
import type { Database, SqlValue } from '@quereus/quereus';

const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

function concatenateStep(accumulator: string, value: SqlValue): string {
  if (value === null || value === undefined) return accumulator;
  return accumulator + String(value);
}

function concatenateFinal(accumulator: string): SqlValue {
  return accumulator;
}

export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  return {
    functions: [
      {
        schema: createAggregateFunction(
          { name: 'str_concat', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN, initialValue: '' },
          concatenateStep,
          concatenateFinal
        )
      }
    ]
  };
}
```

### Declaring return types

Every function schema carries a `returnType`, and there is exactly one contract for it — the same one whether you build the schema by hand or through a `create*` helper.

A **scalar** return type names a *logical type object*, not a type-name string:

```typescript
import { scalarReturn, TEXT_TYPE } from '@quereus/quereus';

scalarReturn(TEXT_TYPE)         // { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }
scalarReturn(TEXT_TYPE, false)  // ...the same, declared NOT NULL
```

Ready-made constants cover the common cases: `TEXT_RETURN`, `INTEGER_RETURN`, `REAL_RETURN`, `BOOLEAN_RETURN`, `BLOB_RETURN`, `JSON_RETURN`, `ANY_RETURN`, plus `*_RETURN_NOT_NULL` variants for the ones that can never return NULL. A **relation** return type (table-valued functions) gives each column a `name` and a scalar type object as its `type` — again, not a type-name string. The shapes themselves are exported as types (`ScalarType`, `RelationType`, `ColumnDef`, `ColRef`) for plugins that build them outside a `create*` call.

Rules:

- **Omitting `returnType` is allowed** and means "unknown": it becomes a nullable scalar of type ANY. That is safe, but it forfeits plan-time typing, comparison specialization and cross-type coercion — declare the truth when you know it.
- **A schema with an `implementation` and no `returnType` is taken to be scalar.** Nothing else distinguishes a scalar from a table-valued function, and a table-valued function with no declared columns is useless anyway. A table-valued function must therefore declare its columns, or be built with `createTableValuedFunction`.
- **A relation's `isReadOnly`, `isSet`, `keys` and `rowConstraints` may be omitted**, and so may a scalar type's `nullable` (absent means nullable) — each has one obvious answer for a function that says nothing about it, and registration fills it in. Only `columns` carries meaning you have to supply.
- **A relation's `keys` declare uniqueness the engine trusts.** Each entry is an array of `{ index }` references into the declared columns (`[]` inside `keys` is the *empty key* — the function returns at most one row; `keys: []` declares no key at all). A key the function does not actually enforce makes the planner drop a DISTINCT or under-count a join, so declare one only if every row really is unique on those columns.
- **A malformed `returnType` is rejected at registration** with a `MisuseError` naming the function and the offending field. Registration does not quietly downgrade a typo to "unknown" — a wrong-shaped declaration that registers successfully only fails much later, at query planning time, with an error that names neither the function nor the problem. Malformed means: a `typeClass` that is missing or is neither `'scalar'` nor `'relation'`; a scalar whose `logicalType` is missing or is not a type object; a relation whose `columns` is not an array, or whose columns lack a `name` or carry a `type` that is not a scalar type object; a relation whose `rowConstraints` is present but is not an array; a relation whose `keys` is present but is not an array of arrays of `{ index }` references pointing at declared columns.

Older documentation showed `returnType: { typeClass: 'scalar', sqlType: 'TEXT' }` and relation columns typed `{ name: 'v', type: 'INTEGER' }`. Neither shape has ever been read by the engine; both are now rejected at registration.

#### Returning values in the right JavaScript form

A declared `returnType` is a promise about the *value*, not only about the plan. The engine does not coerce what a function returns — coercing every call would cost on every row for no gain on a correct function — so an implementation must hand back the JavaScript form its declared type calls for. The rules are in [types.md § Physical representation](./types.md#physical-representation); the two that catch people out:

- **One JavaScript form per whole number.** A whole number is a `number` while its magnitude stays inside the safe-integer range (|v| ≤ 2<sup>53</sup> − 1) and a `bigint` only outside it. Wrapping a small result in `BigInt(...)` is a violation even though the value is right — `canonicalizeInteger` and `canonicalizeSqlValue` (exported from the package) return the canonical form. A function declaring INTEGER may return either form under that rule; one declaring REAL must return a `number`.
- **Most temporal types are physically text.** A DATE / TIME / DATETIME / TIMESPAN value is a `string`, not a `Temporal` object. TIMESTAMP is the exception: it is an integer instant and takes INTEGER's rule. A JSON *scalar* is likewise a plain `string` / `number` / `boolean`, not a wrapped object.

`null` is always acceptable regardless of the declared type — nullability is a separate contract. Declaring no `returnType` (ANY) still binds you to the numeric rule, which holds for every value everywhere in the engine.

Run your plugin's tests with `QUEREUS_REPR_STRICT=1` to check this: the engine then verifies every scalar function's returned value against its declared return type and throws naming the function and the offending form. Functions supplying a `customEmitter` build their own runtime path and are not covered by that check.

### Variable Arguments

Use `numArgs: -1` for variadic functions:

```javascript
function myConcat(...args) {
  return args.filter(arg => arg !== null && arg !== undefined)
             .map(arg => String(arg))
             .join('');
}

// Registration with numArgs: -1
```

### Usage

```sql
-- Scalar function
SELECT reverse('hello') AS backwards;

-- Table-valued function
SELECT * FROM split_string('a,b,c', ',');

-- Aggregate function
SELECT str_concat(name) FROM users;
```

## Collation Plugins

Collations control text sorting and comparison behavior. For the `LogicalType` interface, type-specific collation support, and custom type registration, see the [Type System Documentation](types.md#collations-and-types).

### Basic Collation

```typescript
import { Database, CollationFunction } from 'quereus';

const numericCollation: CollationFunction = (a: string, b: string): number => {
  // Parse out numeric parts for natural sorting
  const parseString = (str) => {
    const parts = [];
    let current = '';
    let inNumber = false;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const isDigit = char >= '0' && char <= '9';
      
      if (isDigit !== inNumber) {
        if (current) {
          parts.push(inNumber ? Number(current) : current);
          current = '';
        }
        inNumber = isDigit;
      }
      current += char;
    }
    
    if (current) {
      parts.push(inNumber ? Number(current) : current);
    }
    
    return parts;
  };
  
  const partsA = parseString(a);
  const partsB = parseString(b);
  
  const maxLen = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i];
    const partB = partsB[i];
    
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    
    if (typeof partA === 'number' && typeof partB === 'number') {
      if (partA !== partB) return partA < partB ? -1 : 1;
    } else {
      const strA = String(partA);
      const strB = String(partB);
      if (strA !== strB) return strA < strB ? -1 : 1;
    }
  }
  
  return 0;
}

export default function register(db, config) {
  return {
    collations: [
      {
        name: 'NUMERIC',
        func: numericCollation
      }
    ]
  };
}
```

### Usage

```sql
-- Use custom collation in ORDER BY
SELECT filename FROM files ORDER BY filename COLLATE NUMERIC;

-- Use in comparisons
SELECT * FROM files WHERE filename = 'file10.txt' COLLATE NUMERIC;
```

> **Note** — to use a custom collation as the key for a compound index, a
> `GROUP BY` / `PARTITION BY` key, or a hash-join key, supply a `normalizer`
> alongside `func` (see [Key Normalizers, Grouping, and Index
> Participation](#key-normalizers-grouping-and-index-participation) below).
> Comparator-only registrations work for `ORDER BY` and standalone comparisons;
> index creation and grouping referencing them are rejected.

## Configuration

### Plugin Settings

Define configurable options in your manifest:

```javascript
export const manifest = {
  settings: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'string',
      help: 'Your API key for authentication'
    },
    {
      key: 'timeout',
      label: 'Timeout (ms)',
      type: 'number',
      default: 5000,
      help: 'Request timeout in milliseconds'
    },
    {
      key: 'enabled',
      label: 'Enable Feature',
      type: 'boolean',
      default: true
    },
    {
      key: 'mode',
      label: 'Operating Mode',
      type: 'select',
      options: ['fast', 'accurate', 'balanced'],
      default: 'balanced'
    }
  ]
};
```

### Using Configuration

```javascript
export default function register(db, config) {
  // Access configuration values
  const apiKey = config.api_key;
  const timeout = config.timeout || 5000;
  const enabled = config.enabled !== false;
  
  // Use in your plugin logic
  if (!enabled) {
    return { vtables: [], functions: [], collations: [] };
  }
  
  // ... rest of registration
}
```

## Complete Example

Here's a comprehensive plugin that demonstrates all three types. Note that metadata is defined in `package.json`, not in the plugin code:

**package.json:**
```json
{
  "name": "@acme/quereus-plugin-demo",
  "version": "1.0.0",
  "type": "module",
  "description": "Demonstrates all plugin types",
  "exports": {
    "./plugin": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "quereus": {
    "provides": {
      "vtables": ["key_value"],
      "functions": ["upper_reverse"],
      "collations": ["LENGTH"]
    },
    "settings": [
      {
        "key": "debug",
        "label": "Debug Mode",
        "type": "boolean",
        "default": false
      }
    ]
  }
}
```

**index.ts:**
```typescript
import { createScalarFunction, FunctionFlags, TEXT_RETURN } from '@quereus/quereus';
import type { Database, SqlValue, CollationFunction } from '@quereus/quereus';

// Virtual table: simple key-value store
class KeyValueStore {
  private store = new Map<string, string>();

  getSchema(): string {
    return 'CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT)';
  }

  *scan(): Generator<Record<string, string>> {
    for (const [key, value] of this.store) {
      yield { key, value };
    }
  }

  insert(row: Record<string, string>): void {
    this.store.set(row.key, row.value);
  }

  delete(row: Record<string, string>): void {
    this.store.delete(row.key);
  }
}

// Function: uppercase and reverse
function upperReverse(text: SqlValue): SqlValue {
  if (text === null || text === undefined) return null;
  return String(text).toUpperCase().split('').reverse().join('');
}

// Collation: sort by length
const lengthCollation: CollationFunction = (a: string, b: string): number => {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  if (config.debug) {
    console.log('Demo plugin loading...');
  }

  return {
    vtables: [
      {
        name: 'key_value',
        module: {
          create: async (db: Database, tableSchema: any) => {
            const table = new KeyValueStore();
            return {
              db,
              module: this,
              schemaName: tableSchema.schemaName,
              tableName: tableSchema.name,
              async disconnect() {},
              async update() { return undefined; },
              async *query() {
                for (const row of table.scan()) {
                  yield [row.key, row.value];
                }
              }
            };
          },
          connect: async (db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string, _options: any) => {
            // Connect also returns a Promise for async initialization
            const table = new KeyValueStore();
            return {
              db,
              module: this,
              schemaName,
              tableName,
              async disconnect() {},
              async update() { return undefined; },
              async *query() {
                for (const row of table.scan()) {
                  yield [row.key, row.value];
                }
              }
            };
          }
        }
      }
    ],

    functions: [
      {
        schema: createScalarFunction(
          { name: 'upper_reverse', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC, returnType: TEXT_RETURN },
          upperReverse
        )
      }
    ],

    collations: [
      {
        name: 'LENGTH',
        func: lengthCollation
      }
    ]
  };
}
```

## TypeScript Benefits

Plugins are now best developed in TypeScript for full type safety and IDE support. The build process compiles TypeScript to JavaScript for distribution.

### Full Type Safety

```typescript
import { createScalarFunction, FunctionFlags, TEXT_RETURN } from '@quereus/quereus';
import type { Database, SqlValue, CollationFunction } from '@quereus/quereus';

// Compile-time checking of function implementations
function myFunction(text: SqlValue): SqlValue {
  // Type-safe parameter handling
  if (text === null || text === undefined) return null;
  return String(text).toUpperCase();
}

// Type-safe collation function
const myCollation: CollationFunction = (a: string, b: string): number => {
  return a < b ? -1 : a > b ? 1 : 0;
};

// Type-safe registration
export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  return {
    functions: [{
      // createScalarFunction type-checks the whole schema — including the
      // returnType shape — at compile time
      schema: createScalarFunction(
        { name: 'my_function', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC, returnType: TEXT_RETURN },
        myFunction
      )
    }],
    collations: [{
      name: 'MY_COLLATION',
      func: myCollation  // Type-checked at compile time
    }]
  };
}
```

### IntelliSense and Documentation

IDEs provide rich autocomplete and inline documentation for all exported types:

- Function signatures with parameter types
- Enum values with descriptions
- Interface properties with documentation
- Import suggestions for missing types

### Build Configuration

Each plugin should have a `tsconfig.json` and build script:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "declaration": true,
    "outDir": "./dist",
    "strict": true
  },
  "include": ["index.ts"]
}
```

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  }
}
```

## Best Practices

### Error Handling

Always validate inputs and handle errors gracefully:

```javascript
function safeFunction(input) {
  try {
    if (input === null || input === undefined) return null;
    
    // Your logic here
    return result;
  } catch (error) {
    console.error('Plugin error:', error);
    return null; // Or throw a meaningful error
  }
}
```

### Performance

- Use generators for large datasets
- Implement proper caching where appropriate
- Avoid synchronous operations in async contexts

### Security

- Validate all user inputs
- Don't expose sensitive information
- Use secure defaults for configuration

### Documentation

- Document all functions and parameters
- Provide usage examples
- Include performance characteristics

## Installation & loading

### Programmatic loading

**Note:** Plugin loading uses dynamic `import()` and is provided by the separate `@quereus/plugin-loader` package. That package is **not compatible with React Native**. For React Native apps, use static imports and manual plugin registration (see below).

```typescript
import { Database } from '@quereus/quereus';
import { loadPlugin, dynamicLoadModule } from '@quereus/plugin-loader';

const db = new Database();

// 1) Load from npm package name (Node):
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, { api_key: '...' });

// 2a) Load from a direct https:// URL. Native in the browser; in Node this
//     needs the remote resolver installed once at startup (see note below):
import { installNodeRemoteModuleResolver } from '@quereus/plugin-loader/node';
installNodeRemoteModuleResolver();
await dynamicLoadModule('https://example.com/plugin.js', db, { timeout: 10000 });

// 2b) Load from a direct file:// URL (Node):
await dynamicLoadModule('file:///path/to/plugin.mjs', db, { timeout: 10000 });

// 3) Browser npm via CDN (opt-in only):
await loadPlugin('npm:@acme/quereus-plugin-foo@^1', db, { timeout: 8000 }, { allowCdn: true, cdn: 'jsdelivr' });
```

Behavior:
- Allowed module protocols are `https:` and `file:` — enforced inside `dynamicLoadModule`, so any other scheme is refused before an import is attempted.
- **`https:` module loads need a resolver under Node.** Browsers `import('https://…')` natively. Node's ESM loader does not — it accepts only `file:` and `data:` URLs (network imports were experimental and have been removed) — so the loader delegates to a resolver the host installs:

  ```typescript
  import { installNodeRemoteModuleResolver } from '@quereus/plugin-loader/node';

  installNodeRemoteModuleResolver({
    // The SHA-256 this URL must serve, or undefined to leave it unpinned.
    // Consulted on every fetch, and asked with the normalized URL.
    expectedHash: url => myPluginRecords.get(url)?.sha256,
    // Called after each fetch, before the module is imported. Awaited.
    onFetched: ({ url, sha256, bytes }) => console.log(`Fetched ${url} (${bytes} B, sha256 ${sha256})`),
    maxBytes: 5 * 1024 * 1024,   // default
  });
  ```

  The resolver fetches the module, checks that redirects stayed on `https:`, enforces the size cap against both the declared `content-length` and the bytes actually received, SHA-256s them, verifies that digest against `expectedHash`, writes them to a temp file (`<tmpdir>/quereus-plugins-<pid>-<random>/<hash>-<n>.mjs`), and hands the loader that file's `file:` URL. The temp directory is removed when the process exits; files are kept until then so stack traces from inside the plugin still resolve.

  It lives behind the `@quereus/plugin-loader/node` subpath, not the package index, so a browser or React Native bundle never pulls in `node:fs`. Any Node host wanting remote plugins installs it — the quoomb CLI does so at startup, and prints one line per fetch. Without it, a Node-side `https:` load fails with a message saying so, rather than `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

  There is no on-disk cache: a plugin saved by URL re-downloads and re-executes remote code on every host start. That is why `onFetched` exists — hosts are expected to surface the fetch rather than let it happen silently.

- **Hash pinning gates the load, and is opt-in.** `expectedHash` returning `undefined` means "not pinned" and the load proceeds unchanged; returning a digest that the fetched bytes do not match aborts with a `PluginHashMismatchError` (exported from the package index) *before* the temp file is written, before `onFetched` fires, and before the import — the rejected code never evaluates. A returned value that is not 64 hex characters is a host bug and fails the load, rather than being read as "unpinned", so a typo cannot silently disarm the pin. `dynamicLoadModule` wraps every failure in `Failed to load plugin from <url>: …`, keeping the original on `error.cause`, so a caller distinguishes a mismatch with `error.cause instanceof PluginHashMismatchError`.

  Scope: pinning is a property of the *Node resolver*. Browsers and workers install no resolver — they `import('https://…')` natively with no verification — and `file:` URLs never reach the resolver, so a pin on one is inert. `hashRemoteModule(url, { maxBytes, fetchImpl })` from the same subpath answers "what does this URL serve right now?" using the same transport checks and cap, writing nothing and importing nothing; it is a separate fetch from any load that follows, so bytes that change in between make the pinned load fail (closed, which is the right direction).

  The CLI records each plugin's hash in `~/.quoomb/plugins.json` (`PluginRecord.sha256`) and, by default, warns when the module behind a URL has changed since it was installed. That comparison happens after the load, so the warning reports code that has already run — a change notice, not a gate.

  Setting `PluginRecord.pinned` turns it into a gate: the CLI feeds every pinned record's `sha256` to `expectedHash`, so a mismatch is refused before the module is imported. It is opt-in per plugin (`.plugin install <url> --pin`, or `.plugin pin <name>`), and a pinned record with no recorded hash is a first observation rather than a violation — the next successful load records one and enforcement starts there. `.plugin trust <name> [hash]` records a new expected hash (fetching and digesting the URL without importing it when no hash is given), `.plugin unpin <name>` goes back to warning; both take effect in the same session. A pin that a startup load refuses does *not* disable the plugin — the code changed, the plugin is not broken — and the CLI prints those two remedies instead. `pinned` is meaningful only in a host that installed the Node resolver: quoomb-web keeps its own record type and imports `https:` URLs natively, with no verification step.

  A plugin loaded from `quoomb.config.json` can declare its expected hash directly on the entry, instead of (or alongside) a `.plugin pin` on the installed record:

  ```json
  {
    "plugins": [
      { "source": "https://example.com/plugin.js", "sha256": "3f29b8...(64 hex chars)" }
    ]
  }
  ```

  Enforced the same way as a pinned record — refused before the module is imported — but `sha256` is only ever checked on an `https:` source, since only those reach the Node remote resolver. Declaring it on an `npm:` spec, a bare package name, or a `file:` source is a startup error naming the entry, not a silent no-op; so is a `sha256` that is not 64 hex characters, an empty one included, and so is listing one URL twice with two different hashes (one URL is one download; either choice would ignore what the other entry asked for). Every entry is checked and all the problems are reported together. A config file with any unusable `sha256` loads none of its plugins that run — but the entries that *did* validate still pin their URLs, which matters because the same URL can also be loaded from the saved records.

  When the same URL is pinned by both the config file and a saved plugin record to different hashes, the config file's hash wins. The CLI warns once at startup, naming the URL and both values, and `.plugin pin`, `.plugin unpin` and `.plugin trust` each say so too when the record they just changed is outranked — otherwise they would report a hash that no load checks. For the same reason, a load refused by a config-declared hash points at the config file rather than at `.plugin trust`, which cannot lift it.
- npm package resolution prefers the `exports['./plugin']` subpath. In Node, the package is loaded directly. In browsers, npm resolution is disabled by default; enabling it requires `{ allowCdn: true }` and maps to a CDN URL.
- Version compatibility: if the package declares `engines.quereus` or a `peerDependency` on `@quereus/quereus`, hosts should throw when incompatible (error, not warning).

### Static Plugin Loading

For environments where dynamic `import()` is not supported or desired (React Native, bundled applications, or security-restricted environments), use static imports with manual plugin registration.

#### Why Static Loading?

- **React Native**: Does not support dynamic `import()` even when the code is present
- **Bundled Applications**: Some bundlers work better with static imports
- **Security**: Avoid runtime code loading in restricted environments
- **Performance**: Eliminate runtime module resolution overhead
- **Type Safety**: Get full TypeScript type checking for plugin imports

#### Basic Usage with `registerPlugin`

Quereus provides a built-in `registerPlugin` helper function that simplifies static plugin loading:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import stringFunctions from './plugins/string-functions';
import customCollations from './plugins/custom-collations';
import jsonTable from './plugins/json-table';

const db = new Database();

// Register a single plugin
await registerPlugin(db, stringFunctions);

// Register with configuration
await registerPlugin(db, jsonTable, {
  cacheSize: 100,
  timeout: 5000
});

// Register multiple plugins
await registerPlugin(db, customCollations);
```

The `registerPlugin` function:
- Calls the plugin function with the database and config
- Automatically registers all returned components (vtables, functions, collations, types)
- Provides helpful error messages if registration fails
- Works in any JavaScript environment (Node.js, browser, React Native)

#### Conditional Plugin Loading

You can conditionally load plugins based on environment or feature flags:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import coreFunctions from './plugins/core-functions';
import analytics from './plugins/analytics';
import geoFunctions from './plugins/geo-functions';
import iosStorage from './plugins/ios-storage';
import androidStorage from './plugins/android-storage';

const db = new Database();

// Always load core plugins
await registerPlugin(db, coreFunctions);

// Load optional plugins based on configuration
if (config.features.analytics) {
  await registerPlugin(db, analytics);
}

if (config.features.geospatial) {
  await registerPlugin(db, geoFunctions);
}

// Platform-specific plugins (React Native example)
if (Platform.OS === 'ios') {
  await registerPlugin(db, iosStorage);
} else if (Platform.OS === 'android') {
  await registerPlugin(db, androidStorage);
}
```

#### React Native Example

Complete example for React Native with error handling:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import stringFunctions from '@quereus/plugin-string-functions';
import customCollations from './plugins/custom-collations';

async function initializeDatabase() {
  const db = new Database();

  try {
    // Register plugins
    await registerPlugin(db, stringFunctions);
    await registerPlugin(db, customCollations);

    console.log('Database initialized with plugins');
    return db;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// Usage
const db = await initializeDatabase();

// Now you can use plugin functions
const result = await db.prepare(
  "SELECT reverse('hello') as reversed"
).get();
console.log(result.reversed); // 'olleh'
```

**React Native Required Polyfills:**

React Native apps typically need a few runtime polyfills for Quereus and its plugins:

- **`structuredClone`** - Quereus uses it internally for deep cloning operations
- **`TextEncoder` / `TextDecoder`** - Used by store plugins for binary data encoding
- **`Symbol.asyncIterator`** - Required for async-iterable support (for-await-of loops, async generators)
  - Quereus uses async iterables extensively for query results and data streaming
  - While Hermes has a workaround for AsyncGenerator objects, the `Symbol.asyncIterator` symbol itself must exist
  - Without it, you'll get `ReferenceError: Can't find variable: Symbol` when checking for async iterables

You can use packages like `core-js` or provide your own implementations:

```bash
npm install core-js text-encoding
```

Then in your app's entry point:

```typescript
import 'core-js/features/structured-clone';
import 'text-encoding';

// Ensure Symbol.asyncIterator exists
if (typeof Symbol.asyncIterator === 'undefined') {
  (Symbol as any).asyncIterator = Symbol.for('Symbol.asyncIterator');
}
```

#### Type Safety with Static Imports

Static imports provide full TypeScript type checking:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import myPlugin from './plugins/my-plugin';

const db = new Database();

// Type-checked configuration
await registerPlugin(db, myPlugin, {
  apiKey: 'key',      // ✓ Type-checked
  timeout: 5000,      // ✓ Type-checked
  // invalid: true    // ✗ TypeScript error if not in plugin's config type
});
```

#### Manual Registration (Advanced)

If you need more control, you can manually call the plugin and register components individually:

```typescript
import { Database } from '@quereus/quereus';
import myPlugin from './plugins/my-plugin';

const db = new Database();

// Call the plugin function to get registrations
const registrations = await myPlugin(db, {
  apiKey: 'your-api-key',
  timeout: 5000
});

// Manually register each component type
if (registrations.vtables) {
  for (const vtable of registrations.vtables) {
    db.registerModule(vtable.name, vtable.module, vtable.auxData);
  }
}

if (registrations.functions) {
  for (const func of registrations.functions) {
    db.registerFunction(func.schema);
  }
}

if (registrations.collations) {
  for (const collation of registrations.collations) {
    db.registerCollation(collation.name, collation.func, collation.normalizer);
  }
}

if (registrations.types) {
  for (const type of registrations.types) {
    db.registerType(type.name, type.definition);
  }
}
```

This approach gives you full control over which components to register and allows for custom error handling or logging.

### Web UI

In Quoomb Web, the Plugin Manager accepts either:
- An npm package spec (e.g. `@acme/quereus-plugin-foo@^1`) — may require a CDN if running fully in-browser
- A direct ESM URL (e.g. a GitHub raw link)

The UI reads `package.json.quereus.settings` to render configuration, and surfaces `quereus.provides` as capability badges. The manifest is automatically extracted from the plugin's `package.json` when loaded.

### CLI

The quoomb CLI installs plugins with `.plugin install <url>` and keeps them in `~/.quoomb/plugins.json` (see [`packages/quoomb-cli/README.md`](../packages/quoomb-cli/README.md) for the full subcommand list). Its other subcommands address a plugin by name, so a plugin whose `package.json` probe 404s — normal for a lone `.mjs` on a static host — still needs a name: the CLI derives one from the last path segment of the URL, and accepts the install URL as an identifier as well. The web UI has no such need, since it addresses plugins by the record `id` it assigns at install.



## Troubleshooting

### Common Issues

1. **Plugin not loading** - Check console for error messages
2. **Function not found** - Verify function name and argument count
3. **Collation not working** - Ensure collation name is uppercase
4. **Virtual table errors** - Check schema format and scan method

### Debugging

Enable debug logging:

```javascript
// In your plugin
if (config.debug) {
  console.log('Debug info:', data);
}
```

Set the DEBUG environment variable:

```bash
DEBUG=quereus:* npm start
```

## Examples

See the `packages/sample-plugins/` directory for complete examples:

- `json-table/` - Virtual table for JSON data
- `string-functions/` - Additional string functions
- `custom-collations/` - Custom sorting behaviors
- `comprehensive-demo/` - All plugin types in one

## API Reference

All types and utilities are exported from the main `@quereus/quereus` package for external plugin development.

### Comparison and Coercion Utilities

Critical utilities for implementing virtual table modules and custom functions that match Quereus semantics:

```typescript
// Core comparison functions (match Quereus SQL semantics)
import {
  compareSqlValues,           // Compare two SQL values under BINARY
  compareSqlValuesFast,       // Same, with a pre-resolved collation function
  compareRows,                // Compare entire rows for DISTINCT semantics (BINARY)
  compareTypedValues,         // Type-aware comparison using LogicalType
  createTypedComparator,      // Factory for type-specific comparators
  createTypedRowComparator,   // Factory for typed row comparators
  createCollationRowComparator, // Factory for row comparators with per-column collations

  // ORDER BY comparison utilities
  compareWithOrderByFast,     // Compare with direction, NULL ordering, and a collation function
  createOrderByComparatorFast,// Factory for ORDER BY comparators
  SortDirection,              // Enum: ASC = 0, DESC = 1
  NullsOrdering,              // Enum: DEFAULT = 0, FIRST = 1, LAST = 2

  // Truthiness evaluation
  isTruthy,                   // SQL truthiness for filters

  // Type introspection
  getSqlDataTypeName,         // Get SQL type name: 'null' | 'integer' | 'real' | 'text' | 'blob'

  // Collation functions
  BINARY_COLLATION,           // Standard lexicographical comparison
  NOCASE_COLLATION,           // Case-insensitive comparison
  RTRIM_COLLATION,            // Right-trim comparison
  builtinCollationResolver,   // Built-ins-only name lookup (no Database needed)
  normalizeCollationName,     // Canonical (trimmed, uppercase) collation name
  resolveCollationFunctions,  // Batch name→function resolution via a CollationResolver

  // Coercion utilities
  tryCoerceToNumber,          // Try to convert string to number
  coerceToNumberForArithmetic,// Coerce for arithmetic (non-numeric → 0)
  coerceForComparison,        // Coerce for comparison operations
  coerceForAggregate,         // Coerce for aggregate functions
  isNumericValue,             // Check if value is numeric
} from '@quereus/quereus';
```

**Note on `bigint` comparisons**: `compareSqlValues` may compare `bigint` and `number` using JavaScript relational operators. This can produce surprising results for magnitudes beyond IEEE-754 safe integer range. For deterministic ordering in plugin code, prefer keeping numeric domains consistent (all `bigint` or all `number`) and avoid mixing when values may exceed `Number.MAX_SAFE_INTEGER`.

**Example: Using compareSqlValues in a virtual table**

```typescript
import { compareSqlValues, VirtualTable } from '@quereus/quereus';

class MyTable extends VirtualTable {
  async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
    for (const row of this.data) {
      // Use compareSqlValues to match Quereus semantics
      if (compareSqlValues(row[0], filterInfo.value) === 0) {
        yield row;
      }
    }
  }
}
```

### Core Virtual Table Types

```typescript
// Base class for virtual table implementations
abstract class VirtualTable {
  constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string);
  abstract disconnect(): Promise<void>;
  abstract update(operation: RowOp, values: Row | undefined, oldKeyValues?: Row): Promise<Row | undefined>;

  // Optional methods
  query?(filterInfo: FilterInfo): AsyncIterable<Row>;
  createConnection?(): MaybePromise<VirtualTableConnection>;
  getBestAccessPlan?(request: BestAccessPlanRequest): BestAccessPlanResult;
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  // ... other optional methods
}

// Module interface for creating and managing virtual table instances
interface VirtualTableModule<TTable extends VirtualTable, TConfig extends BaseModuleConfig> {
  create(db: Database, tableSchema: TableSchema): TTable;
  connect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: TConfig): TTable;
  getBestAccessPlan?(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult;
  destroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void>;
}

// Base configuration interface
interface BaseModuleConfig {}

// Connection interface for transaction support
interface VirtualTableConnection {
  readonly connectionId: string;
  readonly tableName: string;
  // Optional: when multiple connections are registered for the same table
  // (e.g. an isolation wrapper plus its underlying storage connection), set
  // this on the wrapper so the deferred-constraint queue can disambiguate.
  readonly isCovering?: boolean;
  begin(): MaybePromise<void>;
  commit(): MaybePromise<void>;
  rollback(): MaybePromise<void>;
  createSavepoint(index: number): MaybePromise<void>;
  releaseSavepoint(index: number): MaybePromise<void>;
  rollbackToSavepoint(index: number): MaybePromise<void>;
  disconnect(): MaybePromise<void>;
}

// Internal database methods for transaction coordination (see module-authoring.md)
interface DatabaseInternal {
  registerConnection(connection: VirtualTableConnection): Promise<void>;
  unregisterConnection(connectionId: string): void;
  getConnection(connectionId: string): VirtualTableConnection | undefined;
  getConnectionsForTable(tableName: string): VirtualTableConnection[];
  getAllConnections(): VirtualTableConnection[];
}
```

### Modern Query Planning Interface

```typescript
// Request object for query planning
interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: readonly OrderingSpec[];
  limit?: number | null;
  estimatedRows?: number;
}

// Result object describing the chosen query plan
interface BestAccessPlanResult {
  handledFilters: readonly boolean[];
  residualFilter?: (row: any) => boolean;
  cost: number;
  rows: number | undefined;
  providesOrdering?: readonly OrderingSpec[];
  isSet?: boolean;
  explains?: string;

  // Optional monotonic-storage advertisements. The optimizer lifts these onto
  // the physical leaf node so downstream rules (streaming asof, monotonic merge
  // join, ordinal-seek pushdown) can rely on storage-level total-order emit.
  monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
  supportsOrdinalSeek?: boolean; // implies monotonicOn
  supportsAsofRight?: boolean;   // implies monotonicOn
}

// Helper class for building access plans
class AccessPlanBuilder {
  static fullScan(estimatedRows: number): AccessPlanBuilder;
  static eqMatch(matchedRows: number, indexCost?: number): AccessPlanBuilder;
  static rangeScan(estimatedRows: number, indexCost?: number): AccessPlanBuilder;
  
  setCost(cost: number): this;
  setRows(rows: number | undefined): this;
  setHandledFilters(handledFilters: readonly boolean[]): this;
  setOrdering(ordering: readonly OrderingSpec[]): this;
  setIsSet(isSet: boolean): this;
  setExplanation(explanation: string): this;
  setResidualFilter(filter: (row: any) => boolean): this;
  build(): BestAccessPlanResult;
}

// Planning primitive types
interface ColumnMeta {
  index: number;
  name: string;
  type: SqlDataType;
  isPrimaryKey: boolean;
  isUnique: boolean;
}

interface PredicateConstraint {
  columnIndex: number;
  op: ConstraintOp;
  value?: SqlValue;
  usable: boolean;
}

interface OrderingSpec {
  columnIndex: number;
  desc: boolean;
  nullsFirst?: boolean;
}

type ConstraintOp = '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB' | 'IS NULL' | 'IS NOT NULL' | 'IN' | 'NOT IN';
```

### Legacy Planning Interface

```typescript
// Legacy IndexInfo interface for compatibility
interface IndexInfo {
  nConstraint: number;
  aConstraint: ReadonlyArray<IndexConstraint>;
  nOrderBy: number;
  aOrderBy: ReadonlyArray<IndexOrderBy>;
  colUsed: bigint;
  
  // Output fields
  aConstraintUsage: IndexConstraintUsage[];
  idxNum: number;
  idxStr: string | null;
  orderByConsumed: boolean;
  estimatedCost: number;
  estimatedRows: bigint;
  idxFlags: number;
}

interface IndexConstraint {
  iColumn: number;
  op: IndexConstraintOp;
  usable: boolean;
  iTermOffset?: number;
}

interface FilterInfo {
  idxNum: number;
  idxStr: string | null;
  constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>;
  args: ReadonlyArray<SqlValue>;
  indexInfoOutput: IndexInfo;
}
```

### Constants and Enums

```typescript
enum IndexConstraintOp {
  EQ = 2, GT = 4, LE = 8, LT = 16, GE = 32,
  MATCH = 64, LIKE = 65, GLOB = 66, REGEXP = 67,
  NE = 68, ISNOT = 69, ISNOTNULL = 70, ISNULL = 71,
  IS = 72, LIMIT = 73, OFFSET = 74, IN = 75,
  FUNCTION = 150
}

enum IndexScanFlags {
  UNIQUE = 0x0001
}

enum VTabConfig {
  CONSTRAINT_SUPPORT = 1,
  INNOCUOUS = 2,
  DIRECTONLY = 3,
  USES_ALL_SCHEMAS = 4
}

enum FunctionFlags {
  UTF8 = 1,
  DETERMINISTIC = 0x000000800,
  DIRECTONLY = 0x000080000,
  INNOCUOUS = 0x000200000
}
```

### Plugin Registration Types

```typescript
interface PluginRegistrations {
  vtables?: VTablePluginInfo[];
  functions?: FunctionPluginInfo[];
  collations?: CollationPluginInfo[];
}

interface VTablePluginInfo {
  name: string;
  module: VirtualTableModule<any, any>;
  auxData?: unknown;
}

interface FunctionPluginInfo {
  schema: FunctionSchema;
}

interface CollationPluginInfo {
  name: string;
  func: CollationFunction;
  /** Optional key normalizer; required to use this collation as the key
   *  in a compound index. Without it, the collation works for ORDER BY
   *  and standalone comparisons but index creation referencing it fails. */
  normalizer?: (s: string) => string;
}
```

### Collation Function Type

```typescript
type CollationFunction = (a: string, b: string) => number;
```

The function should return:
- `-1` if `a < b`
- `0` if `a === b`
- `1` if `a > b`

### Key Normalizers, Grouping, and Index Participation

A collation defines an equivalence relation on strings (the set of pairs where
the comparator returns `0`). Anywhere the engine buckets rows by a key instead
of comparing them pairwise, it needs a *normalizer* — a function whose output
equality partitions strings into the same equivalence classes as the comparator.
For example, `NOCASE`'s normalizer is `s => s.toLowerCase()`, and `RTRIM`'s
strips only trailing ASCII spaces (matching its comparator — note that
`s.trimEnd()` would *disagree* by also stripping tabs/NBSP).

Supply a normalizer if the collation will be used, **over a text-typed key**, for
any of:

- a compound index key;
- a `GROUP BY` key or a window `PARTITION BY` key;
- a hash/bloom join key, or an `AS OF` partition key;
- a `PRIMARY KEY` column of an isolation-wrapped table (`using isolated`), when a
  transaction with pending writes on it is scanned through a secondary index;
- a `PRIMARY KEY` column of a persistent-store table (`using store`, and the
  LevelDB / IndexedDB plugins built on it), or that table's key collation `K`.

A comparator-only registration still works for `ORDER BY` and standalone
comparisons. Index creation naming it is rejected, and a query that groups or
hash-joins a text key under it raises `collation <name> has no key normalizer` —
the engine never guesses a built-in normalizer, because a normalizer that
disagrees with the comparator produces confidently wrong groups rather than a
visible error. A key whose type can never hold text (say `n integer collate
mycoll`) needs no normalizer: the collation cannot affect how such values bucket,
so the engine ignores it there rather than raising.

Normalizer-and-comparator agreement is a hard contract. If they diverge, index
lookups silently miss rows and groups split or merge wrongly.

**Register store collations before opening the database.** A store table's physical
key bytes come from its collation's normalizer, so the collation must be resolvable on
every connection that reads the table — not only the one that created it. Reopening a
persisted database from a connection that has not re-registered its custom collation now
raises while rehydrating the catalog (`create table` from the stored DDL), naming the
collation, rather than silently reading rows under a key layout it cannot reproduce.
Call `db.registerCollation(...)` before the first statement that touches the store.

A store collation should also declare whether its normalizer preserves **order**, not merely
equality — `db.registerCollation(name, cmp, { normalizer, orderPreserving: true })`. Without
that assertion the store still answers every query correctly, but falls back to a full scan
where it could have seeked a byte range, and keeps a Sort it could have elided. See
[store.md § Order preservation](./store.md#order-preservation).

### Built-in Collations

```typescript
// Available collation functions
const BINARY_COLLATION: CollationFunction;    // Byte-by-byte comparison
const NOCASE_COLLATION: CollationFunction;    // Case-insensitive comparison
const RTRIM_COLLATION: CollationFunction;     // Right-trim before comparison

// Collation management is per-database — there is no process-global registry.
// Register on the connection that will run the query:
db.registerCollation(
  name: string,
  func: CollationFunction,
  optionsOrNormalizer?:
    | ((s: string) => string)
    | { normalizer?: (s: string) => string; replicable?: boolean; orderPreserving?: boolean },
): void;

// Resolve a name to its function. Throws `no such collation sequence: <name>` if unregistered.
db.getCollationResolver(): CollationResolver;   // (name: string) => CollationFunction

// Resolve a name to its key normalizer, for anything that buckets rows by key rather than
// comparing them. `undefined` / `BINARY` → identity. Throws on an unregistered name, and on
// a registered collation that carries no normalizer — it never guesses a built-in.
db.getKeyNormalizerResolver(): KeyNormalizerResolver;   // (name: string | undefined) => (s: string) => string

// Built-ins-only lookup, for standalone utility code that has no `Database`.
// Returns `undefined` for any name outside BINARY / NOCASE / RTRIM.
function builtinCollationResolver(name: string): CollationFunction | undefined;
```
