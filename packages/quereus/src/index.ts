/**
 * Quereus - A TypeScript SQL Engine
 *
 * This module provides a TypeScript implementation of a SQL database engine
 * with support for virtual tables and the full SQL query language.
 */

// Core database functionality
export { Database } from './core/database.js';
export type { RegisterCollationOptions } from './core/database.js';
export type { DatabaseInternal, ExternalRowChange, IngestExternalChangesOptions, IngestExternalChangesResult } from './core/database-internal.js';
export type { AssertionViolation } from './core/database-assertions.js';
export type { BackingRowChange, MaintenanceOp, BackingHost, BackingScanRequest } from './vtab/backing-host.js';
export { Statement } from './core/statement.js';
export { Table } from './core/table-handle.js';

// Common data types and constants
export { StatusCode, SqlDataType } from './common/types.js';
export type { SqlValue, JsonSqlValue, SqlParameters, StatementOptions, Row, MaybePromise, RowOp, ConstraintType, UpdateResult, CompareFn } from './common/types.js';
export { isUpdateOk, isConstraintViolation, isSqlValue } from './common/types.js';
export { ConflictResolution, IndexConstraintOp, VTabConfig, FunctionFlags } from './common/constants.js';
export { QuereusError, MisuseError, ConstraintError, AbortError, RelationNotFoundError, throwIfAborted, isAbortError, unwrapError, formatErrorChain, getPrimaryError } from './common/errors.js';
export type { ErrorInfo } from './common/errors.js';

// Virtual Table API
export { VirtualTable } from './vtab/table.js';
export type { UpdateArgs } from './vtab/table.js';
export type { VirtualTableConnection } from './vtab/connection.js';
export { MemoryTableModule } from './vtab/memory/module.js';
export type { IndexInfo, IndexConstraint, IndexConstraintUsage, IndexOrderBy } from './vtab/index-info.js';
export { IndexScanFlags } from './vtab/index-info.js';
export type { FilterInfo } from './vtab/filter-info.js';
export {
	makeFullScanFilterInfo,
	makeEmptyFilterInfo,
	makeIndexEqSeekFilterInfo,
	retargetFilterInfoIndex,
} from './vtab/filter-info.js';

// Structured access-path identity — the typed form of what `idxStr` encodes as text
export type { IndexKeyColumn, IndexDescriptor, IndexPlanKind, AccessPath } from './vtab/index-descriptor.js';
export {
	PRIMARY_INDEX_NAME,
	PRIMARY_PHYSICAL_INDEX_NAME,
	isPrimaryIndexName,
	primaryKeyDescriptor,
	resolveIndexDescriptor,
	validateIndexDescriptor,
} from './vtab/index-descriptor.js';

// The `idxStr` wire format: one encoder, one decoder
export type { IdxStrSpec } from './vtab/idx-str.js';
export {
	encodeIdxStr,
	decodeIdxStr,
	idxStrSentinel,
	retargetIdxStr,
	makeIdxStrSpec,
	planKindFromCode,
	planCodeFromKind,
} from './vtab/idx-str.js';
export type { BaseModuleConfig, CatalogObjectKind, EffectiveRowSource, SchemaChangeInfo, VtabConcurrencyMode } from './vtab/module.js';
export { getModuleConcurrencyMode, getModuleReadCommittedSnapshot, acquireConnectionLock } from './vtab/concurrency.js';

// Module-author test support. Ships in the package deliberately — an out-of-tree
// module needs the conformance check at runtime. Nothing in the engine imports it.
export type {
	CommittedReadConformanceOptions,
	CommittedReadConformanceResult,
} from './vtab/test-support/committed-read-conformance.js';
export { runCommittedReadConformance } from './vtab/test-support/committed-read-conformance.js';
export type { CommitStall, CommitStallHandle } from './vtab/test-support/commit-stall.js';
export { installCommitStall, settleMacrotasks } from './vtab/test-support/commit-stall.js';

