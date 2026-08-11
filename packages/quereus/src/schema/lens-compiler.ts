import type { Database } from '../core/database.js';
import type { Schema } from './schema.js';
import type { SchemaManager } from './manager.js';
import { columnsFormDeclaredKey, type TableSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type * as AST from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { astToString } from '../emit/ast-stringify.js';
import { buildLogicalConstraints, type LensSlot, type LensColumnProvenance,
	type LensRelationBacking, type LensTableSnapshot, type LensDeploymentSnapshot } from './lens.js';
import { computeSchemaHash } from './schema-hasher.js';
import { validateReservedTags, type TagDiagnostic } from './reserved-tags.js';
import { raiseReservedTagDiagnostics } from './reserved-tags-policy.js';
import { proveLens, collectColumnRefNames, type LensDeployReport, type LensDiagnostic, type ConstraintObligation } from './lens-prover.js';
import { applyAckGovernance, resolveEscalationPolicy, type AcknowledgedAdvisory } from './lens-ack.js';
import { createLogger } from '../common/logger.js';
import type { MappingAdvertisement, DecompositionMember, StorageShape } from '../vtab/mapping-advertisement.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';
import type { InclusionDependency } from '../planner/nodes/plan-node.js';
import { addInd, MAX_INDS_PER_NODE } from '../planner/util/fd-utils.js';
import { spineCloneAst } from '../util/ast-spine-clone.js';

const log = createLogger('schema:lens-compiler');

/**
 * Lens compiler — the `apply schema X` step for a **logical** schema.
 *
 * For each declared logical table it: builds the logical spec, aligns it against
 * the basis schema (the default name-based aligner), produces the inlined
 * effective view body, populates the lens slot, and registers the body as an
 * ordinary `ViewSchema`. The query processor then sees a view; reads ride the
 * standard view-resolution path and writes ride view-updateability.
 *
 * v1 is **single-source, name-based** (see `docs/lens.md` § The Default Mapper):
 * a logical table maps to a name-matching basis table, and each logical column
 * to a name-matching basis column. Type/nullability conformance and the n-way
 * decomposition shape are deferred to the prover / decomposition tickets.
 */

/**
 * Deploys (or re-deploys) a logical schema's lens slots + compiled view bodies.
 *
 * Re-deploy semantics are **clear-and-rebuild**: every existing lens view + slot
 * in the logical schema is dropped, then rebuilt from the current declaration.
 * This is how asymmetric removal falls out for free — a logical table dropped
 * from the declaration is simply not rebuilt (its view + slot vanish), and the
 * basis is never touched (logical removals never cascade to basis storage; see
 * `docs/lens.md` § Deployment).
 */
export function deployLogicalSchema(
	db: Database,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): LensDeployReport {
	validateLogicalDeclaration(declaredSchema, logicalSchemaName);

	const schemaManager = db.schemaManager;
	const logicalSchema = schemaManager.getSchemaOrFail(logicalSchemaName);

	// The lens block (explicit `over Y` basis + sparse overrides), if declared.
	// Re-read from source on every deploy — that is what lets a rename and a
	// later column-add compose without attribute-ID plumbing (docs/lens.md § D2).
	const lensDecl = db.declaredSchemaManager.getLensDeclaration(logicalSchemaName);
	const overridesByTable = indexOverrides(lensDecl, declaredSchema, logicalSchemaName);

	// Infer the basis lazily, only when there is ≥1 logical table to align. An
	// empty logical declaration (e.g. re-applying X after all its tables are
	// removed) is a pure detach-everything operation and must NOT fail on basis
	// resolution — removal never depends on the basis (asymmetric removal).
	let basis: { schema: Schema; schemaName: string } | undefined;
	const resolveBasis = (): { schema: Schema; schemaName: string } => {
		if (lensDecl) {
			// Explicit `over Y` binding resolves the foundation's default-basis
			// ambiguity (docs/lens.md § D4); `inferDefaultBasis` is NOT consulted.
			const basisSchema = schemaManager.getSchema(lensDecl.basisSchema);
			if (!basisSchema) {
				throw new QuereusError(
					`lens: basis schema '${lensDecl.basisSchema}' for logical schema '${logicalSchemaName}' does not exist (declared via 'declare lens for ${logicalSchemaName} over ${lensDecl.basisSchema}')`,
					StatusCode.ERROR,
				);
			}
			return { schema: basisSchema, schemaName: basisSchema.name };
		}
		return inferDefaultBasis(schemaManager, logicalSchemaName);
	};

	// Compile everything FIRST (basis alignment can throw — name mismatch, etc.).
	// Only after every table aligns successfully do we mutate the catalog, so a
	// failed re-apply leaves the existing lens state untouched (atomic deploy).
	// Module mapping advertisements are collected once per deploy (the first time a
	// basis is resolved) and filtered per logical table by the resolver.
	let allAdvertisements: MappingAdvertisement[] | undefined;

	const compiled: Array<{ slot: LensSlot; view: ViewSchema }> = [];
	// Prover accumulators (docs/lens.md § Coverage checklist). Errors aggregate
	// across every table and throw atomically below — before any catalog mutation,
	// preserving the existing atomic-deploy property. Warnings flow to the report.
	const proveErrors: LensDiagnostic[] = [];
	const proveWarnings: LensDiagnostic[] = [];
	const acknowledged: AcknowledgedAdvisory[] = [];
	const obligationsByTable = new Map<string, ReadonlyArray<ConstraintObligation>>();
	for (const item of declaredSchema.items) {
		if (item.type !== 'declaredTable') continue;

		basis ??= resolveBasis();
		allAdvertisements ??= collectAdvertisements(db, basis.schema);
		const logicalTable = schemaManager.buildLogicalTableSchema(item.tableStmt, logicalSchema.name);
		const override = overridesByTable.get(logicalTable.name.toLowerCase());

		// Resolve (collect → select primary → validate) the advertisement BEFORE body
		// compilation, so a malformed advertisement aborts the deploy atomically. The
		// resolved advertisement is **stored** on the slot, not yet synthesized — the
		// v1 name-match / override body producer below is unchanged by this ticket;
		// `lens-multi-source-decomposition` reads the slot to build the n-way body.
		const { advertisement, auxiliaryAccess } = resolveAdvertisement(
			allAdvertisements, logicalTable, basis, db, logicalSchemaName, override !== undefined,
		);

		let compiledBody: AST.SelectStmt;
		let provenance: LensColumnProvenance[];
		let effectiveColumns: string[];
		// Whether the body came from `compileDecompositionBody` (the synthesized
		// n-way decomposition). Only that body actually carries the advertised
		// `anchor ⋈ member` joins the existence-anchor IND describes, so it is the
		// only body the IND injection may attach to (R2 gate below).
		let fromDecomposition = false;
		if (override) {
			const merged = compileOverrideBody(logicalTable, logicalSchemaName, basis.schemaName, schemaManager, override, advertisement);
			compiledBody = merged.body;
			provenance = merged.provenance;
			effectiveColumns = merged.effectiveColumns;
			// Override ⊕ advertisement composition (docs/lens.md § Override-vs-advertisement):
			// a *sparse* override (one that relies on gap-fill) must not re-anchor or
			// reference relations outside the advertised decomposition. A *full*
			// hand-authored override (no gap-fill) bypasses the advertisement and is
			// not conflict-checked. Gap-fill *execution* from the advertisement lands
			// in `lens-multi-source-decomposition`; this ticket validates the conflict.
			if (advertisement && provenance.some(p => p.source === 'default')) {
				validateOverrideAdvertisementConflict(
					advertisement, override, basis.schemaName, schemaManager, logicalSchemaName, logicalTable.name,
				);
			}
		} else if (advertisement) {
			// A resolved primary-storage advertisement → synthesize the n-way `get`
			// join body from the decomposition (docs/lens.md § The Default Mapper).
			compiledBody = compileDecompositionBody(logicalTable, logicalSchemaName, basis, advertisement, db);
			provenance = logicalTable.columns.map(c => ({ logicalColumn: c.name, source: 'default' as const }));
			effectiveColumns = logicalTable.columns.map(c => c.name);
			fromDecomposition = true;
		} else {
			compiledBody = compileDefaultBody(logicalTable, logicalSchemaName, basis.schema, basis.schemaName);
			provenance = logicalTable.columns.map(c => ({ logicalColumn: c.name, source: 'default' as const }));
			effectiveColumns = logicalTable.columns.map(c => c.name);
		}

		// Annotate provenance with advertisement-backed member info (introspection).
		if (advertisement) annotateProvenanceWithAdvertisement(provenance, advertisement);

		// Inject the existence-anchor IND surface from a primary-storage
		// advertisement (lens-multi-source-ind-injection): one relation-IND per
		// mandatory non-anchor member, threaded to the prover via the slot so the
		// mandatory inner-joins are provably row-loss-free and the put fan-out is
		// sound against a derived existence fact. See docs/lens.md § The module
		// mapping advertisement and docs/optimizer-fd.md § Inclusion Dependency Tracking.
		//
		// Gated (R2) to the synthesized-decomposition body: only
		// `compileDecompositionBody` emits the advertised `anchor ⋈ member` joins the
		// IND describes. A full hand-authored override and the single-source default
		// body carry no such join, so injecting there would describe joins absent from
		// `compiledBody` — leave `injectedInds` undefined. (The future sparse-override
		// gap-fill body — `lens-multi-source-decomposition` — will carry the joins too;
		// extend the gate to it then.)
		const injectedInds = fromDecomposition
			? computeExistenceAnchorInds(advertisement!, basis, db)
			: [];

		const slot: LensSlot = {
			logicalTable,
			defaultBasis: { schemaName: basis.schemaName },
			override: override?.select,
			compiledBody,
			columnProvenance: provenance,
			attachedConstraints: buildLogicalConstraints(logicalTable),
			advertisement,
			auxiliaryAccess,
			injectedInds: injectedInds.length > 0 ? injectedInds : undefined,
		};

		// PoC: validate the reserved `quereus.*` tag namespace shape + site on the
		// logical table and its constraints, INSIDE the compile-first loop so an
		// invalid tag fails the deploy atomically (before any catalog mutation).
		// Only shape/site is checked here — no reserved tag's semantics are read.
		validateLensTags(slot);

		// Prove the slot and classify its constraints (docs/lens.md § Coverage
		// checklist). The verdict is recorded on the slot (obligations + readOnly)
		// and its diagnostics are aggregated into the deploy report. Errors are
		// thrown atomically after every table is proved (below), preserving the
		// atomic-deploy contract; warnings never block.
		const prove = proveLens(slot, db);
		slot.obligations = prove.obligations;
		slot.readOnly = prove.readOnly;

		// Acknowledgment + escalation governance (docs/lens.md § Acknowledging
		// advisories). Coded+sited advisories the prover emitted become
		// acknowledgeable in source (the `quereus.lens.ack.<code>` tag, with a
		// recorded fingerprint that re-surfaces them on material change), and the
		// per-table escalation policy promotes specific codes to blocking errors.
		// Escalation errors aggregate with the prover's and throw atomically below.
		const governance = applyAckGovernance(slot, prove.warnings, resolveEscalationPolicy(logicalTable));
		proveErrors.push(...prove.errors, ...governance.errors);
		proveWarnings.push(...governance.warnings);
		acknowledged.push(...governance.acknowledged);
		obligationsByTable.set(logicalTable.name.toLowerCase(), prove.obligations);

		const view: ViewSchema = {
			name: logicalTable.name,
			schemaName: logicalSchema.name,
			sql: astToString(compiledBody),
			selectAst: compiledBody,
			// Pin the consumer-facing column names to the *logical* declaration
			// (the contract), independent of the basis
			// column casing. Equivalent to `create view T(<logical cols>) as
			// <body>`: `select * from X.T` then surfaces the logical names, not
			// whatever the basis happens to spell them. Write-through is
			// unaffected (positional passthrough).
			columns: effectiveColumns,
			tags: logicalTable.tags,
		};
		compiled.push({ slot, view });
	}

	// Atomic block: any prover error aborts the deploy BEFORE the catalog mutation
	// below, so a failed re-apply leaves the prior lens state untouched. Every
	// blocking diagnostic is listed (sited) in one error.
	if (proveErrors.length > 0) {
		throw new QuereusError(formatProveErrors(logicalSchemaName, proveErrors), StatusCode.ERROR);
	}

	// Clear-and-rebuild: drop all current lens views + slots, then register the
	// freshly compiled set. A logical schema's views are exclusively lens bodies,
	// so dropping every view is safe and implements detach for tables removed
	// from the declaration (logical removals never touch basis storage).
	for (const view of Array.from(logicalSchema.getAllViews())) {
		logicalSchema.removeView(view.name);
	}
	logicalSchema.clearLensSlots();

	for (const { slot, view } of compiled) {
		logicalSchema.addLensSlot(slot);
		logicalSchema.addView(view);
		log('Deployed lens for %s.%s over %s', logicalSchemaName, slot.logicalTable.name, slot.defaultBasis.schemaName);
	}

	// The lens-slot set just changed (the only slot-mutating site that fires no
	// `SchemaChangeEvent`), so the lens basis-FK gate is stale — reset it directly,
	// sibling to the snapshot rotation. The next basis write rebuilds it and reflects
	// any added / removed logical FK in this deploy.
	schemaManager.invalidateLensFkGate();

	// Capture + rotate the deployed-basis snapshot AFTER a successful catalog
	// mutation, so an aborted re-apply leaves the prior snapshot untouched. The
	// snapshot is the source of truth the `quereus_basis_backfill` differ reads
	// (docs/lens.md § The deployed basis representation).
	const snapshot = buildDeploymentSnapshot(db, compiled, basis, logicalSchemaName);
	db.declaredSchemaManager.rotateDeployedLensSnapshot(logicalSchemaName, snapshot);

	// Errors are already thrown above; a returned report carries only advisories.
	// Persist it on the manager — the stable hook the sibling acknowledgment ticket
	// reads to fingerprint / tally / expand advisories (docs/lens.md § Acknowledging
	// advisories). `apply schema` returning these as result rows is deferred to that
	// ticket (converting the universally-used void statement to relational is a
	// separate, high-blast-radius change); the report is fully produced here.
	const report: LensDeployReport = { errors: [], warnings: proveWarnings, acknowledged, obligationsByTable };
	db.declaredSchemaManager.setDeployedLensReport(logicalSchemaName, report);
	return report;
}

/**
 * Formats the aggregated blocking diagnostics into one atomic deploy error. Each
 * diagnostic's `message` is included verbatim (so a caller / test matching a
 * specific sited substring still matches), prefixed by its stable code.
 */
function formatProveErrors(logicalSchemaName: string, errors: ReadonlyArray<LensDiagnostic>): string {
	const lines = errors.map(e => ` - [${e.code}] ${e.message}`);
	return `lens: deploy of logical schema '${logicalSchemaName}' blocked by ${errors.length} error(s):\n${lines.join('\n')}`;
}

/**
 * Builds the {@link LensDeploymentSnapshot} for a just-completed deploy: per
 * logical table, the compiled get-body, its logical columns, and the
 * per-column basis backing (relation + column) derived from the effective body.
 * Also records `basisHash = computeSchemaHash(basis declared schema)` — the
 * migration-safety record. An empty deploy (every logical table removed, no
 * basis resolved) yields an empty-tables snapshot that still rotates, so the
 * detach is reflected.
 */
function buildDeploymentSnapshot(
	db: Database,
	compiled: ReadonlyArray<{ slot: LensSlot; view: ViewSchema }>,
	basis: { schema: Schema; schemaName: string } | undefined,
	logicalSchemaName: string,
): LensDeploymentSnapshot {
	const priorBasisName = db.declaredSchemaManager.getDeployedLensSnapshots(logicalSchemaName)?.current?.basisSchemaName;
	const basisSchemaName = basis?.schemaName ?? priorBasisName ?? '';
	const basisDeclared = basisSchemaName
		? db.declaredSchemaManager.getDeclaredSchema(basisSchemaName)
		: undefined;
	const basisHash = basisDeclared ? computeSchemaHash(basisDeclared) : '';

	const tables = new Map<string, LensTableSnapshot>();
	if (basis) {
		for (const { slot } of compiled) {
			const relationBacking = deriveRelationBacking(slot.compiledBody, slot.columnProvenance, basis, db.schemaManager);
			const logicalColumns = slot.columnProvenance.map(p => p.logicalColumn);
			const surrogateMemberKeys = deriveSurrogateMemberKeys(slot, basis);
			tables.set(slot.logicalTable.name.toLowerCase(), {
				logicalTable: slot.logicalTable.name,
				getBody: slot.compiledBody,
				logicalColumns,
				relationBacking,
				surrogateMemberKeys,
			});
		}
	}
	return { basisSchemaName, basisHash, tables };
}

/** Lowercased `schema.table` identity for an override source's basis relation. */
function sourceRelKey(src: OverrideSource): string {
	return `${src.table.schemaName.toLowerCase()}.${src.table.name.toLowerCase()}`;
}

/**
 * The basis columns an engine-generated skeleton insert must supply: NOT NULL,
 * no default, non-generated. A column that is nullable, defaulted, or generated
 * has its own value source, so a skeleton may soundly omit it; these have none,
 * so omitting one would fail an unguarded NOT NULL constraint. Walks the member's
 * *full* schema so it also flags required columns the lens maps to no logical
 * column (which never appear in the relation's `(basisColumn → logicalColumn)`
 * pairs). See `LensRelationBacking.requiredBasisColumns`.
 */
function requiredBasisColumnsOf(table: TableSchema): string[] {
	return table.columns
		.filter(c => c.notNull && c.defaultValue === null && !c.generated)
		.map(c => c.name);
}

/**
 * Derives, per basis relation, the `(basisColumn → logicalColumn)` pairs it backs
 * for one compiled effective body — the record a later re-decomposition diffs and
 * backfills (docs/lens.md § The deployed basis representation). Two contributions:
 *
 * 1. **Projection.** The body's projection is exactly the logical
 *    columns, in declaration order (see `compileDefaultBody` / `compileOverrideBody`);
 *    each plain column reference resolves to its FROM source. A computed
 *    (non-column) projection has no single basis backing and is omitted.
 * 2. **Shared join keys.** A columnar split joins its members on a shared key but
 *    projects it only once (from the anchor). The other members carry the key
 *    column too and must be backfilled with it, else a `not null` key fails. So
 *    every join-key column equated to a *projected* logical column is threaded to
 *    its member, mapped to that logical column.
 */
function deriveRelationBacking(
	body: AST.SelectStmt,
	provenance: ReadonlyArray<LensColumnProvenance>,
	basis: { schema: Schema; schemaName: string },
	schemaManager: SchemaManager,
): Map<string, LensRelationBacking> {
	// The compiled body is fully qualified (see `qualifyBasisSources`), so a bare
	// name surviving in it is a CTE reference or unresolvable — never a basis
	// table. Carry the shadow set so neither pass claims a CTE as basis backing.
	const cteNames = collectCteNames(body);
	const { sources } = collectOverrideSources(body.from, basis.schemaName, schemaManager, cteNames);
	const byRef = new Map<string, OverrideSource>();
	for (const s of sources) byRef.set(s.refName.toLowerCase(), s);
	const single = sources.length === 1 ? sources[0] : undefined;

	const result = new Map<string, LensRelationBacking>();
	const add = (src: OverrideSource, basisColumn: string, logicalColumn: string): void => {
		const key = sourceRelKey(src);
		let rb = result.get(key);
		if (!rb) {
			rb = {
				relationId: key,
				basisRelation: { schema: src.table.schemaName, table: src.table.name },
				columns: [],
				requiredBasisColumns: requiredBasisColumnsOf(src.table),
			};
			result.set(key, rb);
		}
		const cols = rb.columns as Array<{ basisColumn: string; logicalColumn: string }>;
		if (!cols.some(c => c.basisColumn.toLowerCase() === basisColumn.toLowerCase())) {
			cols.push({ basisColumn, logicalColumn });
		}
	};

	// 1. Projection.
	const projected: Array<{ logical: string; src: OverrideSource; basisColumn: string }> = [];
	for (let i = 0; i < provenance.length && i < body.columns.length; i++) {
		const rc = body.columns[i];
		if (rc.type !== 'column') continue;
		const expr = rc.expr;
		if (expr.type !== 'column') continue; // computed → no single backing relation
		const colExpr = expr as AST.ColumnExpr;
		const src = colExpr.table ? byRef.get(colExpr.table.toLowerCase()) : single;
		if (!src) continue; // unqualified ref over a multi-source FROM, or an opaque source
		projected.push({ logical: provenance[i].logicalColumn, src, basisColumn: colExpr.name });
		add(src, colExpr.name, provenance[i].logicalColumn);
	}

	// 2. Shared join keys — thread each equated key column to a projected logical column.
	for (const cls of collectJoinKeyEquivalences(body.from, basis.schemaName, schemaManager, cteNames)) {
		let logical: string | undefined;
		for (const m of cls) {
			const proj = projected.find(p => sourceRelKey(p.src) === sourceRelKey(m.src)
				&& p.basisColumn.toLowerCase() === m.column.toLowerCase());
			if (proj) { logical = proj.logical; break; }
		}
		if (!logical) continue; // key not surfaced as a logical column → leave to multi-source
		for (const m of cls) add(m.src, m.column, logical);
	}

	return result;
}

/** One member of a join-key equivalence class: a basis source's key column. */
interface KeyMember {
	src: OverrideSource;
	/** The basis column name (original case) on `src` that the join equates. */
	column: string;
}

/**
 * Collects join-key equivalence classes from a body's FROM. Each `using (cols)`
 * join contributes, per column, the equated key columns across its left/right
 * subtree sources; each `on a.x = b.y` conjunct contributes that pair. Overlapping
 * classes are harmless — threading dedups per relation.
 */
function collectJoinKeyEquivalences(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	cteNames: ReadonlySet<string>,
): KeyMember[][] {
	const classes: KeyMember[][] = [];
	if (!from) return classes;

	const resolveTableSources = (node: AST.FromClause): OverrideSource[] => {
		const out: OverrideSource[] = [];
		const walk = (n: AST.FromClause): void => {
			if (n.type === 'table') {
				const tbl = resolveBasisTableSource(n, basisSchemaName, schemaManager, cteNames);
				if (tbl) out.push({ table: tbl, refName: n.alias ?? tbl.name });
			} else if (n.type === 'join') {
				walk(n.left);
				walk(n.right);
			}
		};
		walk(node);
		return out;
	};

	const memberFor = (src: OverrideSource, colName: string): KeyMember | undefined => {
		const idx = src.table.columnIndexMap.get(colName.toLowerCase());
		if (idx === undefined) return undefined;
		return { src, column: src.table.columns[idx].name };
	};

	const walkJoin = (node: AST.FromClause): void => {
		if (node.type !== 'join') return;
		walkJoin(node.left);
		walkJoin(node.right);
		const subtree = [...resolveTableSources(node.left), ...resolveTableSources(node.right)];
		if (node.columns) {
			// USING (cols): equate each named column across every subtree source carrying it.
			for (const col of node.columns) {
				const members = subtree.map(s => memberFor(s, col)).filter((m): m is KeyMember => m !== undefined);
				if (members.length > 1) classes.push(members);
			}
		} else if (node.condition) {
			// ON a.x = b.y [and ...]: best-effort equality-conjunct extraction.
			const byRef = new Map<string, OverrideSource>();
			for (const s of subtree) byRef.set(s.refName.toLowerCase(), s);
			for (const [left, right] of collectEqualityPairs(node.condition)) {
				if (!left.table || !right.table) continue;
				const ls = byRef.get(left.table.toLowerCase());
				const rs = byRef.get(right.table.toLowerCase());
				if (!ls || !rs) continue;
				const lm = memberFor(ls, left.name);
				const rm = memberFor(rs, right.name);
				if (lm && rm) classes.push([lm, rm]);
			}
		}
	};
	for (const f of from) walkJoin(f);
	return classes;
}

/** Extracts `col = col` conjuncts from an ON condition (best-effort, AND-only). */
function collectEqualityPairs(expr: AST.Expression): Array<[AST.ColumnExpr, AST.ColumnExpr]> {
	const pairs: Array<[AST.ColumnExpr, AST.ColumnExpr]> = [];
	const walk = (e: AST.Expression): void => {
		if (e.type !== 'binary') return;
		const bin = e as AST.BinaryExpr;
		if (bin.operator.toUpperCase() === 'AND') {
			walk(bin.left);
			walk(bin.right);
		} else if (bin.operator === '=' && bin.left.type === 'column' && bin.right.type === 'column') {
			pairs.push([bin.left as AST.ColumnExpr, bin.right as AST.ColumnExpr]);
		}
	};
	walk(expr);
	return pairs;
}

/**
 * The basis-relation keys (`schema.table`, lowercased) of a slot's surrogate-keyed
 * decomposition members, or undefined when there is no advertisement / the shared
 * key is a logical-tuple. Lets the differ defer an unsound multi-member surrogate
 * split (see `docs/lens.md` § The Default Mapper — evaluate-once-and-thread).
 */
function deriveSurrogateMemberKeys(
	slot: LensSlot,
	basis: { schema: Schema; schemaName: string },
): ReadonlySet<string> | undefined {
	const storage = slot.advertisement?.storage;
	if (!storage || storage.sharedKey.kind !== 'surrogate') return undefined;
	const keys = new Set<string>();
	for (const m of storage.members) {
		const schemaName = (m.relation.schema || basis.schemaName).toLowerCase();
		keys.add(`${schemaName}.${m.relation.table.toLowerCase()}`);
	}
	return keys;
}

/**
 * PoC wiring for `reserved-tags.ts`: validates the reserved `quereus.*` tag
 * namespace on one lens slot's logical table (`logical-table` site), each of its
 * logical columns (`logical-column` site — the home of `quereus.lens.writable`),
 * and each of its attached constraints (`logical-constraint` site).
 *
 * Severity policy is the registry's; this caller only routes it: a
 * `severity:'error'` diagnostic (unknown key, mis-sited key, malformed enum/CSV
 * value) throws a {@link QuereusError} with the sited message — consistent with
 * the other compile-time lens errors, and atomic because validation runs before
 * catalog mutation. `severity:'warning'` diagnostics (e.g. an empty
 * `quereus.lens.ack` rationale) are logged via the existing `log` channel; the
 * deploy-summary warning channel (`docs/lens.md:169`) is `3-lens-prover` Phase
 * C's to build. Errors take precedence — warnings only log when none fail.
 *
 * This validates shape/site only — no reserved tag carries behavior read here.
 */
function validateLensTags(slot: LensSlot): void {
	const diagnostics: TagDiagnostic[] = [
		...validateReservedTags(slot.logicalTable.tags, 'logical-table'),
	];
	// Each logical column's tags at the `logical-column` site (the home of
	// `quereus.lens.writable`). This also closes a pre-existing gap: a typo'd /
	// mis-sited `quereus.*` key on a logical column was previously never validated.
	for (const col of slot.logicalTable.columns) {
		if (col.tags) diagnostics.push(...validateReservedTags(col.tags, 'logical-column'));
	}
	for (const constraint of slot.attachedConstraints) {
		const tags = constraint.kind === 'primaryKey' || constraint.kind === 'notNull'
			? undefined
			: constraint.constraint.tags;
		if (tags) diagnostics.push(...validateReservedTags(tags, 'logical-constraint'));
	}

	raiseReservedTagDiagnostics(diagnostics, {
		log: (diag) => log('lens advisory (%s) on %s.%s: %s', diag.reason, slot.logicalTable.schemaName, slot.logicalTable.name, diag.message),
	});
}

/**
 * Rejects every physical construct under a logical declared schema, naming the
 * offending construct and the logical-schema context. Tags are allowed (they
 * are engine-facing and survive into the compiled view).
 */
export function validateLogicalDeclaration(
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	const ctx = `logical schema '${logicalSchemaName}'`;
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				if (item.tableStmt.moduleName) {
					throw new QuereusError(
						`lens: module association 'using ${item.tableStmt.moduleName}(...)' on table '${item.tableStmt.table.name}' is not allowed in ${ctx}; logical tables declare columns and constraints only`,
						StatusCode.ERROR,
					);
				}
				break;
			}
			case 'declaredIndex': {
				const kind = item.indexStmt.isUnique ? 'unique index' : 'index';
				throw new QuereusError(
					`lens: ${kind} '${item.indexStmt.index.name}' is not allowed in ${ctx}; indexes are a basis-layer construct (a materialized view over the basis)`,
					StatusCode.ERROR,
				);
			}
			case 'declaredMaterializedView': {
				throw new QuereusError(
					`lens: materialized view '${item.viewStmt.view.name}' is not allowed in ${ctx}; materialized views are a basis-layer construct`,
					StatusCode.ERROR,
				);
			}
			// declaredView / declaredSeed / declaredAssertion / declareIgnored:
			// not part of the logical-table surface in v1 — neither rejected nor
			// processed by the lens compiler (only declaredTable becomes a slot).
		}
	}
}

