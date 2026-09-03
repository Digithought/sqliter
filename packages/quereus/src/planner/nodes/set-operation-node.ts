import { isRelationalNode, PlanNode } from './plan-node.js';
import type { RelationalPlanNode, Attribute, BinaryRelationalNode, PhysicalProperties, FunctionalDependency, DomainConstraint, ConstantBinding, UpdateSite } from './plan-node.js';
import type { RelationType, ColumnDef, CollationSource, ScalarType } from '../../common/datatype.js';
import type * as AST from '../../parser/ast.js';
import type { Expression } from '../../parser/ast.js';
import type { LogicalType } from '../../types/logical-type.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError, QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { EXISTENCE_FLAG_TYPE } from './join-utils.js';
import { superkeyToFd } from '../util/fd-utils.js';
import { resolveSetOpColumnCollation, collationConflictError } from '../analysis/comparison-collation.js';
import { mergeSetOpColumnType, mergeSetOpAdvertisedType } from '../analysis/set-op-type-merge.js';
import { physicalSourceRows, setOperationRowsFrom } from '../util/row-estimates.js';
import { ProjectNode, type Projection } from './project-node.js';
import { ColumnReferenceNode } from './reference.js';
import { CastNode } from './scalar.js';

/**
 * A data column's cross-input-resolved output metadata: the symmetric
 * logical-type merge (`mergeSetOpAdvertisedType`), OR-merged nullability, and
 * the comparison-lattice collation (override over the left base type).
 */
interface ResolvedDataColumn {
  readonly logicalType: LogicalType;
  readonly nullable: boolean;
  readonly collationName?: string;
  readonly collationSource?: CollationSource;
}

/**
 * One `<setop> exists <branch> as <name>` membership-flag column the
 * `SetOperationNode` appends after the data columns. The vertical (row) analogue
 * of the join's `ExistenceColumnSpec`: a clean `{true,false}` NOT NULL boolean
 * **derived at the combinator** by a per-branch semijoin probe (`tuple ∈ branch`),
 * never a stored operand column (which would re-enter the union schema and dedup).
 * The `attrId` is minted once at build time (so it is stable across `withChildren`
 * rebuilds); `branch` is the immediate operand whose membership the flag reifies.
 */
export interface SetOpMembershipSpec {
  readonly attrId: number;
  readonly name: string;
  readonly branch: 'left' | 'right';
}

/**
 * Recursive DATA (non-flag) arity of a set-operation operand. Flags are always
 * appended after the data columns at every depth, so a `SetOperationNode`'s data
 * arity is its left operand's data arity — bottoming out at the left-most non-set-op
 * leaf. A plain operand's data arity is simply its column count.
 */
function dataArity(node: RelationalPlanNode): number {
  return node instanceof SetOperationNode ? node.dataColumnCount() : node.getType().columns.length;
}

/**
 * Count of an operand's surfaced flag columns — everything beyond its data arity.
 * Zero for an unflagged leaf or a flag-less set-op; the recursive total of surfaced
 * flags for a (possibly nested) flagged set-op operand.
 */
function flagCount(node: RelationalPlanNode): number {
  return node.getType().columns.length - dataArity(node);
}

export class SetOperationNode extends PlanNode implements BinaryRelationalNode {
  readonly nodeType = PlanNodeType.SetOperation;
  private attributesCache: Cached<readonly Attribute[]>;
  /**
   * Per-data-column output metadata resolved across BOTH inputs: the symmetric
   * logical-type merge, OR-merged nullability, and the comparison-lattice
   * collation (`set-operation-cross-input-collation-merge`). Cached so
   * `buildAttributes` and `getType` read ONE result and cannot drift — the dedup
   * comparator (which keys off the output attribute type/collation) and an
   * enclosing ORDER BY (which keys off the output column type/collation) thus
   * stay in lockstep.
   */
  private dataColumnsCache: Cached<readonly ResolvedDataColumn[]>;