// Virtual Table Event Hooks
export type {
	VTableDataChangeEvent,
	VTableDataChangeListener,
	VTableSchemaChangeEvent,
	VTableSchemaChangeListener,
	VTableEventEmitter
} from './vtab/events.js';
export { DefaultVTableEventEmitter } from './vtab/events.js';

// Database-Level Event System (unified reactivity)
export type {
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
	MaintenanceCollisionEvent,
	TransactionCommitBatch,
	TransactionCommitListener,
	DataChangeSubscriptionOptions,
	SchemaChangeSubscriptionOptions,
} from './core/database-events.js';
export { DatabaseEventEmitter } from './core/database-events.js';

// Best Access Plan API (modern vtable planning interface)
export type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ConstraintOp,
	ColumnMeta,
	PredicateConstraint,
	RuntimeSetSpec,
	OrderingSpec
} from './vtab/best-access-plan.js';
export {
	AccessPlanBuilder,
	validateAccessPlan,
	validateAccessPlanRequest,
	equalitySeekKeyCount,
	isMultiValueEquality,
} from './vtab/best-access-plan.js';

// Collation and comparison functions
export type { CollationFunction } from './util/comparison.js';
export {
	// Built-in collation functions. Custom collations are registered per-database
	// with `db.registerCollation(...)` and resolved via `db.getCollationResolver()`.
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	// The primitive the built-ins compare with: Unicode code-point order, which is the
	// memcmp order of the UTF-8 key bytes a persistent store writes. A custom collation
	// claiming `orderPreserving: true` must compare with this, not with JS `<`/`>`.
	compareCodePoints,
	builtinCollationResolver,
	normalizeCollationName,
	resolveCollationFunctions,
	// Core comparison functions (critical for module implementations)
	compareSqlValues,
	compareSqlValuesFast,
	rowsValueIdentical,
	sqlValueIdentical,
	compareRows,
	compareTypedValues,
	createTypedComparator,
	createTypedRowComparator,
	createCollationRowComparator,
	createSemanticRowComparator,
	hasSemanticOrdering,
	semanticKeyTransform,
	comparisonSemanticsDiffer,
	// ORDER BY comparison utilities
	compareWithOrderByFast,
	createOrderByComparatorFast,
	createTypedOrderByComparator,
	SortDirection,
	NullsOrdering,
	// Truthiness evaluation
	isTruthy,
	// Type introspection
	getSqlDataTypeName
} from './util/comparison.js';

// Type system
export type { LogicalType, CollationResolver, KeyNormalizer, KeyNormalizerResolver, CollationFunction as TypeCollationFunction } from './types/logical-type.js';
export { PhysicalType } from './types/logical-type.js';
export {
	NULL_TYPE,
	INTEGER_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	NUMERIC_TYPE,
	ANY_TYPE
} from './types/builtin-types.js';
export {
	DATE_TYPE,
	TIME_TYPE,
	DATETIME_TYPE,
	TIMESTAMP_TYPE,
	TIMESPAN_TYPE
} from './types/temporal-types.js';
export { JSON_TYPE } from './types/json-type.js';
export {
	typeRegistry,
	registerType,
	getType,
	getTypeOrDefault,
	inferType
} from './types/registry.js';
export {
	validateValue,
	parseValue,
	validateAndParse,
	coerceRowToSchema,
	foldDefaultToType,
	planRetypeConversion,
	isValidForType,
	tryParse
} from './types/validation.js';
export type { RetypeConversion } from './types/validation.js';

// SQL Parser and Compiler
export { Parser } from './parser/parser.js';
export { Lexer, TokenType, KEYWORDS } from './parser/lexer.js';
export { ParseError } from './parser/parser.js';
export { tryFoldLiteral } from './parser/utils.js';
export { quoteIdentifier, expressionToString } from './emit/ast-stringify.js';

