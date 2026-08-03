// Core type system exports
export { PhysicalType, type LogicalType, getPhysicalType, physicalTypeName, compareNulls } from './logical-type.js';

// Built-in types
export { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE, NUMERIC_TYPE, ANY_TYPE, isNumericOrUnknownType, sharesSeekKeySpace } from './builtin-types.js';

// Temporal types
export { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from './temporal-types.js';

// JSON type
export { JSON_TYPE } from './json-type.js';

// Type registry
export { typeRegistry, registerType, getType, getTypeOrDefault, inferType } from './registry.js';

// Validation utilities
export { validateValue, parseValue, validateAndParse, coerceRowToSchema, foldDefaultToType, isValidForType, tryParse } from './validation.js';