  constructor(
    scope: Scope,
    public readonly left: RelationalPlanNode,
    public readonly right: RelationalPlanNode,
    public readonly op: 'union' | 'unionAll' | 'intersect' | 'except',
    /**
     * Membership-flag columns appended after the data columns (read half:
     * `set-op-membership-read`). Empty/undefined for an ordinary set operation.
     */
    public readonly membership?: readonly SetOpMembershipSpec[],
  ) {
    // Self-cost only: both operands are in getChildren(), so their subtree costs
    // flow in via getTotalCost(). The combinator's own overhead is negligible.
    super(scope, 0.01);
    // Validate DATA column counts only. Alignment / the union schema / dedup / set
    // identity are all on data columns (model (b), `nestable-flagged-set-ops`): an
    // operand may itself be a (flagged) `SetOperationNode` whose flag columns inflate
    // its total arity but NOT its data arity, so comparing totals would spuriously
    // reject `A union[…] (B union[…] C)`. `dataArity` recurses to the left-most
    // non-set-op leaf, so an inner operand's surfaced flags never enter the check.
    const leftData = dataArity(left);
    const rightData = dataArity(right);
    if (leftData !== rightData) {
      throw new QuereusError(`SET operation column count mismatch: left has ${leftData}, right has ${rightData}`, StatusCode.ERROR);
    }
    // TODO: optionally check type compatibility (affinity)
    this.attributesCache = new Cached(() => this.buildAttributes());
    this.dataColumnsCache = new Cached(() => this.resolveDataColumns());
  }

  /**
   * Resolve each DATA column's cross-input output metadata:
   *
   * **Logical type** — the symmetric merge (`mergeSetOpAdvertisedType`): identical
   * types keep theirs, NULL yields to the other side, differing builtin numerics
   * merge to NUMERIC (whose `number | bigint` value space covers both branches
   * unconverted), and an irreconcilable pair advertises ANY. A rule-4
   * pair (object-physical vs other) also collapses to ANY *here*, because this
   * node performs no conversion itself — {@link SetOperationNode.create} aligns
   * such operands with a lenient CAST up front, so an aligned tree lands on the
   * identical-types rule instead. Everything downstream (the DML write pass's
   * `buildRowCoercion`, the dedup comparator, predicate coercion) trusts the
   * advertised type, so it must describe BOTH branches' rows.
   *
   * **Nullability** — OR across the two inputs (a nullable right branch must not
   * be masked by a NOT NULL left branch; same merge `AsyncGatherNode` applies).
   *
   * **Collation** — the shared comparison lattice (`resolveSetOpColumnCollation`).
   * The conflict policy is keyed on set-ness:
   *  - DISTINCT operators (`union`/`intersect`/`except`, `op !== 'unionAll'`) DO
   *    dedup, so a same-rank explicit/declared name conflict is a plan-time error
   *    — the same one a spelled-out `l.c = r.c` would throw. Forced at build time
   *    by `createSetOperationScope` (and, for DIFF, by the outer union forcing the
   *    nested except nodes transitively).
   *  - `union all` does NO dedup, so a conflict must NOT throw — it propagates no
   *    collation forward (BINARY-equivalent), exactly as `mergePropagatedCollation`
   *    swallows conflicts for `||` / CASE. Rows pass through unchanged (bag).
   *
   * Only the first `dataColumnCount()` columns are resolved; flag columns (appended
   * after, `EXISTENCE_FLAG_TYPE`, no collation) are never touched.
   */
  private resolveDataColumns(): readonly ResolvedDataColumn[] {
    const isSet = this.op !== 'unionAll';
    const leftColumns = this.left.getType().columns;
    const rightColumns = this.right.getType().columns;
    const dataCount = this.dataColumnCount();
    const resolved: ResolvedDataColumn[] = [];
    for (let i = 0; i < dataCount; i++) {
      const leftType = leftColumns[i].type;
      const rightType = rightColumns[i].type;
      const logicalType = mergeSetOpAdvertisedType(leftType.logicalType, rightType.logicalType);
      const nullable = leftType.nullable || rightType.nullable;
      const res = resolveSetOpColumnCollation(leftType, rightType);
      if (res.kind === 'conflict') {
        if (isSet) throw collationConflictError(res);
        resolved.push({ logicalType, nullable }); // union all: no comparison, carry no collation forward
      } else {
        resolved.push({ logicalType, nullable, collationName: res.collationName, collationSource: res.collationSource });
      }
    }
    return resolved;
  }