// Schema management
export { SchemaManager } from './schema/manager.js';
export type { ImportCatalogOptions } from './schema/manager.js';
// The one by-name index-owner resolver (SchemaManager.findIndexOwner) and its
// scope/result types — `@quereus/sync` resolves a replicated index migration's
// owning table through it rather than re-scanning the schema itself.
export type { IndexLookupScope, IndexOwnerMatch } from './schema/manager.js';
export type { SchemaChangeEvent, SchemaChangeListener, TableModifiedEvent, ViewAddedEvent, ViewRemovedEvent } from './schema/change-events.js';
export { buildColumnIndexMap, columnDefToSchema, resolveNamedConstraintClass, namedConstraintExists, validateCollationForType, resolveDefaultCollation, appendIndexToTableSchema, shiftSchemaIndicesForDrop, rekeySchemaPrimaryKey } from './schema/table.js';
export { buildUniqueConstraintSchema, buildForeignKeyConstraintSchema, buildCheckConstraintSchema, validateForeignKeyOverExistingRows, validateForeignKeyCollations, maintainedTableUniqueViolationError, formatKeyValue } from './schema/constraint-builder.js';
export type { TableSchema, IndexSchema as TableIndexSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema, NamedConstraintClass } from './schema/table.js';
// Per-column UNIQUE-enforcement collation resolver, plus the per-column comparators
// built from it — the single source of truth shared by store/isolation re-validators
// (memory's `checkUniqueViaIndex` is conformance-locked against the collation resolver
// rather than importing it, but does share the comparators; see unique-enforcement.ts).
export { uniqueEnforcementCollations, resolveUniqueEnforcementCollations, uniqueEnforcementComparators } from './schema/unique-enforcement.js';
export type { ColumnSchema } from './schema/column.js';
export type { ViewSchema } from './schema/view.js';
export type { TableDerivation, MaintainedTableSchema } from './schema/derivation.js';
export { isMaintainedTable } from './schema/derivation.js';
export { generateTableDDL, generateIndexDDL, generateDropTableDDL, generateDropIndexDDL, generateViewDDL, generateMaintainedTableDDL, generateIndexTagsDDL } from './schema/ddl-generator.js';
export { isHiddenImplicitIndex, isImplicitCoveringIndex, exposedImplicitIndexes } from './schema/catalog.js';
export type { SyntheticExposedIndex } from './schema/catalog.js';
// Rename rewriters for the expression-bearing parts of a table's own definition.
// A persisting module must rewrite these from inside its own `alterTable` /
// `renameTable` hook — the engine's propagation pass runs only after the hook
// returns, so a module that persists first would durably write a definition naming
// the pre-rename column or table.
export {
	renameColumnInIndexPredicates, renameTableInIndexPredicates,
	renameColumnInCheckConstraints, renameTableInCheckConstraints,
	renameColumnInColumnExpressions, renameTableInColumnExpressions,
	objectRefKey, singleSchemaObjectRefResolver,
} from './schema/rename-rewriter.js';
export type { ResolveColumnInSource, ResolveObjectRef, TableRenameTarget } from './schema/rename-rewriter.js';
// Planner-parity object-reference resolution for the rename walkers above: a
// module rewriting stored bodies must resolve references the way the planner
// does (home schema path), from a snapshot taken BEFORE the statement's first
// catalog mutation — see the builder's doc comment. `tableRenameTargetsFor`
// pairs that snapshot with its post-rename sibling per body-owning schema, so
// a table-rename rewrite can hold its resolution-preserving post-condition.
export { buildObjectRefResolver, snapshotObjectRefResolvers, tableRenameTargetsFor } from './schema/object-ref-resolver.js';
export type { ObjectRefResolvers } from './schema/object-ref-resolver.js';
// Reserved-tag namespace surface — `@quereus/quereus-store` keys its sync-replication
// opt-in off SYNC_REPLICATE_TAG (DRY: one literal) and reads it via getReservedTag.
// `@quereus/sync` keys its per-table eviction override off SYNC_EVICT_TAG.
// `lamina-quereus` stamps its per-column basis member relations with
// ENGINE_MANAGED_TABLE_TAG so `collectSchemaCatalog` excludes them from the
// declarative diff (DRY: one literal, single-sourced here).
export { SYNC_REPLICATE_TAG, SYNC_EVICT_TAG, ENGINE_MANAGED_TABLE_TAG, getReservedTag } from './schema/reserved-tags.js';

