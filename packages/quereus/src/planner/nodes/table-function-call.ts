import { PlanNodeType } from './plan-node-type.js';
import {
	PlanNode,
	type RelationalPlanNode,
	type ScalarPlanNode,
	type Attribute,
	type PhysicalProperties,
	type FunctionalDependency,
	type MonotonicOnInfo,
	type ConstantBinding,
} from './plan-node.js';
import type { RelationType, ColRef } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type {
	FunctionSchema,
	MonotonicOnColumnInfo,
} from '../../schema/function.js';
import { isTableValuedFunctionSchema, resolveAdvertisement } from '../../schema/function.js';
import { FunctionFlags } from '../../common/constants.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';
import { createLogger } from '../../common/logger.js';
import { addFd, superkeyToFd } from '../util/fd-utils.js';

const log = createLogger('planner:tvf');

/**
 * Represents a table-valued function call in the FROM clause.
 * This produces a relation from a function call like query_plan('SELECT ...').
 */
export class TableFunctionCallNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.TableFunctionCall;

  private attributesCache: Cached<Attribute[]>;
  private typeCache: Cached<RelationType>;

  constructor(
    scope: Scope,
    public readonly functionName: string,
    public readonly functionSchema: FunctionSchema,
    public readonly operands: readonly ScalarPlanNode[],
    public readonly alias?: string,
    public readonly aliasColumns?: readonly string[],
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? 1); // Default cost for function calls

    this.attributesCache = new Cached(() => {
      // Create attributes from function schema return type
      if (isTableValuedFunctionSchema(this.functionSchema)) {
        const renamed = this.functionSchema.returnType.columns.map((col, i) => ({
          id: PlanNode.nextAttrId(),
          name: (this.aliasColumns && this.aliasColumns[i]) ? this.aliasColumns[i] : col.name,
          type: col.type,
          sourceRelation: `${this.functionName}()`
        }));
        return renamed;
      }
      return [];
    });

    this.typeCache = new Cached(() => this.buildType());
  }

  private buildType(): RelationType {
    if (!isTableValuedFunctionSchema(this.functionSchema)) {
      return {
        typeClass: 'relation',
        isReadOnly: true,
        isSet: false,
        columns: [],
        keys: [],
        rowConstraints: [],
      };
    }

    const schema = this.functionSchema;
    const base = schema.returnType;
    const adv = schema.relationalAdvertisement;
    if (!adv) return base;

    const colCount = base.columns.length;
    const resolvedIsSet = resolveAdvertisement(adv.isSet, this.operands, schema);
    const resolvedKeys = resolveAdvertisement(adv.keys, this.operands, schema);

    const keysOverride = (resolvedKeys && validateKeys(resolvedKeys, colCount, this.functionName))
      ? resolvedKeys.map((k) => k.map((c) => ({ index: c.index, desc: c.desc })))
      : undefined;

    if (resolvedIsSet === undefined && keysOverride === undefined) {
      return base;
    }

    return {
      typeClass: 'relation',
      isReadOnly: base.isReadOnly,
      isSet: resolvedIsSet ?? base.isSet,
      columns: base.columns,
      keys: keysOverride ?? base.keys,
      rowConstraints: base.rowConstraints,
    };
  }

  getType(): RelationType {
    return this.typeCache.value;
  }

  getAttributes(): Attribute[] {
    return this.attributesCache.value;
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.operands;
  }

  getRelations(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== this.operands.length) {
      throw new Error(`TableFunctionCallNode expects ${this.operands.length} children, got ${newChildren.length}`);
    }

    // Type check
    for (const child of newChildren) {
      if (!('expression' in child)) {
        throw new Error('TableFunctionCallNode: all children must be ScalarPlanNodes');
      }
    }

    // Check if anything changed
    const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
    if (!childrenChanged) {
      return this;
    }

    // Create new instance
    return new TableFunctionCallNode(
      this.scope,
      this.functionName,
      this.functionSchema,
      newChildren as ScalarPlanNode[],
      this.alias,
      this.aliasColumns
    );
  }

  override computePhysical(): Partial<PhysicalProperties> {
    if (!isTableValuedFunctionSchema(this.functionSchema)) return {};

    const schema = this.functionSchema;
    const deterministicByFlag = (schema.flags & FunctionFlags.DETERMINISTIC) !== 0;
    const out: Partial<PhysicalProperties> = {
      deterministic: deterministicByFlag,
      readonly: true,
      idempotent: true,
    };

    const adv = schema.relationalAdvertisement;
    if (!adv) return out;

    const ops = this.operands;
    const colCount = schema.returnType.columns.length;
    const attrs = this.getAttributes();
    const attrIds = new Set(attrs.map((a) => a.id));

    // Lift declared unique keys into the FD set as `key → all_other_cols`.
    const resolvedKeys = resolveAdvertisement(adv.keys, ops, schema);
    let resolvedKeyIndices: number[][] | undefined;
    if (resolvedKeys && validateKeys(resolvedKeys, colCount, this.functionName)) {
      resolvedKeyIndices = resolvedKeys.map((k) => k.map((c) => c.index));
    }

    let fdsAcc: ReadonlyArray<FunctionalDependency> = [];
    const fds = resolveAdvertisement(adv.fds, ops, schema);
    if (fds && validateFds(fds, colCount, this.functionName)) {
      fdsAcc = fds;
    }
    if (resolvedKeyIndices) {
      for (const key of resolvedKeyIndices) {
        const keyFd = superkeyToFd(key, colCount);
        if (keyFd) fdsAcc = addFd(fdsAcc, keyFd, { keyHints: resolvedKeyIndices });
      }
    }
    if (fdsAcc.length > 0) out.fds = fdsAcc;

    const equivClasses = resolveAdvertisement(adv.equivClasses, ops, schema);
    if (equivClasses && validateEcs(equivClasses, colCount, this.functionName)) {
      out.equivClasses = equivClasses;
    }

    const ordering = resolveAdvertisement(adv.ordering, ops, schema);
    if (ordering && validateOrdering(ordering, colCount, this.functionName)) {
      out.ordering = ordering.map((o) => ({ column: o.column, desc: o.desc }));
    }

    const monotonicOn = resolveAdvertisement(adv.monotonicOn, ops, schema);
    if (monotonicOn && validateMonotonicOn(monotonicOn, attrIds, this.functionName)) {
      out.monotonicOn = monotonicOn;
    }

    const monotonicOnColumns = resolveAdvertisement(adv.monotonicOnColumns, ops, schema);
    if (monotonicOnColumns && validateMonotonicOnColumns(monotonicOnColumns, colCount, this.functionName)) {
      const translated = monotonicOnColumns.map((m) => ({
        attrId: attrs[m.column].id,
        strict: m.strict ?? false,
        direction: m.direction,
      } as MonotonicOnInfo));
      out.monotonicOn = mergeMonotonicOn(out.monotonicOn, translated);
    }

    const constantBindings = resolveAdvertisement(adv.constantBindings, ops, schema);
    if (constantBindings && validateBindings(constantBindings, colCount, this.functionName)) {
      out.constantBindings = constantBindings;
    }

    const estimatedRows = resolveAdvertisement(adv.estimatedRows, ops, schema);
    if (typeof estimatedRows === 'number' && Number.isFinite(estimatedRows) && estimatedRows >= 0) {
      out.estimatedRows = estimatedRows;
    }

    if (adv.accessCapabilities) out.accessCapabilities = adv.accessCapabilities;
    if (adv.deterministic !== undefined) out.deterministic = adv.deterministic;
    if (adv.readonly !== undefined) out.readonly = adv.readonly;
    if (adv.idempotent !== undefined) out.idempotent = adv.idempotent;

    return out;
  }

  get estimatedRows(): number | undefined {
    const fromPhysical = this.physical.estimatedRows;
    if (typeof fromPhysical === 'number') return fromPhysical;
    return 10; // Conservative fallback
  }

  override toString(): string {
    const argsStr = formatExpressionList(this.operands);
    const aliasColsStr = this.aliasColumns && this.aliasColumns.length > 0 ? `(${this.aliasColumns.join(', ')})` : '';
    const aliasStr = this.alias ? ` AS ${this.alias}${aliasColsStr}` : '';
    return `${this.functionName}(${argsStr})${aliasStr}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      function: this.functionName,
      arguments: this.operands.map(op => op.toString())
    };

    if (this.alias) {
      props.alias = this.alias;
    }
    if (this.aliasColumns && this.aliasColumns.length > 0) {
      props.aliasColumns = [...this.aliasColumns];
    }

    if (isTableValuedFunctionSchema(this.functionSchema)) {
      props.columns = this.functionSchema.returnType.columns.map(col => col.name);
    }

    return props;
  }
}

function validateKeys(
  keys: ReadonlyArray<ReadonlyArray<ColRef>>,
  colCount: number,
  fnName: string,
): boolean {
  for (const k of keys) {
    for (const c of k) {
      if (!Number.isInteger(c.index) || c.index < 0 || c.index >= colCount) {
        log('Dropping TVF advertisement for %s: key column index %d out of range [0,%d)', fnName, c.index, colCount);
        return false;
      }
    }
  }
  return true;
}

function validateFds(
  fds: ReadonlyArray<FunctionalDependency>,
  colCount: number,
  fnName: string,
): boolean {
  for (const fd of fds) {
    if (!Array.isArray(fd.dependents) || fd.dependents.length === 0) {
      log('Dropping TVF advertisement for %s: FD has empty dependents', fnName);
      return false;
    }
    for (const i of fd.determinants) {
      if (!Number.isInteger(i) || i < 0 || i >= colCount) {
        log('Dropping TVF advertisement for %s: FD determinant index %d out of range', fnName, i);
        return false;
      }
    }
    for (const i of fd.dependents) {
      if (!Number.isInteger(i) || i < 0 || i >= colCount) {
        log('Dropping TVF advertisement for %s: FD dependent index %d out of range', fnName, i);
        return false;
      }
    }
    // Plain-JS plugins bypass the type system — `kind` is required and every
    // reader trusts it, so reject anything but the two valid values here.
    if (fd.kind !== 'unique' && fd.kind !== 'determination') {
      log('Dropping TVF advertisement for %s: FD kind must be \'unique\' or \'determination\', got %s', fnName, fd.kind);
      return false;
    }
  }
  return true;
}

function validateEcs(
  ecs: ReadonlyArray<ReadonlyArray<number>>,
  colCount: number,
  fnName: string,
): boolean {
  for (const cls of ecs) {
    if (cls.length < 2) {
      log('Dropping TVF advertisement for %s: equivClass with <2 members', fnName);
      return false;
    }
    for (const i of cls) {
      if (!Number.isInteger(i) || i < 0 || i >= colCount) {
        log('Dropping TVF advertisement for %s: equivClass index %d out of range', fnName, i);
        return false;
      }
    }
  }
  return true;
}

function validateOrdering(
  ordering: ReadonlyArray<{ column: number; desc: boolean }>,
  colCount: number,
  fnName: string,
): boolean {
  const seen = new Set<number>();
  for (const o of ordering) {
    if (!Number.isInteger(o.column) || o.column < 0 || o.column >= colCount) {
      log('Dropping TVF advertisement for %s: ordering column %d out of range', fnName, o.column);
      return false;
    }
    if (seen.has(o.column)) {
      log('Dropping TVF advertisement for %s: duplicate ordering column %d', fnName, o.column);
      return false;
    }
    seen.add(o.column);
  }
  return true;
}

function validateMonotonicOn(
  entries: ReadonlyArray<MonotonicOnInfo>,
  attrIds: ReadonlySet<number>,
  fnName: string,
): boolean {
  for (const m of entries) {
    if (!attrIds.has(m.attrId)) {
      log('Dropping TVF advertisement for %s: monotonicOn attrId %d not in node attributes', fnName, m.attrId);
      return false;
    }
  }
  return true;
}

function validateMonotonicOnColumns(
  entries: ReadonlyArray<MonotonicOnColumnInfo>,
  colCount: number,
  fnName: string,
): boolean {
  for (const m of entries) {
    if (!Number.isInteger(m.column) || m.column < 0 || m.column >= colCount) {
      log('Dropping TVF advertisement for %s: monotonicOnColumns column %d out of range', fnName, m.column);
      return false;
    }
  }
  return true;
}

function validateBindings(
  bindings: ReadonlyArray<ConstantBinding>,
  colCount: number,
  fnName: string,
): boolean {
  for (const b of bindings) {
    for (const i of b.attrs) {
      if (!Number.isInteger(i) || i < 0 || i >= colCount) {
        log('Dropping TVF advertisement for %s: constantBinding column %d out of range', fnName, i);
        return false;
      }
    }
  }
  return true;
}

function mergeMonotonicOn(
  existing: readonly MonotonicOnInfo[] | undefined,
  added: readonly MonotonicOnInfo[],
): readonly MonotonicOnInfo[] {
  if (!existing || existing.length === 0) return added;
  const out: MonotonicOnInfo[] = [...existing];
  const seen = new Set(existing.map((m) => m.attrId));
  for (const m of added) {
    if (!seen.has(m.attrId)) {
      out.push(m);
      seen.add(m.attrId);
    }
  }
  return out;
}