/**
 * Infers the default basis for a logical schema (MVP binding — there is no
 * `declare lens for X over Y` yet). The basis is the single registered
 * **physical** schema that contains ≥1 table, excluding the logical schema
 * itself and `temp`. See `docs/lens.md` § Default-basis inference.
 */
export function inferDefaultBasis(
	schemaManager: SchemaManager,
	logicalSchemaName: string,
): { schema: Schema; schemaName: string } {
	const lowerLogical = logicalSchemaName.toLowerCase();
	const candidates: Array<{ schema: Schema; schemaName: string }> = [];

	for (const schema of schemaManager._getAllSchemas()) {
		const lowerName = schema.name.toLowerCase();
		if (lowerName === lowerLogical) continue;
		if (lowerName === 'temp') continue;
		if (schema.kind !== 'physical') continue;

		let hasTable = false;
		for (const _t of schema.getAllTables()) { hasTable = true; break; }
		if (!hasTable) continue;

		candidates.push({ schema, schemaName: schema.name });
	}

	if (candidates.length === 1) {
		return candidates[0];
	}

	throw new QuereusError(
		`lens: cannot infer a default basis for logical schema '${logicalSchemaName}' (found ${candidates.length} candidates); supply 'declare lens for ${logicalSchemaName} over <basis>'`,
		StatusCode.ERROR,
	);
}