// Partial-index predicate compilation (used by store modules to honor partial UNIQUE)
export { compilePredicate } from './vtab/memory/utils/predicate.js';
export type { CompiledPredicate } from './vtab/memory/utils/predicate.js';

// Runtime utilities
export { isAsyncIterable, getAsyncIterator, asyncIterableToArray } from './runtime/utils.js';
export { CollectingInstructionTracer } from './runtime/types.js';
export type { InstructionTracer, InstructionTraceEvent } from './runtime/types.js';

// Function registration utilities
export {
	createScalarFunction,
	createTableValuedFunction,
	createAggregateFunction,
	normalizeFunctionSchema
} from './func/registration.js';

// Return-type declarations for registered functions. `scalarReturn(TEXT_TYPE)` and
// the `*_RETURN` constants make declaring a function's return type a one-token edit
// instead of a repeated four-field object literal.
export {
	scalarReturn,
	TEXT_RETURN,
	TEXT_RETURN_NOT_NULL,
	INTEGER_RETURN,
	INTEGER_RETURN_NOT_NULL,
	REAL_RETURN,
	REAL_RETURN_NOT_NULL,
	BOOLEAN_RETURN,
	BOOLEAN_RETURN_NOT_NULL,
	BLOB_RETURN,
	JSON_RETURN,
	ANY_RETURN
} from './func/builtins/return-types.js';

// The shapes a `returnType` is made of. `scalarReturn` returns a `ScalarType`, and a
// table-valued function's relation is spelled out column by column, so a plugin
// outside this repo needs to be able to name these.
export type { ScalarType, RelationType, ColumnDef, ColRef } from './common/datatype.js';

export type {
	ScalarFunc,
	TableValuedFunc,
	AggregateReducer,
	AggregateFinalizer,
	FunctionSchema
} from './schema/function.js';

// Coercion utilities (for module implementations)
export {
	tryCoerceToNumber,
	coerceToNumberForArithmetic,
	coerceForComparison,
	coerceForAggregate,
	isNumericValue
} from './util/coercion.js';

// Utility functions
export { Latches } from './util/latches.js';

// Collation-aware key serialization (used by store modules for existing-row
// UNIQUE re-validation that honors a per-column collation). `BUILTIN_NORMALIZERS`
// backs a store's default key-normalizer resolver for callers that hold no Database;
// any caller that DOES hold one must resolve through `db.getKeyNormalizerResolver()`.
export { BUILTIN_NORMALIZERS, serializeKey, serializeRowKey, serializeKeyNullGrouping } from './util/key-serializer.js';

// The ONE pk row-identity recipe ("are these two primary keys the same row?"): per pk
// column, its semantic key transform then its key-collation normalizer, serialized via
// `serializeKeyNullGrouping`. Shared by `@quereus/isolation`'s overlay row-alignment key and
// `@quereus/sync`'s per-row CRDT metadata key, so the two layers can never disagree.
export { makePkIdentitySerializer, resolvePkIdentityKeying } from './util/key-serializer.js';
export type { PkIdentityColumn, PkIdentityTable, PkIdentityKeying } from './util/key-serializer.js';

// Whether a column's declared type can ever hold text, and therefore whether a key
// built over it needs a key normalizer at all. Out-of-package hash-key sites (the
// isolation overlay's modified-PK set) must gate on this exactly as the engine's own
// emitters do via `hashKeyCollationName`, or a comparator-only collation named on a
// non-text primary-key column raises where the engine would not.
export { logicalTypeCanHoldText, pkKeyCollationName } from './planner/analysis/comparison-collation.js';