  /**
   * Data column `i`'s `ScalarType` rebased onto the cross-input-resolved output
   * metadata: `logicalType` is the symmetric cross-branch merge, `nullable` the
   * OR of both inputs, `collationName`/`collationSource` the comparison-lattice
   * resolution (both possibly `undefined` for the BINARY floor); the left
   * operand's type stays the base for everything else (`isReadOnly`). Callers map
   * this over the first `dataColumnCount()` attrs/columns, preserving attribute
   * ids (only the type changes) so ORDER BY / an enclosing view still resolve and
   * a `withChildren` rebuild yields the same ids.
   */
  private resolvedDataType(baseType: ScalarType, i: number): ScalarType {
    const c = this.dataColumnsCache.value[i];
    return {
      ...baseType,
      logicalType: c.logicalType,
      nullable: c.nullable,
      collationName: c.collationName,
      collationSource: c.collationSource,
    };
  }

  /** True when this set operation exposes its OWN membership flags. */
  get hasMembershipColumns(): boolean {
    return !!this.membership && this.membership.length > 0;
  }

  /**
   * True when this node surfaces ANY flag column — its own membership flags OR an
   * operand's surfaced flags (a flag-less outer over a flagged operand still surfaces
   * the inner flags). The runtime read half selects the buffering surfacing runner on
   * this, not on `hasMembershipColumns` alone.
   */
  get hasSurfacedFlags(): boolean {
    return this.hasMembershipColumns || this.leftFlagCount > 0 || this.rightFlagCount > 0;
  }

  /**
   * Number of DATA (non-flag) columns — recursively the left-most non-set-op leaf's
   * column count (flags are always appended after data, at every depth). Public: the
   * runtime emitter and the write half both need it.
   */
  dataColumnCount(): number {
    return dataArity(this.left);
  }

  /** Count of the LEFT operand's surfaced flag columns (0 for a plain / flag-less operand). */
  private get leftFlagCount(): number {
    return flagCount(this.left);
  }

  /** Count of the RIGHT operand's surfaced flag columns (0 for a plain / flag-less operand). */
  private get rightFlagCount(): number {
    return flagCount(this.right);
  }

  /**
   * Output index where this node's OWN membership flags begin, after the data columns
   * and BOTH operands' surfaced flag columns:
   * `[data] ++ [L flags] ++ [R flags] ++ [own flags]`.
   */
  private get ownFlagBase(): number {
    return this.dataColumnCount() + this.leftFlagCount + this.rightFlagCount;
  }

  /**
   * Output attributes under the defined projection rule
   * `[data] ++ [L flags] ++ [R flags] ++ [own flags]`:
   *  - data: the first `dataColumnCount` attrs taken verbatim from the left child
   *    (preserves data attribute ids so an ORDER BY / enclosing view still resolves);
   *  - L / R flags: each operand's attrs BEYOND its own data arity (their inner spec
   *    ids ride through verbatim, so a surfaced inner flag keeps the inner node's id);
   *  - own flags: the appended `{true,false}` NOT NULL booleans with pre-minted ids.
   */
  private buildAttributes(): readonly Attribute[] {
    const leftAttrs = this.left.getAttributes();
    const dataCount = this.dataColumnCount();
    // Data attrs carry the cross-input-resolved collation (ids preserved); the dedup
    // comparator and any enclosing ORDER BY both read collation from here.
    const dataAttrs: Attribute[] = leftAttrs.slice(0, dataCount).map((attr, i) => ({ ...attr, type: this.resolvedDataType(attr.type, i) }));
    // No flag anywhere → the result IS the (collation-resolved) data attributes;
    // ids unchanged so ORDER BY expressions resolve to the same ids.
    if (!this.hasSurfacedFlags) return dataAttrs;
    // `leftAttrs` is `[data] ++ [L flags]`: keep the L-flag slice verbatim. Append the
    // right operand's surfaced flags (beyond the shared data arity) and own flags.
    const ownFlagAttrs: Attribute[] = (this.membership ?? []).map(spec => ({ id: spec.attrId, name: spec.name, type: EXISTENCE_FLAG_TYPE }));
    return [
      ...dataAttrs,
      ...leftAttrs.slice(dataCount),
      ...this.right.getAttributes().slice(dataCount),
      ...ownFlagAttrs,
    ];
  }