/**
 * The default name-based aligner: produces `select <logical columns> from B.T'`
 * for one logical table `L.T` over basis schema `B`.
 *
 * - The basis table is matched by name (case-insensitive).
 * - Each logical column is matched to a basis column by name (case-insensitive).
 * - The projection lists exactly the logical columns, in declaration order, so
 *   a basis table with extra columns is correctly projected down.
 *
 * The empty-key (singleton) case needs no special path: a `primary key ()`
 * logical table over a `primary key ()` basis table is an ordinary single-source
 * projection.
 */
export function compileDefaultBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchema: Schema,
	basisSchemaName: string,
): AST.SelectStmt {
	const logicalName = logicalTable.name;
	const basisTable = basisSchema.getTable(logicalName);
	if (!basisTable) {
		throw new QuereusError(
			`lens: logical table '${logicalSchemaName}.${logicalName}' has no basis backing`,
			StatusCode.ERROR,
		);
	}

	const columns: AST.ResultColumn[] = [];
	for (const col of logicalTable.columns) {
		const basisColIdx = basisTable.columnIndexMap.get(col.name.toLowerCase());
		if (basisColIdx === undefined) {
			throw new QuereusError(
				`lens: logical column '${logicalSchemaName}.${logicalName}.${col.name}' has no basis backing`,
				StatusCode.ERROR,
			);
		}
		// Single source → an unqualified column reference is unambiguous. Reference
		// the basis column by its actual name; the consumer-facing column *names*
		// (and casing) are pinned to the logical declaration via the registered
		// view's explicit column list (see `deployLogicalSchema`), so the basis
		// spelling never leaks through `select * from Logical.T`.
		const basisColName = basisTable.columns[basisColIdx].name;
		columns.push({
			type: 'column',
			expr: { type: 'column', name: basisColName } as AST.ColumnExpr,
		});
	}

	return {
		type: 'select',
		columns,
		from: [{
			type: 'table',
			table: { type: 'identifier', name: basisTable.name, schema: basisSchemaName },
		}],
	};
}

// ===========================================================================
// n-way decomposition synthesis (docs/lens.md § The Default Mapper)
// ===========================================================================
//
// When a logical table is backed by a resolved primary-storage advertisement,
// the body producer synthesizes the `get` join instead of the single-source
// name aligner: a left-deep equi-join rooted at the existence anchor, mandatory
// members inner-joined and optional members outer-joined, EAV pivot members
// projected as correlated scalar subqueries (not joined), and the projection
// resolving each logical column to its advertised backing expression. Read
// direction only — the `put` fan-out + IND injection are sibling tickets; a
// multi-source body remains write-rejected by view-updateability.

/**
 * Synthesizes the n-way `get` body for a logical table backed by a resolved
 * primary-storage advertisement.
 *
 * The synthesized FROM is a left-deep join tree rooted at `anchorRelationId`:
 * every other non-EAV member is inner-joined (`presence:'mandatory'`) or
 * outer-joined (`presence:'optional'`) onto the anchor via a positional
 * key-equi-join over `sharedKey.keyColumnsByRelation`. Optional members are
 * outer-joined so a logical row missing an optional component survives with that
 * component's columns null (inner-joining everywhere would silently drop rows).
 *
 * The empty-key (singleton) case is not a special path: an empty per-member key
 * column list makes the equi-join conjunction vacuously true (`on 1 = 1`), so a
 * `primary key ()` table over a 0-or-1-row anchor reads 0-or-1 row.
 *
 * EAV pivot members are NOT join members (joining a triple store would multiply
 * rows); each EAV-backed logical column is projected as a correlated scalar
 * subquery keyed by the attribute literal.
 */
function compileDecompositionBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basis: { schema: Schema; schemaName: string },
	advertisement: MappingAdvertisement,
	db: Database,
): AST.SelectStmt {
	const storage = advertisement.storage;
	if (!storage) {
		// A primary advertisement always carries a storage shape (validated at
		// resolution); guard defensively rather than emit an unsound body.
		throw new QuereusError(
			`lens: decomposition for logical table '${logicalSchemaName}.${logicalTable.name}' has a primary advertisement with no storage shape`,
			StatusCode.ERROR,
		);
	}
	const logicalName = logicalTable.name;

	// Resolve every member's basis table (re-resolved here for the synthesized
	// FROM's actual table name + schema casing; existence is validated already).
	const memberTables = new Map<string, TableSchema>();
	for (const member of storage.members) {
		const table = resolveBasisRelation(db, member, basis);
		if (!table) {
			throw new QuereusError(
				`lens: decomposition for logical table '${logicalSchemaName}.${logicalName}' references basis relation '${member.relation.schema}.${member.relation.table}' (member '${member.relationId}'), which does not exist`,
				StatusCode.ERROR,
			);
		}
		memberTables.set(member.relationId, table);
	}

	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) {
		throw new QuereusError(
			`lens: decomposition for logical table '${logicalSchemaName}.${logicalName}' names anchor '${storage.anchorRelationId}', which is not among the members`,
			StatusCode.ERROR,
		);
	}
	const anchorTable = memberTables.get(anchor.relationId)!;
	const anchorKeys = storage.sharedKey.keyColumnsByRelation.get(anchor.relationId) ?? [];

	// The join set: the anchor (root) + every non-EAV member. EAV pivot members
	// back columns via a correlated subquery, never a join.
	const joinedMembers = new Set<string>([anchor.relationId]);
	for (const member of storage.members) {
		if (member.relationId === anchor.relationId) continue;
		if (member.attributePivot) continue; // EAV → subquery, not joined
		joinedMembers.add(member.relationId);
	}

	// Build the left-deep join tree, anchor first.
	let from: AST.FromClause = memberTableSource(anchorTable, basis.schemaName, anchor.relationId);
	for (const member of storage.members) {
		if (!joinedMembers.has(member.relationId) || member.relationId === anchor.relationId) continue;
		const memberTable = memberTables.get(member.relationId)!;
		const memberKeys = storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
		from = {
			type: 'join',
			joinType: member.presence === 'mandatory' ? 'inner' : 'left',
			left: from,
			right: memberTableSource(memberTable, basis.schemaName, member.relationId),
			condition: buildKeyEquiJoin(anchor.relationId, anchorKeys, member.relationId, memberKeys),
		};
	}

	// Projection: each logical column → its advertised backing expression.
	const aliasOf = (relationId: string): string | undefined =>
		joinedMembers.has(relationId) ? relationId : undefined;
	const eavAnchor = anchorKeys.length > 0
		? { alias: anchor.relationId, keyColumn: anchorKeys[0] }
		: undefined;

	const columns: AST.ResultColumn[] = [];
	for (const col of logicalTable.columns) {
		const res = resolveAdvertisedColumn(col.name, storage, basis.schemaName, aliasOf, eavAnchor);
		let expr: AST.Expression;
		if (res.kind === 'expr') {
			expr = res.expr;
		} else if (res.kind === 'unreachable') {
			throw new QuereusError(
				`lens: decomposition for logical table '${logicalSchemaName}.${logicalName}' maps column '${col.name}' to member '${res.member}', which is not part of the synthesized join (an EAV pivot member backs columns through its attribute pivot, not a direct column mapping)`,
				StatusCode.ERROR,
			);
		} else {
			// Name-match against a join member (anchor first), qualified by the
			// member's alias — the decomposition analogue of the single-source path.
			const nm = nameMatchAgainstMembers(col.name, storage, memberTables, joinedMembers, anchor.relationId);
			if (!nm) {
				throw new QuereusError(
					`lens: decomposition for logical table '${logicalSchemaName}.${logicalName}' cannot resolve column '${col.name}': it is not mapped by any advertised member, not EAV-backed, and no decomposition member has a same-named column`,
					StatusCode.ERROR,
				);
			}
			expr = nm;
		}
		columns.push({ type: 'column', expr, alias: col.name });
	}

	return { type: 'select', columns, from: [from] };
}

/**
 * Computes the existence-anchor inclusion dependencies for a decomposition
 * (`lens-multi-source-ind-injection`, docs/lens.md § The module mapping
 * advertisement). For each **mandatory**, non-anchor, non-EAV member, injects one
 * IND asserting the existence **anchor's** shared-key tuple is included in that
 * member's key — the propagated fact that lets the prover discharge the
 * no-row-loss obligation of the anchor-rooted inner join against a threaded
 * existence fact rather than re-deriving decomposition structure. The surrogate
 * join carries no declared SQL FK, so `seedTableForeignKeyInds` / `lookupCoveringFK`
 * are structurally blind to it; this is the `IndTarget.kind:'relation'` producer
 * reserved by Wave 1.
 *
 * Direction + soundness. `compileDecompositionBody` builds a left-deep join
 * **rooted at the anchor**, inner-joining each mandatory member (`anchor ⋈ member`);
 * the logical entities are the anchor rows (one per logical row). The no-row-loss
 * obligation the prover discharges is therefore "no anchor row is dropped"
 * (`tSide = anchor`, `lookup = member`), which it reads from an IND **on the
 * anchor** of the form `anchor.key ⊆ member.key`. `presence:'mandatory'` ("every
 * logical row has it") guarantees exactly that: every anchor (= logical) row has a
 * matching member row on the shared key ⇒ `anchor.key ⊆ member.key`, total
 * (`nullRejecting:false`) — exactly the existence fact the anchor-rooted inner
 * join's row-preservation obligation needs. The converse (`member ⊆ anchor`) is
 * **intentionally not asserted**: no stated property guarantees member→anchor
 * referential integrity, so emitting it would over-claim (a mandatory-member row
 * whose key is absent from the anchor is simply filtered by the inner join — reads
 * stay correct, but the converse fact would be false).
 *
 * Guards (over-claim is unsound — Wave 1's § Enforcement readiness):
 * - **mandatory only** — an optional member is outer-joined; its absence is
 *   exactly what the outer join preserves, so an IND would over-claim.
 * - **total only** (`nullRejecting:false`) — a mandatory member's existence is
 *   total: every logical row has it.
 * - **EAV pivots excluded** — they are projected as correlated subqueries, never
 *   inner-joined, so there is no row-loss obligation to discharge.
 * - **empty key → none** — a singleton (`primary key ()`) has no witnessing key
 *   tuple; existence is the anchor's own 0-or-1-row property.
 *
 * `cols` are the **anchor's** shared-key column indices on the anchor's basis
 * relation; `target.targetCols` the **member's** key column indices on the member's
 * basis relation; `target.relationId` is the member (not the anchor). Anchor/member
 * key columns pair positionally, matching the get-synthesis equi-join. Uses `addInd`
 * + `MAX_INDS_PER_NODE` for dedup/cap consistency with the Wave-1 FK seeding;
 * multiple mandatory members produce distinct INDs (same `cols` = anchor key,
 * different `target.relationId`), so dedup is unaffected.
 *
 * NOT gated by `permitsOrphanedForeignKeyRows` (OPT-059): these INDs assert
 * `anchor.key ⊆ member.key` from the mapping advertisement's
 * `presence: 'mandatory'` declaration — a different promise from a different
 * declarant than a declared SQL foreign key, so the FK-trust capability gate
 * deliberately does not apply here.
 */
function computeExistenceAnchorInds(
	advertisement: MappingAdvertisement,
	basis: { schema: Schema; schemaName: string },
	db: Database,
): InclusionDependency[] {
	const storage = advertisement.storage;
	if (!storage) return [];

	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) return []; // validated at resolution; defensive
	const anchorTable = resolveBasisRelation(db, anchor, basis);
	if (!anchorTable) return []; // validated at resolution; defensive
	const anchorKeyIdx = mapKeyColumnsToIndices(
		storage.sharedKey.keyColumnsByRelation.get(anchor.relationId) ?? [],
		anchorTable,
	);
	// Empty anchor key (singleton / `primary key ()`): no witnessing tuple to thread.
	if (!anchorKeyIdx || anchorKeyIdx.length === 0) return [];

	let inds: InclusionDependency[] = [];
	for (const member of storage.members) {
		if (member.relationId === anchor.relationId) continue;
		if (member.presence !== 'mandatory') continue; // optional → outer-joined → no IND (over-claim guard)
		if (member.attributePivot) continue; // EAV pivot → projected as subquery, never inner-joined
		const memberTable = resolveBasisRelation(db, member, basis);
		if (!memberTable) continue; // validated at resolution; defensive
		const memberKeyIdx = mapKeyColumnsToIndices(
			storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [],
			memberTable,
		);
		if (!memberKeyIdx) continue;
		// Pair positionally up to the shorter list (matching the get-synthesis equi-join).
		const n = Math.min(memberKeyIdx.length, anchorKeyIdx.length);
		if (n === 0) continue; // member has no key tuple to witness inclusion
		// `anchor.key ⊆ member.key`, total: THIS = anchor (cols = anchor key indices),
		// target = the MEMBER (the totality direction `mandatory` guarantees and the
		// anchor-rooted inner join's no-row-loss obligation consumes). See doc above.
		inds = addInd(inds, {
			cols: anchorKeyIdx.slice(0, n),
			target: { kind: 'relation', relationId: member.relationId, targetCols: memberKeyIdx.slice(0, n) },
			nullRejecting: false,
		}, { cap: MAX_INDS_PER_NODE });
	}
	return inds;
}

/**
 * Maps shared-key column names to their indices on `table`, preserving order.
 * Returns undefined if any column is missing — the advertisement validator
 * already guarantees existence, so this is a defensive guard.
 */
function mapKeyColumnsToIndices(keys: readonly string[], table: TableSchema): number[] | undefined {
	const idx: number[] = [];
	for (const k of keys) {
		const i = table.columnIndexMap.get(k.toLowerCase());
		if (i === undefined) return undefined;
		idx.push(i);
	}
	return idx;
}

/** A FROM `table` source for one decomposition member, aliased by its relationId. */
function memberTableSource(table: TableSchema, basisSchemaName: string, alias: string): AST.TableSource {
	return {
		type: 'table',
		table: { type: 'identifier', name: table.name, schema: table.schemaName || basisSchemaName },
		alias,
	};
}

/**
 * Builds the per-member key-equi-join ON condition: a positional conjunction of
 * `member.kᵢ = anchor.kᵢ` over the two relations' shared-key column lists (paired
 * by index, since a surrogate may be spelled differently per relation). An empty
 * key column list (the `primary key ()` singleton) yields the vacuously-true
 * `1 = 1` — no singleton-specific branch (docs/lens.md § The Default Mapper).
 */
