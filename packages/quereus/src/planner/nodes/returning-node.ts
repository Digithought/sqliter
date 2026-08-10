import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { ColumnReferenceNode } from './reference.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { Cached } from '../../util/cached.js';
import { deriveProjectionColumnMap, projectKeys } from '../util/key-utils.js';
import { disambiguateColumnNames } from '../util/output-names.js';
import { projectOrdering } from '../framework/physical-utils.js';
import { addFd, projectConstantBindings, projectDomainConstraints, projectFds, projectInds, superkeyToFd } from '../util/fd-utils.js';

export interface ReturningProjection {
  node: ScalarPlanNode;
  alias?: string;
  /** Optional predefined attribute ID to preserve during optimization */
  attributeId?: number;
}

/**
 * Represents a RETURNING clause that projects rows from a DML operation.
 * The executor performs the DML operation and yields the affected rows.
 */
export class ReturningNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Returning;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<readonly Attribute[]>;

  constructor(
    scope: Scope,
    public readonly executor: RelationalPlanNode, // The DML operation that yields affected rows
    public readonly projections: ReadonlyArray<ReturningProjection>,
    /** Optional predefined attributes for preserving IDs during optimization */
    predefinedAttributes?: readonly Attribute[]
  ) {
    super(scope);

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => {
      // If predefined attributes are provided, use them (for optimization)
      if (predefinedAttributes) {
        return predefinedAttributes.slice(); // Return a copy
      }

      return this.buildAttributes();
    });
  }

  private buildOutputType(): RelationType {
    // Return type is based on the projections, similar to ProjectNode
    const columnNames = disambiguateColumnNames(this.projections.map(proj => {
      // Determine base column name; preserve the spelling supplied by the user
      // (matches ProjectNode behaviour for SELECT — case-insensitive matching is
      // a resolution concern, not an output-name concern).
      if (proj.alias) return proj.alias;
      if (proj.node instanceof ColumnReferenceNode) {
        const expr = proj.node.expression;
        return expr.table ? `${expr.table}.${expr.name}` : expr.name;
      }
      return expressionToString(proj.node.expression);
    }));

    const columns = this.projections.map((proj, index) => ({
      name: columnNames[index],
      type: proj.node.getType(),
      nullable: true // Conservative assumption
    }));

    // Logical key propagation via the shared projection-mapping helper (covers
    // both bare column references and injective unary projections).
    const execType = this.executor.getType();
    const { map: srcToOut } = deriveProjectionColumnMap(
      this.executor.getAttributes(),
      this.projections.map((p, outIndex) => ({ expr: p.node, outIndex })),
    );

    return {
      typeClass: 'relation',
      columns,
      isSet: execType.isSet,
      isReadOnly: false,
      keys: projectKeys(execType.keys, srcToOut),
      rowConstraints: [],
    };
  }

  private buildAttributes(): readonly Attribute[] {
    // Create attributes for the projected columns
    // Get the computed column names from the type
    const outputType = this.getType();

    // For each projection, preserve attribute ID if it's a simple column reference
    return this.projections.map((proj, index) => {
      // Check if projection has a predefined attribute ID
      if (proj.attributeId !== undefined) {
        return {
          id: proj.attributeId,
          name: outputType.columns[index].name,
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      }

      // If this projection is a simple column reference, preserve its attribute ID
      if (proj.node instanceof ColumnReferenceNode) {
        return {
          id: proj.node.attributeId,
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      } else {
        // For computed expressions, generate new attribute ID
        return {
          id: PlanNode.nextAttrId(),
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      }
    });
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

  getRelations(): readonly RelationalPlanNode[] {
    // Return the executor which is now a RelationalPlanNode
    return [this.executor];
  }

  getChildren(): readonly PlanNode[] {
    // Return executor first, then all projection expressions
    return [this.executor, ...this.projections.map(proj => proj.node)];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedChildren = 1 + this.projections.length; // executor + projections
    if (newChildren.length !== expectedChildren) {
      throw new Error(`ReturningNode expects ${expectedChildren} children, got ${newChildren.length}`);
    }

    const [newExecutor, ...newProjectionNodes] = newChildren;

    // Type check the executor
    if (!isRelationalNode(newExecutor)) {
      throw new Error('ReturningNode: first child must be a RelationalPlanNode (executor)');
    }

    // Type check projection expressions
    for (let i = 0; i < newProjectionNodes.length; i++) {
      const expr = newProjectionNodes[i];
      if (!('expression' in expr)) {
        throw new Error(`ReturningNode: projection child ${i + 1} must be a ScalarPlanNode`);
      }
    }

    // Check if anything changed
    const executorChanged = newExecutor !== this.executor;
    const projectionsChanged = newProjectionNodes.some((child, i) => child !== this.projections[i].node);

    if (!executorChanged && !projectionsChanged) {
      return this;
    }

    // **CRITICAL**: Preserve original attribute IDs to maintain column reference stability
    const originalAttributes = this.getAttributes();

    // Create new projections with preserved attribute IDs
    const newProjections = this.projections.map((proj, i) => ({
      node: newProjectionNodes[i] as ScalarPlanNode,
      alias: proj.alias,
      attributeId: originalAttributes[i].id // Preserve original attribute ID
    }));

    // Create new instance with preserved attributes
    return new ReturningNode(
      this.scope,
      newExecutor as RelationalPlanNode,
      newProjections,
      originalAttributes // Pass original attributes to preserve IDs
    );
  }

  get estimatedRows(): number | undefined {
    return this.executor.estimatedRows;
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    const sourcePhysical = childrenPhysical[0];
    const outputColCount = this.projections.length;
    const { map, injectivePairs } = deriveProjectionColumnMap(
      this.executor.getAttributes(),
      this.projections.map((p, outIndex) => ({ expr: p.node, outIndex })),
    );

    // Project the executor's logical unique keys through the column map; each
    // surviving key K' becomes the FD `K' → (all_other_out_cols)` on the output.
    const executorLogicalKeys = this.executor.getType().keys.map(k => k.map(ref => ref.index));
    const projectedKeys: number[][] = [];
    for (const key of executorLogicalKeys) {
      const projected: number[] = [];
      let miss = false;
      for (const col of key) {
        const outIdx = map.get(col);
        if (outIdx === undefined) { miss = true; break; }
        projected.push(outIdx);
      }
      if (!miss) projectedKeys.push(projected);
    }

    // Substitute injectively-derived columns into existing keys (`SELECT id, id+1`
    // contributes both [col0] and [col1] as unique keys).
    for (const [srcIdx, outIdx] of injectivePairs) {
      const bareOut = map.get(srcIdx);
      if (bareOut === undefined || bareOut === outIdx) continue;
      const variants: number[][] = [];
      for (const key of projectedKeys) {
        if (key.includes(bareOut) && !key.includes(outIdx)) {
          variants.push(key.map(c => (c === bareOut ? outIdx : c)));
        }
      }
      projectedKeys.push(...variants);
    }

    let fds = projectFds(sourcePhysical?.fds ?? [], map);
    for (const key of projectedKeys) {
      const keyFd = superkeyToFd(key, outputColCount);
      if (keyFd) fds = addFd(fds, keyFd, { keyHints: projectedKeys });
    }
    for (const [srcIdx, outIdx] of injectivePairs) {
      const bareOut = map.get(srcIdx);
      if (bareOut === undefined || bareOut === outIdx) continue;
      // Injective-pair FDs are value bijections, not uniqueness claims —
      // 'determination', emitted unconditionally. The kind-aware readers
      // (`isUniqueDeterminant`) never derive a key from a determination on a
      // bag, so no endpoint gate is needed (project-node now matches; ticket
      // fd-determination-reader-side-rule).
      fds = addFd(fds, { determinants: [bareOut], dependents: [outIdx], kind: 'determination' }, { keyHints: projectedKeys });
      fds = addFd(fds, { determinants: [outIdx], dependents: [bareOut], kind: 'determination' }, { keyHints: projectedKeys });
    }
    const projectedEquiv: number[][] = [];
    for (const cls of sourcePhysical?.equivClasses ?? []) {
      const mapped: number[] = [];
      for (const c of cls) {
        const out = map.get(c);
        if (out !== undefined && !mapped.includes(out)) mapped.push(out);
      }
      if (mapped.length >= 2) projectedEquiv.push(mapped.sort((a, b) => a - b));
    }
    const projectedBindings = projectConstantBindings(sourcePhysical?.constantBindings ?? [], map);
    const projectedDomains = projectDomainConstraints(sourcePhysical?.domainConstraints ?? [], map);
    const projectedInds = projectInds(sourcePhysical?.inds ?? [], map);

    return {
      estimatedRows: this.estimatedRows,
      ordering: projectOrdering(sourcePhysical?.ordering, map),
      fds: fds.length > 0 ? fds : undefined,
      equivClasses: projectedEquiv.length > 0 ? projectedEquiv : undefined,
      constantBindings: projectedBindings.length > 0 ? projectedBindings : undefined,
      domainConstraints: projectedDomains.length > 0 ? projectedDomains : undefined,
      inds: projectedInds.length > 0 ? projectedInds : undefined,
    };
  }

  override toString(): string {
    const projList = this.projections.length > 3
      ? `${this.projections.length} columns`
      : this.projections.map(p => p.alias || 'expr').join(', ');
    return `RETURNING ${projList}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      executor: this.executor.nodeType,
      projectionCount: this.projections.length,
      projections: this.projections.map(proj => ({
        alias: proj.alias,
        expression: proj.node.toString()
      }))
    };
  }
}
