export enum PlanNodeType {
  // Logical Nodes (from builder)
  Block = 'Block',
  TableReference = 'TableReference',
  Retrieve = 'Retrieve',
  CTEReference = 'CTEReference',
  TableSeek = 'TableSeek',
  Filter = 'Filter',
  Project = 'Project',
  Distinct = 'Distinct',
  Aggregate = 'Aggregate',
  Window = 'Window',
  Sort = 'Sort',
  LimitOffset = 'LimitOffset',
  Join = 'Join',
  SetOperation = 'SetOperation',
  CTE = 'CTE',
  RecursiveCTE = 'RecursiveCTE',
  InternalRecursiveCTERef = 'InternalRecursiveCTERef',
  In = 'In',
  Exists = 'Exists',
  Sequencing = 'Sequencing',

  // DML/DDL Nodes
  Insert = 'Insert',
  Update = 'Update',
  UpdateExecutor = 'UpdateExecutor',
  Delete = 'Delete',
  ViewMutation = 'ViewMutation',  // Wraps the ordered base-table DML subtrees a view/MV mutation decomposes into
  ConstraintCheck = 'ConstraintCheck',
  CreateTable = 'CreateTable',
  DropTable = 'DropTable',
  CreateIndex = 'CreateIndex',
  DropIndex = 'DropIndex',
  CreateView = 'CreateView',
  DropView = 'DropView',
  CreateMaterializedView = 'CreateMaterializedView',
  RefreshMaterializedView = 'RefreshMaterializedView',
  DropMaterializedView = 'DropMaterializedView',
  CreateAssertion = 'CreateAssertion',
  DropAssertion = 'DropAssertion',
  AlterTable = 'AlterTable',
  SetObjectTags = 'SetObjectTags',  // ALTER VIEW / MATERIALIZED VIEW / INDEX ... SET TAGS
  AddConstraint = 'AddConstraint',

  // Physical Nodes (from optimizer)
  SeqScan = 'SeqScan',              // Physical sequential scan
  IndexScan = 'IndexScan',          // Physical index scan
  IndexSeek = 'IndexSeek',          // Physical index seek
  EmptyResult = 'EmptyResult',      // Physical empty result (impossible predicate)
  EmptyRelation = 'EmptyRelation',  // Schema-polymorphic zero-row relation (const-fold result)
  RemoteQuery = 'RemoteQuery',      // Physical remote query execution
  StreamAggregate = 'StreamAggregate',  // Physical ordered aggregate
  HashAggregate = 'HashAggregate',      // Physical hash aggregate
  NestedLoopJoin = 'NestedLoopJoin',
  HashJoin = 'HashJoin',
  MergeJoin = 'MergeJoin',
  KeySetSemiJoin = 'KeySetSemiJoin',  // Semi join that materializes the key set, then multi-seeks the target with it

  AsofScan = 'AsofScan',            // Streaming asof join: per left row, latest right with key ≤ left's
  OrdinalSlice = 'OrdinalSlice',    // O(log N) seek to kth row over a monotonic, ordinal-seek-capable leaf
  Materialize = 'Materialize',      // Materialize intermediate results

  // Scalar expression nodes
  Literal = 'Literal',
  ColumnReference = 'ColumnReference',
  ParameterReference = 'ParameterReference',
  ArrayIndex = 'ArrayIndex',
  UnaryOp = 'UnaryOp',
  BinaryOp = 'BinaryOp',
  CaseExpr = 'CaseExpr',
  Cast = 'Cast',
  Collate = 'Collate',
  ScalarFunctionCall = 'ScalarFunctionCall',
  WindowFunctionCall = 'WindowFunctionCall',
  Between = 'Between',
  IsNull = 'IsNull',
  IsNotNull = 'IsNotNull',
  Like = 'Like',
  ScalarSubquery = 'ScalarSubquery',
  TableFunctionReference = 'TableFunctionReference',
  FunctionReference = 'FunctionReference',

  // Special relational nodes
  Alias = 'Alias',  // Wraps a relation with an alias for relationName
  AssertedKeys = 'AssertedKeys',  // Pass-through carrying lens-asserted declared-key FDs onto the inlined-view boundary
  LensAuxiliaryAccess = 'LensAuxiliaryAccess',  // Pass-through carrying routable auxiliary-access advertisements onto the inlined-lens-view boundary (read-path selection)
  Values = 'Values',
	TableLiteral = "TableLiteral",
  EnvelopeScan = 'EnvelopeScan',  // Scans the shared-surrogate mutation envelope (multi-source view insert)
  SingleRow = 'SingleRow',  // For SELECT without FROM
  TableFunctionCall = 'TableFunctionCall',

  // Transaction control
  Transaction = 'Transaction',
  Savepoint = 'Savepoint',

  // Utility
  Pragma = 'Pragma',
  Analyze = 'Analyze',
  DeclareSchema = 'DeclareSchema',
  DeclareLens = 'DeclareLens',
  DiffSchema = 'DiffSchema',
  ApplySchema = 'ApplySchema',
  ExplainSchema = 'ExplainSchema',

  // Query execution
  Cache = 'Cache',
  EagerPrefetch = 'EagerPrefetch',
  AsyncGather = 'AsyncGather',
  FanOutLookupJoin = 'FanOutLookupJoin',
  Sink = 'Sink',

  // RETURNING support
  Returning = 'Returning',
}