function buildKeyEquiJoin(
	anchorAlias: string,
	anchorKeys: readonly string[],
	memberAlias: string,
	memberKeys: readonly string[],
): AST.Expression {
	const n = Math.min(anchorKeys.length, memberKeys.length);
	const eqs: AST.Expression[] = [];
	for (let i = 0; i < n; i++) {
		eqs.push({
			type: 'binary',
			operator: '=',
			left: { type: 'column', name: memberKeys[i], table: memberAlias } as AST.ColumnExpr,
			right: { type: 'column', name: anchorKeys[i], table: anchorAlias } as AST.ColumnExpr,
		} as AST.BinaryExpr);
	}
	if (eqs.length === 0) {
		// Singleton / empty key: vacuously true (`on 1 = 1`).
		return {
			type: 'binary',
			operator: '=',
			left: { type: 'literal', value: 1 } as AST.LiteralExpr,
			right: { type: 'literal', value: 1 } as AST.LiteralExpr,
		} as AST.BinaryExpr;
	}
	return eqs.reduce((acc, e) => ({ type: 'binary', operator: 'AND', left: acc, right: e }) as AST.BinaryExpr);
}

/** How {@link resolveAdvertisedColumn} resolved one logical column. */
type AdvertisedColumnResolution =
	/** Resolved to a backing expression (member mapping or EAV subquery). */
	| { kind: 'expr'; expr: AST.Expression }
	/** The backing member exists but is not reachable from the caller's FROM. */
	| { kind: 'unreachable'; member: string }
	/** The advertisement does not back the column → caller falls back to name-match. */
	| { kind: 'none' };

/**
 * Resolves one logical column to its advertised backing expression, re-qualified
 * to the caller-supplied alias for the backing member. Shared by the pure
 * decomposition body (`compileDecompositionBody`) and the override gap-fill path
 * (`compileOverrideBody`), so both honor the same precedence:
 *
 * 1. **Explicit per-member mapping** wins → the mapped `basisExpr`, re-qualified
 *    to the member's alias. When the member is not reachable from the caller's
 *    FROM (`aliasOf` returns undefined), reports `unreachable`.
 * 2. **EAV attribute pivot** (exactly one pivot member + an entity correlation
 *    key) → a correlated scalar subquery keyed by the attribute literal.
 * 3. Otherwise `none` — the caller falls back to its own name-match path.
 *
 * Matches `annotateProvenanceWithAdvertisement`'s attribution order (explicit
 * mapping, then the sole EAV member), so the synthesized projection and the
 * `quereus_effective_lens` provenance stay consistent.
 */
function resolveAdvertisedColumn(
	logicalColumn: string,
	storage: StorageShape,
	basisSchemaName: string,
	aliasOf: (relationId: string) => string | undefined,
	eavAnchor: { alias: string; keyColumn: string } | undefined,
): AdvertisedColumnResolution {
	const lc = logicalColumn.toLowerCase();

	// 1. Explicit per-member mapping.
	for (const member of storage.members) {
		const mapping = member.columns.find(m => m.logicalColumn.toLowerCase() === lc);
		if (!mapping) continue;
		const alias = aliasOf(member.relationId);
		if (!alias) return { kind: 'unreachable', member: member.relationId };
		return { kind: 'expr', expr: requalifyColumnRefs(mapping.basisExpr, alias) };
	}

	// 2. EAV attribute pivot — a correlated scalar subquery keyed by the attribute
	//    literal (only with exactly one pivot member + an entity correlation key).
	const eavMembers = storage.members.filter(m => m.attributePivot);
	if (eavMembers.length === 1 && eavAnchor) {
		return { kind: 'expr', expr: buildEavSubquery(eavMembers[0], logicalColumn, basisSchemaName, eavAnchor) };
	}

	// 3. Not advertised → caller falls back to name-match.
	return { kind: 'none' };
}

/**
 * Builds the correlated scalar subquery for one EAV-backed logical column:
 * `(select p.<value> from <pivot> p where p.<entity> = anchor.<key> and
 *   p.<attribute> = '<logicalColumn>')`. Keeps every EAV column independently
 * nullable (a logical row may have a triple for some attributes and not others)
 * and rides the existing scalar-subquery read path with no new runtime.
 */
function buildEavSubquery(
	pivot: DecompositionMember,
	logicalColumn: string,
	basisSchemaName: string,
	eavAnchor: { alias: string; keyColumn: string },
): AST.SubqueryExpr {
	const piv = pivot.attributePivot!;
	const pivotAlias = pivot.relationId;
	const pivotSchema = pivot.relation.schema || basisSchemaName;
	const query: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: piv.valueColumn, table: pivotAlias } as AST.ColumnExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: pivot.relation.table, schema: pivotSchema },
			alias: pivotAlias,
		}],
		where: {
			type: 'binary',
			operator: 'AND',
			left: {
				type: 'binary',
				operator: '=',
				left: { type: 'column', name: piv.entityColumn, table: pivotAlias } as AST.ColumnExpr,
				right: { type: 'column', name: eavAnchor.keyColumn, table: eavAnchor.alias } as AST.ColumnExpr,
			} as AST.BinaryExpr,
			right: {
				type: 'binary',
				operator: '=',
				left: { type: 'column', name: piv.attributeColumn, table: pivotAlias } as AST.ColumnExpr,
				right: { type: 'literal', value: logicalColumn } as AST.LiteralExpr,
			} as AST.BinaryExpr,
		} as AST.BinaryExpr,
	};
	return { type: 'subquery', query } as AST.SubqueryExpr;
}

/**
 * Deep-clones a member's `basisExpr` and re-qualifies every `column` reference in
 * it to `alias` (the member's alias in the synthesized FROM). The stored mapping
 * references the member's own columns, possibly bare or self-qualified; this
 * rewrites them all to the alias so the projection is unambiguous over the join.
 * Reuses the reflective walk shape of `collectColumnRefNames`, rewriting rather
 * than collecting.
 */
function requalifyColumnRefs(expr: AST.Expression, alias: string): AST.Expression {
	const rewrite = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(rewrite);
		if (node && typeof node === 'object' && 'type' in (node as object)) {
			const src = node as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(src)) out[key] = rewrite(src[key]);
			if (src.type === 'column') {
				out.table = alias;
				out.schema = undefined;
			}
			return out;
		}
		return node;
	};
	return rewrite(expr) as AST.Expression;
}

/**
 * Resolves a name-match logical column against the decomposition's join members
 * (anchor first, then advertisement order): the first member whose basis table
 * carries a same-named column, qualified by that member's alias. Returns
 * undefined when no join member has the column (the caller errors precisely).
 */
function nameMatchAgainstMembers(
	logicalColumn: string,
	storage: StorageShape,
	memberTables: ReadonlyMap<string, TableSchema>,
	joinedMembers: ReadonlySet<string>,
	anchorRelationId: string,
): AST.ColumnExpr | undefined {
	const lc = logicalColumn.toLowerCase();
	const order = [anchorRelationId, ...storage.members.map(m => m.relationId).filter(id => id !== anchorRelationId)];
	for (const relationId of order) {
		if (!joinedMembers.has(relationId)) continue;
		const table = memberTables.get(relationId);
		const idx = table?.columnIndexMap.get(lc);
		if (idx !== undefined) {
			return { type: 'column', name: table!.columns[idx].name, table: relationId };
		}
	}
	return undefined;
}

/**
 * Indexes a lens block's overrides by lowercased logical-table name, validating
 * that each names a logical table the declaration actually carries. The check
 * is skipped for an empty declaration (a pure detach-everything re-apply, which
 * never aligns a basis).
 */
function indexOverrides(
	lensDecl: AST.DeclareLensStmt | undefined,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): Map<string, AST.LensOverride> {
	const byTable = new Map<string, AST.LensOverride>();
	if (!lensDecl) return byTable;

	const declaredTableNames = new Set<string>();
	for (const item of declaredSchema.items) {
		if (item.type === 'declaredTable') declaredTableNames.add(item.tableStmt.table.name.toLowerCase());
	}
	for (const ov of lensDecl.overrides) {
		const key = ov.table.toLowerCase();
		if (declaredTableNames.size > 0 && !declaredTableNames.has(key)) {
			throw new QuereusError(
				`lens: override 'view ${ov.table} as ...' references logical table '${logicalSchemaName}.${ov.table}', which is not declared in logical schema '${logicalSchemaName}'`,
				StatusCode.ERROR,
			);
		}
		byTable.set(key, ov);
	}
	return byTable;
}

/** A basis table referenced by an override's FROM clause, with its ref name. */
interface OverrideSource {
	/** The resolved basis table schema. */
	table: TableSchema;
	/** Alias if the FROM gave one, else the table name — used to qualify refs. */
	refName: string;
}

/**
 * Composes one effective **read** body for a logical table that has a
 * `declare lens` override, per docs/lens.md § D2:
 *
 *   covered columns (override projection) ⊕ default-mapper gap-fill.
 *
 * Coverage is read **by name** from the override's output column names (alias or
 * bare name, and `*`-expansion of FROM-source columns). Each uncovered logical
 * column is gap-filled from a same-named basis column of the override's FROM.
 * When a gap is not reachable from the FROM (basis lacks the column, or a partial
 * cross-basis join), the compile errors rather than emit an unsound body — every
 * logical column must map to basis. The composition is recomputed on every deploy.
 */
function compileOverrideBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	override: AST.LensOverride,
	advertisement?: MappingAdvertisement,
): { body: AST.SelectStmt; provenance: LensColumnProvenance[]; effectiveColumns: string[] } {
	const select = override.select;
	const logicalName = logicalTable.name;

	// Names a CTE declares anywhere in the body shadow same-named basis relations:
	// they are neither collectable as basis sources (their columns are the CTE's,
	// not the basis table's, so `*` expansion and gap-fill must not use them) nor
	// qualifiable with the basis schema.
	const cteNames = collectCteNames(select);

	// Every FROM source the override names must live in the declared basis — an
	// override referencing a *different* existing schema (e.g. `Z.Foo` while the
	// lens is `over Y`) would silently re-anchor the body to Z (docs/lens.md § D4).
	validateOverrideBasisSources(select, basisSchemaName, schemaManager, cteNames, logicalSchemaName, logicalName);

	// Resolve FROM-source basis tables once — used for both `*` expansion and
	// gap-fill. Opaque sources (subquery / function / CTE / basis view — anything
	// exposing no column list) are tracked so a gap that needs one errors precisely.
	const { sources, hasOpaqueSource } = collectOverrideSources(select.from, basisSchemaName, schemaManager, cteNames);
	const qualify = sources.length > 1;

	// Advertisement-driven gap-fill needs to map an advertised member relationId to
	// its reference name (alias / table name) in the override's FROM. A member the
	// override's FROM does not include resolves to undefined (gap-fill then falls
	// back to name-match, or errors precisely).
	const overrideSourceByRel = new Map<string, string>();
	for (const s of sources) {
		overrideSourceByRel.set(`${s.table.schemaName.toLowerCase()}.${s.table.name.toLowerCase()}`, s.refName);
	}
	const overrideAliasOf = (relationId: string): string | undefined => {
		const member = advertisement?.storage?.members.find(m => m.relationId === relationId);
		if (!member) return undefined;
		const key = `${(member.relation.schema || basisSchemaName).toLowerCase()}.${member.relation.table.toLowerCase()}`;
		return overrideSourceByRel.get(key);
	};

	// Coverage map: lowercased output-column name -> the expression producing it,
	// plus the override column's `with inverse` clause when authored — carried per
	// covered column into the composed body so the write path consumes it there
	// (docs/vu-inverses.md § Authored inverses; a gap-filled column never
	// has one).
	const coverage = new Map<string, { expr: AST.Expression; inverse?: ReadonlyArray<AST.ResultColumnInverse> }>();
	let hasStar = false;
	let starTable: string | undefined;
	for (const col of select.columns) {
		if (col.type === 'all') {
			hasStar = true;
			if (col.table) starTable = col.table.toLowerCase();
			continue;
		}
		const outName = deriveColumnOutputName(col);
		if (!outName) {
			// A computed (non-column) projection term without an alias maps to no
			// logical column — it would be silently dropped, then the same-named
			// logical column gap-filled from the basis (a wrong, surprising read).
			throw new QuereusError(
				`lens: override for logical table '${logicalSchemaName}.${logicalName}' has a computed projection term '${astToString(col.expr)}' with no output name; add an alias (... as <name>) so it maps to a logical column`,
				StatusCode.ERROR,
			);
		}
		coverage.set(outName.toLowerCase(), { expr: col.expr, inverse: col.inverse });
	}

	// `*` covers every FROM-source column not already explicitly covered.
	if (hasStar) {
		for (const src of sources) {
			if (starTable && src.refName.toLowerCase() !== starTable) continue;
			for (const c of src.table.columns) {
				const key = c.name.toLowerCase();
				if (!coverage.has(key)) coverage.set(key, { expr: columnRef(c.name, qualify ? src.refName : undefined) });
			}
		}
	}

	const composed: AST.ResultColumn[] = [];
	const provenance: LensColumnProvenance[] = [];
	const effectiveColumns: string[] = [];
	for (const col of logicalTable.columns) {
		const key = col.name.toLowerCase();
		const covered = coverage.get(key);
		if (covered !== undefined) {
			composed.push({ type: 'column', expr: covered.expr, alias: col.name, inverse: covered.inverse });
			provenance.push({ logicalColumn: col.name, source: 'override' });
		} else {
			// Advertisement-driven gap-fill (richer than name-match): resolve the
			// uncovered column against the advertised member mapping, re-qualified to
			// its alias in the override's FROM. Fall back to today's FROM name-match
			// when the advertisement does not back it; error precisely when the
			// advertisement backs it from a member the FROM omits and name-match
			// cannot reach it either (the same fidelity-boundary discipline as gapFillError).
			let resolved: AST.Expression | undefined;
			let unreachableMember: string | undefined;
			if (advertisement?.storage) {
				const res = resolveAdvertisedColumn(col.name, advertisement.storage, basisSchemaName, overrideAliasOf, undefined);
				if (res.kind === 'expr') {
					resolved = res.expr;
				} else if (res.kind === 'unreachable') {
					unreachableMember = res.member;
				}
			}
			if (!resolved) {
				const ref = gapFillRef(col.name, sources, qualify);
				if (ref) {
					resolved = ref;
				} else if (unreachableMember) {
					throw new QuereusError(
						`lens: override for logical table '${logicalSchemaName}.${logicalName}' leaves column '${col.name}' to advertisement gap-fill, but its backing member '${unreachableMember}' is absent from the override's FROM; cover it explicitly or include the member relation in the FROM`,
						StatusCode.ERROR,
					);
				} else {
					throw new QuereusError(
						gapFillError(logicalSchemaName, logicalName, col.name, sources, hasOpaqueSource),
						StatusCode.ERROR,
					);
				}
			}
			composed.push({ type: 'column', expr: resolved, alias: col.name });
			provenance.push({ logicalColumn: col.name, source: 'default' });
		}
		effectiveColumns.push(col.name);
	}

	// Preserve every non-projection clause of the override (where/group/having/
	// order/limit/distinct/with — the filter shape, etc.); replace only the
	// projection with the composed logical-column list, then pin each bare basis
	// source to the basis schema so the stored body resolves the same way for
	// every consumer (read / prover / explain), not just for this compiler.
	const body = qualifyBasisSources(
		{ ...select, columns: composed }, basisSchemaName, schemaManager, cteNames,
	);
	return { body, provenance, effectiveColumns };
}

/**
 * Reflectively visits every plain-object node reachable from `root`, in no
 * particular order. Descent is *not* gated on a `type` discriminant: some
 * containers that hold nested SELECTs are plain wrappers without one — notably
 * `compound` (`{ op, select }`) and `orderBy` clauses — so a type-gated walk
 * would skip everything nested under them. Arrays are transparent (their
 * elements are visited, the array itself is not).
 *
 * Anything with a non-plain prototype (`Uint8Array`, a Promise
 * {@link AST.LiteralExpr} value, any class instance) is a leaf and is neither
 * visited nor descended into — the same boundary {@link spineCloneAst} draws.
 */
function forEachAstNode(root: unknown, visit: (node: Record<string, unknown>) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== 'object') continue;
		if (!Array.isArray(node)) {
			const proto = Object.getPrototypeOf(node);
			if (proto !== Object.prototype && proto !== null) continue;
			visit(node as Record<string, unknown>);
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value && typeof value === 'object') stack.push(value);
		}
	}
}

/**
 * Every CTE name declared anywhere in an override body, lowercased — the set of
 * bare FROM names that must NOT be read as basis tables (a CTE shadows a
 * same-named basis relation, per SQL scoping).
 *
 * NOTE: this is one flat set over the whole body, not per-scope frames as
 * `schema/rename-rewriter.ts` maintains. A name declared as a CTE in *any*
 * nested scope therefore disables basis-qualification and basis-source
 * collection for that name in *all* scopes, including scopes where it really is
 * the basis table. That direction is safe — such a reference keeps today's
 * behavior (unqualified, hence unresolved at read time, hence a loud error)
 * rather than risking a silently wrong bind. If a real body ever needs the same
 * name to mean a CTE in one scope and the basis table in another, replace this
 * with the per-scope frames `rename-rewriter.ts` already models.
 */
function collectCteNames(select: AST.SelectStmt): Set<string> {
	const names = new Set<string>();
	forEachAstNode(select, node => {
		if (node.type === 'commonTableExpr') names.add((node as unknown as AST.CommonTableExpr).name.toLowerCase());
	});
	return names;
}

/**
 * Rewrites every bare FROM `table` reference that resolves in the declared basis
 * so it carries the basis schema qualifier explicitly.
 *
 * The compiler resolves an unqualified override source against the basis
 * (docs/lens.md § Body-shape restrictions), but the *stored* body used to keep
 * the authored FROM verbatim — so nothing recorded which schema the bare name
 * meant, and each downstream consumer re-resolved it its own way: the read path
 * plans the body under the **logical** schema's home path, while the prover and
 * `explain` round-trip it through SQL text with no path context at all. None of
 * those knows the basis, so an unqualified source either failed to resolve or
 * (with a same-named `main` table in the way) silently bound the wrong relation.
 * Qualifying here makes the stored body self-describing, so every consumer
 * agrees by construction — and matches `compileDefaultBody` /
 * `compileDecompositionBody`, which already emit fully-qualified references.
 *
 * A bare name is left exactly as authored when a CTE shadows it (see
 * {@link collectCteNames}); one the basis does not have never reaches this pass,
 * having already been rejected by {@link validateOverrideBasisSources}.
 *
 * The input AST is never mutated: `select` here is the authored
 * `override.select`, which is also stored as the slot's override *and* lives in
 * the declared-lens AST held by the catalog, so an in-place edit would rewrite
 * the user's own declaration (and perturb DDL round-trip / declarative
 * equivalence). A rewrite therefore works on a spine clone; when there is
 * nothing to rewrite the input is returned untouched.
 */
function qualifyBasisSources(
	select: AST.SelectStmt,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	cteNames: ReadonlySet<string>,
): AST.SelectStmt {
	const basis = schemaManager.getSchema(basisSchemaName);
	if (!basis) return select;

	const needsQualifier = (node: Record<string, unknown>): boolean => {
		if (node.type !== 'table') return false;
		const src = node as unknown as AST.TableSource;
		if (src.table.schema !== undefined) return false;
		if (cteNames.has(src.table.name.toLowerCase())) return false;
		return basisHasRelation(basis, src.table.name);
	};

	let found = false;
	forEachAstNode(select, node => { if (needsQualifier(node)) found = true; });
	// NOTE: this early return leaves the compiled body sharing FROM/where subtrees
	// with the authored declaration AST (as it always did), while the rewrite path
	// below hands back a fully detached clone — so body↔declaration aliasing is
	// asymmetric. Harmless while nothing mutates a compiled body in place; if an
	// in-place AST rewriter (`schema/rename-rewriter.ts`) is ever pointed at one,
	// clone unconditionally here instead of chasing the difference.
	if (!found) return select;

	const clone = spineCloneAst(select);
	forEachAstNode(clone, node => {
		if (needsQualifier(node)) (node as unknown as AST.TableSource).table.schema = basisSchemaName;
	});
	return clone;
}

/**
 * Resolves one FROM `table` node to its basis table, or undefined when it is not
 * an introspectable basis relation. A bare name a CTE declares is *not* a basis
 * table — resolving it as one would attribute the CTE's rows (and columns) to a
 * basis relation the body never reads. Narrower than {@link basisHasRelation}: a
 * basis *view* is a legal source but exposes no column list, so it resolves to
 * undefined here and the caller treats it as opaque.
 */
function resolveBasisTableSource(
	node: AST.TableSource,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	cteNames: ReadonlySet<string>,
): TableSchema | undefined {
	if (node.table.schema === undefined && cteNames.has(node.table.name.toLowerCase())) return undefined;
	const schemaName = node.table.schema ?? basisSchemaName;
	return schemaManager.getSchema(schemaName)?.getTable(node.table.name);
}

/** Walks an override's FROM tree, collecting introspectable basis-table sources. */
function collectOverrideSources(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	cteNames: ReadonlySet<string>,
): { sources: OverrideSource[]; hasOpaqueSource: boolean } {
	const sources: OverrideSource[] = [];
	let hasOpaqueSource = false;

	const walk = (node: AST.FromClause): void => {
		switch (node.type) {
			case 'table': {
				const tbl = resolveBasisTableSource(node, basisSchemaName, schemaManager, cteNames);
				if (!tbl) { hasOpaqueSource = true; return; }
				sources.push({ table: tbl, refName: node.alias ?? tbl.name });
				break;
			}
			case 'join': {
				walk(node.left);
				walk(node.right);
				break;
			}
			default:
				// subquerySource / functionSource — not introspectable in v1.
				hasOpaqueSource = true;
				break;
		}
	};

	if (from) for (const f of from) walk(f);
	return { sources, hasOpaqueSource };
}

/**
 * Validates that every `table` source reachable from an override's body resolves
 * to the declared basis schema — in both directions an override could escape it:
 *
 * 1. **Qualified with another schema** (`Z.Foo` while the lens is `over Y`) would
 *    bind there silently, re-anchoring the lens off its basis.
 * 2. **Bare and absent from the basis.** A bare name is the basis or a CTE and
 *    nothing else (docs/lens.md § Body-shape restrictions). One that is neither
 *    has no basis qualifier to pin ({@link qualifyBasisSources} leaves it alone),
 *    so it falls through to the *default* schema path at read time — binding a
 *    same-named `main` relation, which is the same silent re-anchor as (1) minus
 *    the qualifier that would have made it visible. Rejecting it here reports the
 *    escape at deploy, naming the relation, instead of at read (or not at all).
 *
 * A basis *view* counts as a basis relation for this check and for qualification,
 * though not as an introspectable source: `*` expansion and gap-fill still treat
 * it as opaque (see {@link resolveBasisTableSource}).
 *
 * The walk ({@link forEachAstNode}) is reflective over the entire override
 * `select` AST, so it descends into subquery-source FROM trees, function-source
 * argument subqueries, `with` CTE bodies, compound (`union`/`intersect`/…) legs,
 * and scalar/`where`/`in`/`exists` subqueries — an escaping source in any of
 * those nested positions is flagged too, not only top-level `table`/`join`
 * sources. Function (TVF) sources are not `table` nodes and resolve through the
 * function registry rather than the schema path, so they are out of scope here.
 *
 * Runs on the **authored** select, before {@link qualifyBasisSources} rewrites
 * bare basis names — the qualifier that pass adds is the basis one, so ordering
 * does not change the verdict either way.
 */