  getAttributes(): readonly Attribute[] {
    return this.attributesCache.value;
  }

  getType(): RelationType {
    const leftType = this.left.getType();
    const isSet = this.op !== 'unionAll';
    // Key survival across set operations:
    //  - intersect / except: the result is a subset of the left rows, so every
    //    left key still holds on the result.
    //  - union / unionAll: the right side can reintroduce a value the left key
    //    made unique (and UNION ALL duplicates rows outright), so left keys do
    //    NOT survive. Set-ness of UNION/INTERSECT/EXCEPT is carried by `isSet`
    //    (the all-columns key) instead — copying `leftType.keys` here would
    //    over-claim (e.g. `select a,… from ta union select d,… from tb` has a
    //    non-unique first column).
    //  - Surfaced flags (own AND inner) are appended AFTER the data columns, so the key
    //    ColRefs (which index data columns) stay valid and a flag is NEVER part of a key
    //    at any depth (Key-Soundness Inv. 1–2).
    const keys = (this.op === 'intersect' || this.op === 'except') ? leftType.keys : [];
    // Data ColumnDefs carry the cross-input-resolved collation (same cached array the
    // output attrs use, so type.collationName and attr.type.collationName cannot drift).
    const dataCount = this.dataColumnCount();
    const dataColumns = leftType.columns.slice(0, dataCount).map((col, i) => ({ ...col, type: this.resolvedDataType(col.type, i) }));
    if (!this.hasSurfacedFlags) {
      return { ...leftType, isSet, keys, columns: dataColumns } as RelationType;
    }
    // Mirror buildAttributes' `[data] ++ [L flags] ++ [R flags] ++ [own flags]` layout.
    // `leftType.columns` is `[data] ++ [L flags]`: keep the L-flag slice verbatim; append
    // the right operand's surfaced flag ColumnDefs (beyond the shared data arity) and own flags.
    const ownFlagColumns: ColumnDef[] = (this.membership ?? []).map(spec => ({ name: spec.name, type: EXISTENCE_FLAG_TYPE }));
    const columns = [
      ...dataColumns,
      ...leftType.columns.slice(dataCount),
      ...this.right.getType().columns.slice(dataCount),
      ...ownFlagColumns,
    ];
    return { ...leftType, isSet, keys, columns } as RelationType;
  }