// Canonical JSON key form (recursive object-key sort) — used by store modules to
// derive persisted byte keys that agree with the in-memory JSON comparator, so
// reorder-equal JSON values ({a:1,b:2} vs {b:2,a:1}) encode to identical bytes.
export { canonicalJsonString } from './util/json-canonical.js';

// Plugin helper for static loading (React Native, etc.)
export { registerPlugin } from './util/plugin-helper.js';
export type { PluginFunction } from './util/plugin-helper.js';

// Initialize runtime emitters (this ensures they are registered)
import './runtime/register.js';

// Catalog statistics — the shape `VirtualTable.getStatistics` returns and `ANALYZE`
// caches on the table's schema entry. Exported so out-of-package modules (the store
// backends) can implement that method with the engine's own types.
export type { TableStatistics, ColumnStatistics, EquiHeightHistogram, HistogramBucket } from './planner/stats/catalog-stats.js';

// Re-export virtual table framework
export type { VirtualTableModule } from './vtab/module.js';
export type { ModuleCapabilities, IsolationCapableTable } from './vtab/capabilities.js';

// Schema type (needed by external modules implementing getMappingAdvertisements)
export type { Schema } from './schema/schema.js';

// Module mapping-advertisement protocol (lens default mapper — docs/lens.md)
export type {
	MappingAdvertisement,
	StorageShape,
	BasisRelationRef,
	DecompositionMember,
	LogicalColumnMapping,
	SharedKey,
	AccessForm,
	AccessShape,
	AttributePivot,
} from './vtab/mapping-advertisement.js';
export { buildAdvertisementsFromTags } from './schema/mapping-advertisement-tags.js';

// Lens-deployment surface (logical-schema → basis; docs/lens.md § Deployment).
// `deployLogicalSchema` is the `apply schema X` compile step for a logical
// schema; it produces a `LensDeploymentSnapshot` (the deployed basis
// representation) that the module deployment-notification hook
// (`VirtualTableModule.notifyLensDeployment`) hands to every registered module,
// so a host adapter backing the basis can reconcile its storage against the
// freshly deployed lens. The AST types these reference (`SelectStmt`,
// `DeclareSchemaStmt`) are available from `@quereus/quereus/parser`.
export { deployLogicalSchema } from './schema/lens-compiler.js';
export type {
	LensDeploymentSnapshot,
	LensTableSnapshot,
	LensRelationBacking,
} from './schema/lens.js';
export type { LensDeployReport } from './schema/lens-prover.js';

// Re-export plugin manifest types (for plugin authors, but not the loader)
export type {
	PluginManifest,
	PluginRecord,
	PluginSetting,
	VTablePluginInfo,
	FunctionPluginInfo,
	CollationPluginInfo,
	TypePluginInfo,
	PluginRegistrations
} from './vtab/manifest.js';

// Change-scope introspection
export type {
	ChangeScope,
	TableWatch,
	WatchScope,
	ScopeValue,
	ParamScopeValue,
	PortableScalarType,
	NonDetSource,
	QualifiedName,
	SerializedChangeScope,
	Subscription,
	WatchEvent,
	MatchedWatch,
	WatchHandler,
} from './planner/analysis/change-scope.js';
export {
	analyzeChangeScope,
	unionScopes,
	intersectScopes,
	bindParameters,
	isEmpty,
	describesEverything,
	serializeChangeScope,
	deserializeChangeScope,
	scalarTypeFromPortable,
} from './planner/analysis/change-scope.js';

// Debug and development utilities
export { serializePlanTree, formatPlanTree, formatPlanSummary, serializePlanTreeWithOptions } from './planner/debug.js';
export type { PlanDisplayOptions } from './planner/debug.js';

// Logging control (for environments like React Native where env vars aren't available)
export { enableLogging, disableLogging, isLoggingEnabled } from './common/logger.js';