function validateOverrideBasisSources(
	select: AST.SelectStmt,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	cteNames: ReadonlySet<string>,
	logicalSchemaName: string,
	logicalName: string,
): void {
	const lowerBasis = basisSchemaName.toLowerCase();
	const basis = schemaManager.getSchema(basisSchemaName);
	const fail = (message: string): never => {
		throw new QuereusError(
			`lens: override for logical table '${logicalSchemaName}.${logicalName}' ${message} (the lens is declared 'over ${basisSchemaName}'); an override's FROM may only reference the declared basis`,
			StatusCode.ERROR,
		);
	};

	forEachAstNode(select, node => {
		if (node.type !== 'table') return;
		const { table } = node as unknown as AST.TableSource;
		if (table.schema !== undefined) {
			if (table.schema.toLowerCase() !== lowerBasis) {
				fail(`references basis relation '${table.schema}.${table.name}' outside the declared basis '${basisSchemaName}'`);
			}
			return;
		}
		if (cteNames.has(table.name.toLowerCase())) return;
		if (basis && !basisHasRelation(basis, table.name)) {
			fail(`references relation '${table.name}', which the declared basis '${basisSchemaName}' does not have — an unqualified FROM source names a basis table or view, or a CTE of the same body`);
		}
	});
}

/**
 * Whether the basis schema holds a relation of this name. Broader than
 * {@link resolveBasisTableSource}: a *view* is a legitimate basis source to
 * reference (and to qualify) even though it exposes no {@link TableSchema} for
 * `*` expansion / gap-fill to read columns from.
 */
function basisHasRelation(basis: Schema, name: string): boolean {
	return basis.getTable(name) !== undefined || basis.getView(name) !== undefined;
}

/** Output name a result column contributes: its alias, or the bare column name. */
function deriveColumnOutputName(col: AST.ResultColumnExpr): string | undefined {
	if (col.alias) return col.alias;
	return col.expr.type === 'column' ? col.expr.name : undefined;
}

/** Builds a column reference, optionally qualified by a source ref name. */
function columnRef(name: string, refName: string | undefined): AST.ColumnExpr {
	return refName ? { type: 'column', name, table: refName } : { type: 'column', name };
}

/** Finds a same-named basis column across the override's FROM sources. */
function gapFillRef(colName: string, sources: ReadonlyArray<OverrideSource>, qualify: boolean): AST.ColumnExpr | undefined {
	const lower = colName.toLowerCase();
	for (const src of sources) {
		const idx = src.table.columnIndexMap.get(lower);
		if (idx !== undefined) {
			// Reference the basis column by its actual name (casing); the logical
			// alias is applied by the caller.
			return columnRef(src.table.columns[idx].name, qualify ? src.refName : undefined);
		}
	}
	return undefined;
}

/** Diagnostic for an uncovered logical column the FROM can't gap-fill. */
function gapFillError(
	logicalSchemaName: string,
	logicalName: string,
	colName: string,
	sources: ReadonlyArray<OverrideSource>,
	hasOpaqueSource: boolean,
): string {
	const sourceDesc = sources.length === 0
		? 'the override FROM exposes no introspectable basis table'
		: `basis source(s) ${sources.map(s => s.table.name).join(', ')} have no column '${colName}'`;
	if (sources.length > 1 || hasOpaqueSource) {
		// Cross-basis / partial-coverage fidelity boundary (docs/lens.md § D2).
		return `lens: override for logical table '${logicalSchemaName}.${logicalName}' covers only some columns; uncovered column '${colName}' is not reachable from the override's FROM (${sourceDesc}) — it would need a basis source the single-source mapper cannot join in. Cover it explicitly.`;
	}
	// Every logical column must map to basis (docs/lens.md § Gap-fill fidelity boundary).
	return `lens: override for logical table '${logicalSchemaName}.${logicalName}' leaves column '${colName}' uncovered and ${sourceDesc} to gap-fill it from — cover it explicitly in the override projection (every logical column must map to basis).`;
}

// ===========================================================================
// Module mapping advertisement resolution (docs/lens.md § The Default Mapper)
// ===========================================================================
//
// The protocol seam: a virtual-table module advertises how a set of its basis
// relations decomposes a logical table (columnar split / EAV / column-family /
// nd-tree). This compiler **resolves** (collects + selects the single primary +
// validates) and **stores** the advertisement on the lens slot; it does NOT
// synthesize the n-way body — that is `lens-multi-source-decomposition`, which
// reads `slot.advertisement`. Validation aborts the deploy atomically (before
// any catalog mutation), aggregating every problem with a named site, matching
// the contract `validateLensTags` already follows.

/**
 * Collects the mapping advertisements every module owning ≥1 table in `basis`
 * recognizes, deduplicated by the advertisement `id`. A generic module
 * (memory/store) returns tag-derived advertisements; a generic module that scans
 * the whole schema may be hit once per distinct module instance, so the same
 * tag-derived advertisement can appear twice — the `id` dedup collapses those.
 */
function collectAdvertisements(db: Database, basis: Schema): MappingAdvertisement[] {
	const modules = new Set<AnyVirtualTableModule>();
	for (const table of basis.getAllTables()) {
		if (table.vtabModule) modules.add(table.vtabModule);
	}
	const byId = new Map<string, MappingAdvertisement>();
	for (const module of modules) {
		const ads = module.getMappingAdvertisements?.(db, basis) ?? [];
		for (const ad of ads) {
			if (!byId.has(ad.id)) byId.set(ad.id, ad);
		}
	}
	return Array.from(byId.values());
}

/**
 * Resolves the advertisements for one logical table: filters to the table,
 * selects the single `primary-storage` (accommodation #5 — two is an error),
 * keeps the rest as `auxiliary-access`, and validates the primary's structural
 * coherence. Returns the resolved slot fields; throws (aggregated) on any
 * validation failure so the deploy aborts before catalog mutation.
 *
 * `hasOverride` relaxes the per-column coverage check: when an override exists
 * its own coverage validation (`compileOverrideBody`) owns the column-coverage
 * verdict, so the advertisement is only checked for internal coherence.
 */
function resolveAdvertisement(
	all: ReadonlyArray<MappingAdvertisement>,
	logicalTable: TableSchema,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	logicalSchemaName: string,
	hasOverride: boolean,
): { advertisement?: MappingAdvertisement; auxiliaryAccess?: ReadonlyArray<MappingAdvertisement> } {
	const lower = logicalTable.name.toLowerCase();
	const matching = all.filter(a => a.logicalTable.toLowerCase() === lower);
	if (matching.length === 0) return {};

	const primaries = matching.filter(a => a.role === 'primary-storage');
	const auxiliaries = matching.filter(a => a.role === 'auxiliary-access');

	const errors: string[] = [];
	if (primaries.length > 1) {
		errors.push(
			`has ${primaries.length} primary-storage advertisements (${primaries.map(p => `'${p.id}'`).join(', ')}); at most one is allowed`,
		);
	}
	const advertisement = primaries[0];
	if (advertisement) {
		validatePrimaryAdvertisement(advertisement, logicalTable, basis, db, hasOverride, errors);
	}
	for (const aux of auxiliaries) {
		validateAuxiliaryAdvertisement(aux, basis, db, errors);
	}

	if (errors.length > 0) {
		throw new QuereusError(
			`lens: advertisement for logical table '${logicalSchemaName}.${logicalTable.name}' is invalid: ${errors.join('; ')}`,
			StatusCode.ERROR,
		);
	}

	return {
		advertisement,
		auxiliaryAccess: auxiliaries.length > 0 ? auxiliaries : undefined,
	};
}

/**
 * Validates a `primary-storage` advertisement's structural coherence. Each check
 * pushes a sited message to `errors` (aggregated by the caller); none mutate the
 * catalog. See `docs/lens.md` § The Default Mapper for the field semantics.
 */