  getChildren(): readonly PlanNode[] {
    return [this.left, this.right];
  }

  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
    return [this.left, this.right];
  }

  /**
   * Pre-optimization branch composition ({@link setOperationRowsFrom}). Membership
   * flags are appended COLUMNS, so they never change the row count — both the
   * flagged and unflagged shapes report the same number.
   */
  get estimatedRows(): number | undefined {
    return setOperationRowsFrom(this.op, this.left.estimatedRows, this.right.estimatedRows);
  }

  /**
   * The same composition over the PHYSICAL branch counts. By this pass both
   * operands are usually physical access nodes (or wrappers over them), which
   * declare no `estimatedRows` getter — reading the logical side there would blank
   * the count for every node above the set operation (see `physicalSourceRows`).
   */
  private physicalRows(childrenPhysical: PhysicalProperties[]): number | undefined {
    return setOperationRowsFrom(
      this.op,
      physicalSourceRows(childrenPhysical?.[0], this.left),
      physicalSourceRows(childrenPhysical?.[1], this.right),
    );
  }

  computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
    // All set operations drop monotonicOn in this pass.
    // TODO: UNION ALL with disjoint X-ranges on both sides could preserve
    // MonotonicOn(X); see ticket 1-monotonic-on-characteristic for the deferred
    // range-bound reasoning.
    //
    // FDs / ECs / constantBindings over the DATA columns are dropped conservatively
    // here (see prior analysis below). The membership flags add their own forward
    // surface — `key → flag`, the `{true,false}` domain, and the read-only existence
    // `UpdateSite` — without touching the data columns' identity.
    //   - UNION ALL / EXCEPT ALL: no row-level FDs can be assumed.
    //   - UNION / INTERSECT: the all-columns FD is already captured by the
    //     `isSet` flag and downstream Distinct-style uniqueness; we do not
    //     materialize per-column FDs.
    //   - Constant bindings cannot survive: even if both sides bound `c = 5`,
    //     a row from the other side may have a different value (UNION of
    //     differing constants is no longer constant).
    if (!this.hasMembershipColumns) {
      return {
        estimatedRows: this.physicalRows(childrenPhysical),
        monotonicOn: undefined,
        fds: undefined,
        equivClasses: undefined,
        constantBindings: undefined,
        // Domains can't be assumed across set operations either: a UNION of
        // [a in (1,2)] with [a in (3)] would land outside both source domains.
        domainConstraints: undefined,
      };
    }

    return {
      // Flags are appended columns, not extra rows — same count as the plain branch.
      estimatedRows: this.physicalRows(childrenPhysical),
      monotonicOn: undefined,
      // Invariant 1: `key → flag` for the keyed distinct case (no claim for union all).
      fds: this.membershipFds(),
      equivClasses: undefined,
      // Optional constant-fold (Invariant 2): `except` ⇒ inRight=false, inLeft=true;
      // `intersect` ⇒ all flags true. union/unionAll bind nothing (a row may be in
      // either branch). The runtime probe agrees with these bindings.
      constantBindings: this.membershipConstantBindings(),
      // Domain `{true,false}` per flag — the clean-boolean point.
      domainConstraints: this.membershipDomains(),
      // The read-only `existence` `UpdateSite` per flag (the write half flips routing on).
      updateLineage: this.membershipLineage(),
    };
  }

  /**
   * `key → flag` forward FDs (Invariant 1). A DISTINCT set operation (`isSet`) is
   * keyed on its all-columns combination, so the data columns functionally determine
   * each flag (the flag is `tuple ∈ branch`, a function of the data tuple). A bag
   * (`union all`) has no data-column key, so it makes NO `key → flag` claim.
   */
  private membershipFds(): ReadonlyArray<FunctionalDependency> | undefined {
    if (this.op === 'unionAll') return undefined;
    const dataColCount = this.dataColumnCount();
    // Own flags follow the data columns AND both operands' surfaced flags. The
    // all-data superkey determines EVERY surfaced flag (own and inner — each is a
    // function of the data tuple it probes), so `superkeyToFd` over the full width
    // yields `key → {every surfaced flag}`.
    const totalCols = this.ownFlagBase + this.membership!.length;
    const allDataCols = Array.from({ length: dataColCount }, (_, i) => i);
    const keyFd = superkeyToFd(allDataCols, totalCols);
    return keyFd ? [keyFd] : undefined;
  }

  /** `{true,false}` enum domain per OWN appended flag (at its shifted index). */
  private membershipDomains(): ReadonlyArray<DomainConstraint> {
    const ownFlagBase = this.ownFlagBase;
    return this.membership!.map((_spec, i) => ({
      kind: 'enum' as const,
      column: ownFlagBase + i,
      values: [true, false],
    }));
  }

  /**
   * Constant-fold the trivially-determined flags (Invariant 2). For `except`
   * (`A except B`) every visible row is in the left and not the right, so a
   * `left` flag is constant-true and a `right` flag constant-false. For
   * `intersect` every visible row is in every branch, so all flags are
   * constant-true. `union` / `union all` fold nothing.
   */
  private membershipConstantBindings(): ReadonlyArray<ConstantBinding> | undefined {
    if (this.op !== 'except' && this.op !== 'intersect') return undefined;
    const ownFlagBase = this.ownFlagBase;
    const trueCols: number[] = [];
    const falseCols: number[] = [];
    this.membership!.forEach((spec, i) => {
      const col = ownFlagBase + i;
      const isTrue = this.op === 'intersect' || spec.branch === 'left';
      (isTrue ? trueCols : falseCols).push(col);
    });
    const bindings: ConstantBinding[] = [];
    if (trueCols.length > 0) bindings.push({ attrs: trueCols, value: { kind: 'literal', value: true } });
    if (falseCols.length > 0) bindings.push({ attrs: falseCols, value: { kind: 'literal', value: false } });
    return bindings.length > 0 ? bindings : undefined;
  }

  /**
   * One read-only `existence` `UpdateSite` per membership flag, naming the owning
   * `SetOperationNode` and the immediate operand the flag reifies. Read-only here
   * (`resolveBaseSite` resolves a `set-op-branch` component non-writable in this
   * half); the write half routes a membership-flip to that branch's sub-plan.
   *
   * The `guard` is the branch's accumulated selection predicate. In this read half
   * it is **carried, not consumed** (the write half computes the real conjunction of
   * σ predicates down to the branch's base for predicate-honest leaf addressing), so
   * a `true` literal placeholder is sufficient and honest about the read-half scope.
   */
  private membershipLineage(): ReadonlyMap<number, UpdateSite> | undefined {
    const lineage = new Map<number, UpdateSite>();
    const guard: Expression = { type: 'literal', value: true };
    const setOp = Number(this.id);
    for (const spec of this.membership!) {
      lineage.set(spec.attrId, {
        kind: 'existence',
        component: { kind: 'set-op-branch', setOp, branch: spec.branch },
        guard,
      });
    }
    return lineage.size > 0 ? lineage : undefined;
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 2) {
      quereusError(`SetOperationNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
    }

    const [newLeft, newRight] = newChildren;

    // Type check
    if (!isRelationalNode(newLeft)) {
      quereusError('SetOperationNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }
    if (!isRelationalNode(newRight)) {
      quereusError('SetOperationNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
    }

    // Return same instance if nothing changed
    if (newLeft === this.left && newRight === this.right) {
      return this;
    }

    // Rebuild through the aligning factory so an optimizer rewrite that changed a
    // branch's column types re-aligns (alignment is idempotent: already-aligned
    // operands hit the identical-types merge rule and are not re-wrapped, so the
    // ordinary type-preserving rewrite keeps the same children and attribute ids).
    // The membership specs carry pre-minted stable attribute ids, so they are
    // threaded verbatim (the appended flag columns survive the rebuild).
    // NOTE: every optimizer rule is type-preserving today, so re-alignment here is
    // always a no-op. If a rule ever hands back a child whose column TYPES changed,
    // this wraps that child and mints fresh cast-column attribute ids mid-optimization
    // — stale references above would then fail to resolve. Align before the rewrite
    // (or re-publish the ids) if that day comes.
    return SetOperationNode.create(
      this.scope,
      newLeft as RelationalPlanNode,
      newRight as RelationalPlanNode,
      this.op,
      this.membership,
    );
  }

  /**
   * Build a `SetOperationNode` over operands ALIGNED to the cross-branch merged
   * column types ({@link alignSetOpOperands}) — the construction path every
   * builder should use. Alignment is what lets the node advertise a concrete
   * merged type for a rule-4 pair (JSON ∪ TEXT): the non-object branch is
   * wrapped so it actually produces the merged type, after which both branches
   * agree and every consumer (DML write pass, dedup comparator, predicate
   * coercion) reads an honest type. Idempotent — aligned operands re-align to
   * themselves — so `withChildren` routes through here safely.
   */
  static create(
    scope: Scope,
    left: RelationalPlanNode,
    right: RelationalPlanNode,
    op: 'union' | 'unionAll' | 'intersect' | 'except',
    membership?: readonly SetOpMembershipSpec[],
  ): SetOperationNode {
    const [alignedLeft, alignedRight] = alignSetOpOperands(scope, left, right);
    return new SetOperationNode(scope, alignedLeft, alignedRight, op, membership);
  }

  override toString(): string {
    return `${this.op.toUpperCase()}(${this.left.id}, ${this.right.id})`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const base: Record<string, unknown> = { op: this.op };
    if (this.hasMembershipColumns) {
      base.membership = this.membership!.map(m => `exists ${m.branch} as ${m.name}`);
    }
    return base;
  }
}

/**
 * Align two set-operation operands to their cross-branch merged column types:
 * wherever the per-column merge requires converting one operand (rule 4 —
 * object-physical vs other, `mergeSetOpColumnType().convert`), wrap that operand
 * in a projection that CASTs the column to the merged type (lenient — a value
 * that does not parse falls back through `castFallback` rather than throwing, so
 * `select j from src union all select 'not json'` stays total). All other merge
 * outcomes (identical, NULL, numeric promotion, ANY) require no conversion and
 * leave both operands untouched.
 *
 * A DIFF builder must call this ONCE on the original operands before expanding
 * to `(A except B) union (B except A)`, so both inner nodes see the same aligned
 * pair; the subsequent {@link SetOperationNode.create} calls then re-align to a
 * no-op (identical types).
 *
 * A flag-surfacing operand (a flagged set operation, or a flag-less one over a
 * flagged operand) is never wrapped: a `ProjectNode` would flatten its surfaced
 * flag columns into the data arity `dataArity` recursively derives, breaking the
 * enclosing node's data/flag split. Such a pair stays unconverted and the node
 * honestly advertises ANY for the affected column (`mergeSetOpAdvertisedType`).
 */
export function alignSetOpOperands(
  scope: Scope,
  left: RelationalPlanNode,
  right: RelationalPlanNode,
): [RelationalPlanNode, RelationalPlanNode] {
  // Align only the shared data prefix; a data-arity mismatch is left for the
  // SetOperationNode constructor's error.
  const dataCount = Math.min(dataArity(left), dataArity(right));
  const leftColumns = left.getType().columns;
  const rightColumns = right.getType().columns;
  const leftCasts = new Map<number, LogicalType>();
  const rightCasts = new Map<number, LogicalType>();
  for (let i = 0; i < dataCount; i++) {
    const merged = mergeSetOpColumnType(leftColumns[i].type.logicalType, rightColumns[i].type.logicalType);
    if (merged.convert === 'left') leftCasts.set(i, merged.logicalType);
    else if (merged.convert === 'right') rightCasts.set(i, merged.logicalType);
  }
  const alignedLeft = leftCasts.size > 0 && flagCount(left) === 0 ? castColumns(scope, left, leftCasts) : left;
  const alignedRight = rightCasts.size > 0 && flagCount(right) === 0 ? castColumns(scope, right, rightCasts) : right;
  return [alignedLeft, alignedRight];
}

/**
 * Wrap `branch` in a `ProjectNode` that CASTs the columns in `casts` to their
 * target logical types and passes every other column through verbatim. A
 * passed-through column keeps its attribute id (an explicit `attributeId` on a
 * bare column-reference projection); a cast column mints a fresh id — its values
 * change, so reusing the source id would let a predicate be pushed below the
 * conversion. Only called for flag-less branches (see {@link alignSetOpOperands}),
 * so every projected column is a data column.
 */
function castColumns(
  scope: Scope,
  branch: RelationalPlanNode,
  casts: ReadonlyMap<number, LogicalType>,
): RelationalPlanNode {
  const attrs = branch.getAttributes();
  const projections: Projection[] = attrs.map((attr, i) => {
    const columnExpr: AST.ColumnExpr = { type: 'column', name: attr.name };
    const columnRef = new ColumnReferenceNode(scope, columnExpr, attr.type, attr.id, i);
    const target = casts.get(i);
    if (!target) {
      return { node: columnRef, alias: attr.name, attributeId: attr.id };
    }
    // `CastNode` resolves the target through the registry by name; rule-4 targets
    // are registered types (JSON today), so the name round-trips to the same
    // logical-type instance.
    const castExpr: AST.CastExpr = { type: 'cast', expr: columnExpr, targetType: target.name };
    return { node: new CastNode(scope, castExpr, columnRef), alias: attr.name, attributeId: PlanNode.nextAttrId() };
  });
  return new ProjectNode(scope, branch, projections);
}