function validatePrimaryAdvertisement(
	ad: MappingAdvertisement,
	logicalTable: TableSchema,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	hasOverride: boolean,
	errors: string[],
): void {
	const storage = ad.storage;
	if (!storage) {
		errors.push(`role 'primary-storage' requires a storage shape`);
		return;
	}
	// The IND existence-anchor contract: id == anchorRelationId (so the INDs the
	// synthesis ticket injects, with IndTarget.kind:'relation'.relationId, and the
	// join it builds agree on the anchor).
	if (ad.id !== storage.anchorRelationId) {
		errors.push(`advertisement id '${ad.id}' must equal storage.anchorRelationId '${storage.anchorRelationId}'`);
	}

	const memberByRelationId = new Map<string, DecompositionMember>();
	for (const member of storage.members) memberByRelationId.set(member.relationId, member);

	if (!memberByRelationId.has(storage.anchorRelationId)) {
		errors.push(`anchor '${storage.anchorRelationId}' is not among the members (${storage.members.map(m => `'${m.relationId}'`).join(', ') || 'none'})`);
	}

	// Resolve each member's basis table; validate column / pivot existence.
	const memberTables = new Map<string, TableSchema>();
	for (const member of storage.members) {
		const table = resolveBasisRelation(db, member, basis);
		if (!table) {
			errors.push(`member '${member.relationId}' references basis relation '${member.relation.schema}.${member.relation.table}', which does not exist`);
			continue;
		}
		memberTables.set(member.relationId, table);

		for (const mapping of member.columns) {
			for (const refName of collectColumnRefNames(mapping.basisExpr)) {
				if (!table.columnIndexMap.has(refName.toLowerCase())) {
					errors.push(`member '${member.relationId}' maps logical column '${mapping.logicalColumn}' to basis expression referencing column '${refName}', which does not exist on '${table.name}'`);
				}
			}
		}
		if (member.attributePivot) {
			for (const [role, col] of [
				['entity', member.attributePivot.entityColumn],
				['attribute', member.attributePivot.attributeColumn],
				['value', member.attributePivot.valueColumn],
			] as const) {
				if (!table.columnIndexMap.has(col.toLowerCase())) {
					errors.push(`member '${member.relationId}' attributePivot ${role} column '${col}' does not exist on '${table.name}'`);
				}
			}
		}
	}

	// Shared key: surrogate ⇒ the anchor's shared-key column declares a DEFAULT (the
	// engine evaluates it once per row and threads it via the EC — it chooses no ID
	// policy of its own); logical-tuple ⇒ the supplied logical PK, with each member's
	// key columns matching the logical PK arity.
	const sharedKey = storage.sharedKey;
	if (sharedKey.kind === 'surrogate') {
		// The surrogate's value must come from the anchor key column's declared
		// `default` (replacing the retired engine-invented `integer-auto` mint): an
		// INSERT evaluates it once per row, and the EC threads the captured value to
		// every member. A single-column anchor key whose column has no default is a
		// deploy-time error — there is nowhere for the surrogate to come from.
		const anchorKeys = sharedKey.keyColumnsByRelation.get(storage.anchorRelationId) ?? [];
		const anchorTable = memberTables.get(storage.anchorRelationId);
		if (anchorTable && anchorKeys.length === 1) {
			const keyCol = anchorTable.columns.find(c => c.name.toLowerCase() === anchorKeys[0].toLowerCase());
			if (keyCol && keyCol.defaultValue === null) {
				errors.push(`shared key is 'surrogate' but anchor '${storage.anchorRelationId}' key column '${anchorKeys[0]}' declares no DEFAULT; a surrogate's value comes from that column's default (e.g. \`default (coalesce((select max(${anchorKeys[0]}) from ${anchorTable.name}), 0) + mutation_ordinal())\`) — the engine no longer auto-generates one`);
			}
		}
		// A surrogate is not tied to the logical PK arity, but the equi-join pairs
		// each member's key columns positionally with the anchor's, so they must all
		// share one arity. Validate it here: an under-arity member would otherwise
		// silently under-join (`buildKeyEquiJoin` pairs by `Math.min`) rather than
		// error, multiplying rows instead of stitching them.
		const anchorArity = sharedKey.keyColumnsByRelation.get(storage.anchorRelationId)?.length;
		if (anchorArity !== undefined) {
			for (const member of storage.members) {
				const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId);
				if (keyCols && keyCols.length !== anchorArity) {
					errors.push(`shared key is 'surrogate' but member '${member.relationId}' has ${keyCols.length} key column(s), not the anchor '${storage.anchorRelationId}' surrogate arity (${anchorArity})`);
				}
			}
		}
	}
	if (sharedKey.kind === 'logical-tuple') {
		const pkArity = logicalTable.primaryKeyDefinition.length;
		for (const member of storage.members) {
			const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId);
			if (keyCols && keyCols.length !== pkArity) {
				errors.push(`shared key is 'logical-tuple' but member '${member.relationId}' has ${keyCols.length} key column(s), not the logical primary key's arity (${pkArity})`);
			}
		}
	}

	// keyColumnsByRelation covers every member and each named column exists.
	for (const member of storage.members) {
		const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId);
		if (keyCols === undefined) {
			errors.push(`shared key has no key columns for member '${member.relationId}'`);
			continue;
		}
		const table = memberTables.get(member.relationId);
		if (!table) continue; // already reported as a missing relation
		for (const col of keyCols) {
			if (!table.columnIndexMap.has(col.toLowerCase())) {
				errors.push(`shared key column '${col}' for member '${member.relationId}' does not exist on '${table.name}'`);
			}
		}
	}

	// Stitch-key / EAV-conflict-target uniqueness (docs/lens.md § The `put`
	// fan-out). The put fan-out cedes the matched rows to the matched
	// UPDATE only through the materialize INSERT's `on conflict (<target>) do nothing`,
	// which the runtime fires solely on a declared PK / UNIQUE violation; the get side
	// is sound only when that same target is 1:1 (a non-unique columnar stitch key
	// multiplies the equi-join, a non-unique `(entity, attr)` makes the EAV correlated
	// subquery multi-valued). So every member's materialize conflict target must equal a
	// declared PRIMARY KEY or non-partial UNIQUE on its basis table. Validated once here
	// at deploy — the only place that governs both directions of the lens — so the
	// plan-time materialize builders may rely on it without re-checking. The anchor is
	// validated too: its own stitch key must be unique for the logical-PK / surrogate
	// identity to be 1:1.
	for (const member of storage.members) {
		const table = memberTables.get(member.relationId);
		if (!table) continue; // missing relation already reported above
		if (member.attributePivot) {
			// EAV: the conflict target is `(entity, attribute)`, NOT the stitch key
			// (`entity` alone, which is deliberately one-to-many across attributes).
			const target = [member.attributePivot.entityColumn, member.attributePivot.attributeColumn];
			const idx = resolveColumnIndices(table, target);
			if (idx && !columnsFormDeclaredKey(table, idx)) {
				errors.push(`EAV pivot member '${member.relationId}' conflict target (${target.join(', ')}) is not a declared PRIMARY KEY or UNIQUE constraint on '${table.name}'; the get-side correlated subquery requires (entity, attribute) single-valued and the per-attribute materialize INSERT cedes matched triples via \`on conflict (${target.join(', ')}) do nothing\` — declare a PRIMARY KEY / UNIQUE on those columns`);
			}
			continue;
		}
		const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
		if (keyCols.length === 0) continue; // singleton (`primary key ()`) — no stitch, no materialize path
		const idx = resolveColumnIndices(table, keyCols);
		if (idx && !columnsFormDeclaredKey(table, idx)) {
			errors.push(`member '${member.relationId}' stitch key (${keyCols.join(', ')}) is not a declared PRIMARY KEY or UNIQUE constraint on basis relation '${table.name}'; the decomposition equi-join requires a 1:1 stitch and the optional-member materialize INSERT's \`on conflict (${keyCols.join(', ')}) do nothing\` only cedes matched rows against a declared unique — declare a PRIMARY KEY / UNIQUE on those columns`);
		}
	}

	// Column coverage (only when there is no override — an override's own coverage
	// validation owns the verdict otherwise). Every logical column must be backed
	// by exactly one member mapping, or by an EAV pivot member, or be coverable by
	// name-match against the basis. Otherwise the advertisement claims the table
	// but leaves the column unbacked and uncovered → error, naming the column.
	if (!hasOverride) {
		const backedBy = buildColumnBackingMap(storage);
		const hasEavMember = storage.members.some(m => m.attributePivot);
		const nameMatchTable = basis.schema.getTable(logicalTable.name);
		for (const col of logicalTable.columns) {
			const lc = col.name.toLowerCase();
			if (backedBy.get(lc) === 'ambiguous') {
				errors.push(`logical column '${col.name}' is backed by more than one member mapping (must be exactly one)`);
				continue;
			}
			if (backedBy.has(lc)) continue; // exactly one member maps it
			if (hasEavMember) continue;      // an EAV pivot member backs it generically
			if (nameMatchTable?.columnIndexMap.has(lc)) continue; // left to name-match
			errors.push(`logical column '${col.name}' is left unbacked by the advertisement and is not coverable by name-match (cover it with a member mapping, an EAV pivot, or a name-matching basis column)`);
		}
	}
}

/**
 * Minimal validation for an `auxiliary-access` advertisement: every member
 * relation must resolve. The advertised predicate forms are not validated here —
 * the read-path consumer (`rule-lens-auxiliary-access`, `lens-access-shape-path-selection`)
 * matches them at plan time through its recognizer registry and silently degrades
 * to scan for any form it cannot serve, so an unknown form is never an error.
 */
function validateAuxiliaryAdvertisement(
	ad: MappingAdvertisement,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	errors: string[],
): void {
	if (!ad.storage) return; // an auxiliary may carry access-only shape
	for (const member of ad.storage.members) {
		if (!resolveBasisRelation(db, member, basis)) {
			errors.push(`auxiliary advertisement '${ad.id}' member '${member.relationId}' references basis relation '${member.relation.schema}.${member.relation.table}', which does not exist`);
		}
	}
}

/**
 * Builds `logicalColumn(lower) -> member relationId | 'ambiguous'` from the
 * explicit per-member column mappings (EAV pivots are handled separately by the
 * caller). A column mapped by two members is `'ambiguous'`.
 */
function buildColumnBackingMap(storage: NonNullable<MappingAdvertisement['storage']>): Map<string, string | 'ambiguous'> {
	const backedBy = new Map<string, string | 'ambiguous'>();
	for (const member of storage.members) {
		for (const mapping of member.columns) {
			const lc = mapping.logicalColumn.toLowerCase();
			backedBy.set(lc, backedBy.has(lc) ? 'ambiguous' : member.relationId);
		}
	}
	return backedBy;
}

/**
 * Resolves a list of column names to their indices on `table` via `columnIndexMap`.
 * Returns `undefined` if any name is unresolved — the caller (key-column / pivot
 * existence loops) already reports an unresolved name, so the uniqueness check just
 * skips rather than double-reporting.
 */
function resolveColumnIndices(table: TableSchema, names: readonly string[]): number[] | undefined {
	const out: number[] = [];
	for (const n of names) {
		const i = table.columnIndexMap.get(n.toLowerCase());
		if (i === undefined) return undefined; // unresolved name already reported elsewhere
		out.push(i);
	}
	return out;
}

/** Resolves a member's {@link BasisRelationRef} to a concrete basis table. */
function resolveBasisRelation(
	db: Database,
	member: DecompositionMember,
	basis: { schema: Schema; schemaName: string },
): TableSchema | undefined {
	const schemaName = member.relation.schema || basis.schemaName;
	const schema = schemaName.toLowerCase() === basis.schemaName.toLowerCase()
		? basis.schema
		: db.schemaManager.getSchema(schemaName);
	return schema?.getTable(member.relation.table);
}

/**
 * Annotates each provenance entry with the member `relationId` that backs its
 * logical column, when the resolved advertisement maps it. Explicit mappings win;
 * a column with no explicit mapping is attributed to the sole EAV pivot member
 * when one exists. Surfaced by `quereus_effective_lens`.
 */
function annotateProvenanceWithAdvertisement(
	provenance: LensColumnProvenance[],
	ad: MappingAdvertisement,
): void {
	const storage = ad.storage;
	if (!storage) return;
	const backedBy = buildColumnBackingMap(storage);
	const eavMembers = storage.members.filter(m => m.attributePivot);
	const soleEav = eavMembers.length === 1 ? eavMembers[0].relationId : undefined;
	for (const p of provenance) {
		const explicit = backedBy.get(p.logicalColumn.toLowerCase());
		if (explicit && explicit !== 'ambiguous') {
			p.advertisedBy = explicit;
		} else if (soleEav) {
			p.advertisedBy = soleEav;
		}
	}
}

/**
 * Override ⊕ advertisement conflict (docs/lens.md § Override-vs-advertisement
 * composition): a *sparse* override (one that relies on gap-fill) may correct an
 * advertised column mapping, but must NOT re-anchor or reference basis relations
 * outside the advertised decomposition. Every introspectable basis-table source
 * in the override's FROM must be one of the advertisement's member relations;
 * otherwise the developer is silently re-anchoring and must instead author a full
 * hand-authored body (which bypasses the advertisement entirely). Opaque sources
 * (subquery / function) are not introspectable and do not trip the check.
 */
function validateOverrideAdvertisementConflict(
	ad: MappingAdvertisement,
	override: AST.LensOverride,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	logicalSchemaName: string,
	logicalName: string,
): void {
	const storage = ad.storage;
	if (!storage) return;
	const memberRelations = new Set(
		storage.members.map(m => `${(m.relation.schema || basisSchemaName).toLowerCase()}.${m.relation.table.toLowerCase()}`),
	);
	const { sources } = collectOverrideSources(
		override.select.from, basisSchemaName, schemaManager, collectCteNames(override.select),
	);
	for (const src of sources) {
		const key = `${src.table.schemaName.toLowerCase()}.${src.table.name.toLowerCase()}`;
		if (!memberRelations.has(key)) {
			throw new QuereusError(
				`lens: override for logical table '${logicalSchemaName}.${logicalName}' references basis relation '${src.table.schemaName}.${src.table.name}', which is not part of the advertised decomposition (anchor '${storage.anchorRelationId}', members: ${storage.members.map(m => `'${m.relation.table}'`).join(', ')}); a partial override may not re-anchor or change the shared key — cover every logical column explicitly to author a full body that bypasses the advertisement, or align the override's FROM with the decomposition`,
				StatusCode.ERROR,
			);
		}
	}
}

