import type { SqlValue } from '../common/types.js';

/**
 * Typed registry for the reserved `quereus.*` tag namespace.
 *
 * Free-form user tags (`display_name = '...'`, `audit = true`) are untouched —
 * only keys under the `quereus.` prefix are governed here. The namespace is a
 * precise mini-language designed across the docs:
 *
 * - `quereus.lens.ack.<code>[:<target>]`, `quereus.lens.access.<col>`
 *   — lens advisory acknowledgments / access-pattern hints (`docs/lens.md`
 *   § Acknowledging advisories).
 * - `quereus.id` / `quereus.previous_name`
 *   — declarative-differ rename hints (docs/schema-rename-detection.md).
 * - `quereus.sync.replicate`
 *   — per-table opt-in that records a maintained table / materialized view's
 *   maintenance writes in the sync change log (`docs/migration.md` § Synced vs.
 *   local derived tables). Engine-global spec, behaviorally store-only.
 *
 * No reserved tag carries *behavior* — view-mutation semantics moved to
 * first-class constructs (write routing to per-row presence/membership columns;
 * omitted-insert defaults to the body select's `with defaults (col = expr, …)`
 * clause, which retired the last `quereus.update.*` key, `default_for.<column>`).
 *
 * This module is the single shape/site validation entry point those keys flow
 * through. It is **additive and behavior-neutral**: it reads no reserved tag's
 * *semantics* (ack fingerprinting, escalation policy stay in their owning
 * tickets); it only proves that a `quereus.*` key is spelled correctly (matches
 * a {@link ReservedTagSpec}), sits where it is legal ({@link TagSite}), and
 * carries a well-shaped value ({@link TagValueSchema}) — surfacing a sited
 * {@link TagDiagnostic} otherwise.
 *
 * Downstream consumers (e.g. the lens prover's reserved-tag parser) read
 * through {@link getReservedTag} / {@link getReservedTagByTemplate} rather than
 * re-parsing the namespace at scattered sites.
 */

/** The reserved namespace prefix. Keys not starting with this are user tags. */
export const RESERVED_TAG_NAMESPACE = 'quereus.';

/**
 * The declaration / statement site a tag was found at. Validation is
 * site-sensitive: a key valid in one position can be illegal in another (e.g.
 * `quereus.lens.writable` is meaningful on a logical column, but not on a
 * logical-table site).
 */
export type TagSite =
	| 'view-ddl'            // CREATE VIEW / CREATE MATERIALIZED VIEW WITH TAGS (also a physical declared view in the differ)
	| 'dml-stmt'            // INSERT/UPDATE/DELETE ... WITH (...) statement-level tag
	| 'logical-table'       // tags on a declared logical TableSchema
	| 'logical-constraint'  // tags on a logical RowConstraint/Unique/ForeignKey schema
	// A logical column's WITH TAGS position. Distinct from `physical-column` (the
	// basis / declared-table differ column): `quereus.lens.writable` is meaningful
	// only on a logical column, so a dedicated site gives correct mis-site
	// rejection in both directions.
	| 'logical-column'      // tags on a declared logical ColumnSchema
	// `physical-table` covers BOTH the basis-table advertisement position
	// (quereus.lens.decomp.* read by buildAdvertisementsFromTags) AND the physical
	// declarative-schema table position (the differ validates a declared table's
	// tags here, e.g. the quereus.id / quereus.previous_name rename hints).
	| 'physical-table'      // tags on a physical (basis / declared) TableSchema
	| 'physical-column'     // tags on a physical declared column (differ)
	| 'physical-index'      // tags on a physical declared index (differ)
	| 'physical-constraint';// tags on a physical declared named constraint (differ)

/** Closed value set for `quereus.lens.decomp.role.<id>` (docs/lens.md § The Default Mapper). */
export const DECOMP_ROLE_VALUES = ['primary-storage', 'auxiliary-access'] as const;
/** Closed value set for `quereus.lens.decomp.presence.<id>`. */
export const DECOMP_PRESENCE_VALUES = ['mandatory', 'optional'] as const;
/** Closed value set for `quereus.lens.decomp.keykind.<id>`. */
export const DECOMP_KEYKIND_VALUES = ['surrogate', 'logical-tuple'] as const;

/**
 * The per-logical-column writable-intent signal (docs/lens.md § Computed and
 * Generated Columns). Exported so the lens prover keys off this single constant
 * rather than re-spelling the literal. `= true` declares the column must have a
 * faithful write path, turning an opaque / non-invertible body into a deploy
 * error (`lens.non-invertible`); `= false` / absent preserves the conservative
 * admit-as-read-only behaviour.
 */
export const LENS_WRITABLE_INTENT_TAG = 'quereus.lens.writable';

/**
 * The per-table sync-replication opt-in (docs/migration.md § Synced vs. local
 * derived tables). `= true` records this maintained table / materialized view's
 * maintenance writes in the sync change log — the store backing host queues a
 * module `DataChangeEvent` per realized `BackingRowChange`, so the sync layer
 * records column versions / HLC stamps / tombstones exactly as for an ordinary
 * table write. Default off (a privileged maintenance write emits no module data
 * events otherwise). Exported so the store host keys off this single constant
 * rather than re-spelling the literal; the host reads `=== true`.
 */
export const SYNC_REPLICATE_TAG = 'quereus.sync.replicate';

/**
 * The per-table basis-eviction override (docs/migration.md § 4 Contract). On a
 * basis table whose physical storage lingers after detach, this tag overrides the
 * global `SyncConfig.basisEviction` mode for that one table: `'never'` opts it out
 * of auto-reclamation, `'immediate'` reclaims on the first sweep after detach, and
 * a non-negative number is a custom retention horizon in milliseconds. The sync
 * layer captures the value into its lifecycle record at lens-deploy time (the tag
 * is gone once the table detaches). Sited like {@link SYNC_REPLICATE_TAG} (the two
 * authoring forms of a basis/migration table). Exported so the sync recorder keys
 * off this single constant rather than re-spelling the literal.
 */
export const SYNC_EVICT_TAG = 'quereus.sync.evict';

/**
 * The per-table engine-managed marker.
 * `= true` declares this physical table is a relation the ENGINE (or an
 * engine-driven module) synthesizes and owns — not a user-declared object a
 * declarative schema can address. {@link collectSchemaCatalog} skips an
 * engine-managed table entirely, so the declarative differ never sees it as an
 * orphan to drop (nor as a declared object to create) and `export_schema` omits
 * it; it stays fully resolvable via `getTable` / `getAllTables` for every other
 * path (compile, introspection, servicing).
 *
 * The motivating producer is Lamina's lens basis layer: each per-column cell
 * store is exposed as a real `(rowId, value)` basis relation registered into the
 * basis scope's `Schema` (so the lens compiler's `resolveBasisRelation` finds
 * it). Without this marker a bare in-place `apply schema <basis>` would diff those
 * member relations as orphan tables and emit a `DROP TABLE` for each. This is the
 * engine-managed-table sibling of `quereus.expose_implicit_index`'s
 * implicit-covering-index exclusion — both keep an engine-synthesized backing out
 * of the user-visible declarative diff. Boolean (consumers read `=== true`),
 * default absent (an ordinary differ-managed table). Exported so a producing
 * module (e.g. `lamina-quereus`) stamps off this single constant rather than
 * re-spelling the literal.
 */
export const ENGINE_MANAGED_TABLE_TAG = 'quereus.engine_managed';

/**
 * The shape a reserved tag's value must satisfy. Validation here is purely
 * structural — e.g. a `'string'` value must be TEXT; what the text *means* is
 * the consuming ticket's concern, not this registry's.
 */
export type TagValueSchema =
	| 'string'
	| 'boolean'                            // a SQL boolean (true/false); e.g. expose_implicit_index
	| 'csv-of-identifiers'                 // comma-separated identifier names (e.g. decomp shared-key columns)
	| { readonly enum: readonly string[] } // closed value set, e.g. a lens decomp role/presence/keykind
	| 'required-nonempty-rationale'        // non-empty TEXT; empty => warning
	| 'eviction-policy';                   // 'never' | 'immediate' | non-negative ms (number or numeric string)

/**
 * One entry in the reserved-tag spec table. `key` is either an exact key string
 * or a single-placeholder template (`{ template: 'quereus.lens.ack.<code>' }`),
 * whose placeholder captures the entire remainder after the literal prefix.
 */
export interface ReservedTagSpec {
	/** Either an exact key, or a template with one `<segment>` placeholder. */
	readonly key: string | { readonly template: string };
	/** The sites this key is legal at. A frozen list (membership via `includes`). */
	readonly sites: readonly TagSite[];
	readonly valueSchema: TagValueSchema;
	readonly description: string;
}

/** Why a reserved tag failed validation. */
export type TagDiagnosticReason =
	| 'unknown-reserved-tag'   // key in the quereus.* namespace with no matching spec
	| 'tag-not-allowed-here'   // valid spec, but not legal at this site
	| 'invalid-tag-value';     // value fails its TagValueSchema (e.g. empty ack rationale)

/**
 * A sited diagnostic for one offending reserved tag. Mirrors the
 * `MutationDiagnostic` pattern (`planner/mutation/mutation-diagnostic.ts`), with
 * an added `severity`: the docs distinguish hard-error keys (a typo or mis-site
 * must fail loudly) from advisory keys (an empty `quereus.lens.ack` rationale is
 * itself only a warning — `docs/lens.md:176`). Validation is **policy-free**: it
 * attaches severity and lets the caller decide whether a warning blocks.
 */
export interface TagDiagnostic {
	readonly reason: TagDiagnosticReason;
	readonly severity: 'error' | 'warning';
	readonly key: string;           // the offending reserved key, verbatim
	readonly site: TagSite;         // where it was found
	readonly message: string;       // human-facing, sited
	readonly suggestion?: string;   // copy-pasteable remediation when one applies
}

/**
 * The reserved-tag spec table — deeply frozen (the array, each spec entry, and
 * each entry's `sites` list are immutable, so this shared module singleton can
 * never be mutated by a consumer), transcribed directly from the doc tables.
 * Each entry cites its doc source. The two downstream tickets
 * (`3-lens-prover-and-constraint-attachment` Phase C, `view-mutation-plan-node-substrate`
 * Phase 2) consume this rather than re-declaring the namespace.
 */
const RESERVED_TAG_SPECS: ReservedTagSpec[] = [
	// --- rename hints : stable-identity / previous-name for the declarative differ ---
	// Read by `schema-differ.ts` (`readQuereusHint`) to pair a declared object with
	// an existing actual across a rename. They are first-class specs (not a
	// differ-local allow-list) so the differ can validate every declared object's
	// tags through this registry with hard-error-on-unknown. valueSchema is
	// `'string'` (NOT csv-of-identifiers): the differ never value-validated these,
	// and a real id may carry a hyphen (`'tbl-thing'`) or name a quoted identifier
	// — tightening would falsely reject existing schemas. See
	// docs/schema-rename-detection.md. A future ticket may add a dedicated
	// `csv-of-names` schema.
	{
		key: 'quereus.id',
		sites: siteSet('physical-table', 'physical-column', 'view-ddl', 'physical-index', 'physical-constraint'),
		valueSchema: 'string',
		description: 'Stable identity of a declared object; the differ pairs it across a rename (preferred over previous_name).',
	},
	{
		key: 'quereus.previous_name',
		sites: siteSet('physical-table', 'physical-column', 'view-ddl', 'physical-index', 'physical-constraint'),
		valueSchema: 'string',
		description: 'Comma-separated former name(s) of a declared object; the differ pairs it across a rename when no id matches.',
	},
	// --- quereus.expose_implicit_index : catalog-visibility opt-in on a UNIQUE constraint ---
	// A declared/inline UNIQUE constraint's enforcement BTree (its implicit covering
	// structure) is hidden from the catalog / export_schema by default; this boolean tag
	// surfaces it under the constraint name. Read by `catalog.ts`
	// (`implicitCoveringIndexExposure`) and treated as real (compared) schema state by the
	// differ (`schema-differ.ts` § RENAME_HINT_KEYS). It is a constraint-only physical tag,
	// so it is legal solely at the physical-constraint site — the position shared by the
	// direct CREATE TABLE named constraint, the `ALTER TABLE … ALTER CONSTRAINT … SET TAGS`
	// target, and the declarative differ's declared constraint. (First-class spec rather
	// than a catalog-local string so a typo — `expose_implicit_indx` — fails loudly on every
	// one of those paths, the same posture the rest of the namespace has.)
	{
		key: 'quereus.expose_implicit_index',
		sites: siteSet('physical-constraint'),
		valueSchema: 'boolean',
		description: 'Surface a UNIQUE constraint\'s implicit covering structure in the catalog / export_schema (boolean; default hidden).',
	},
	// --- quereus.engine_managed : engine-synthesized physical table excluded from the declarative diff ---
	// `= true` marks a physical table the engine (or an engine-driven module) owns
	// rather than a user-declared object. `collectSchemaCatalog` skips it entirely,
	// so the declarative differ never emits a create/drop for it and `export_schema`
	// omits it; it stays resolvable via `getTable` / `getAllTables` everywhere else.
	// The motivating producer is Lamina's lens basis layer — its per-column
	// `(rowId, value)` member relations register into the basis scope's Schema, and
	// without this marker a bare in-place `apply schema <basis>` would diff them as
	// orphan tables and drop each. Sibling of `quereus.expose_implicit_index` (the
	// implicit-covering-index exclusion). Physical-table site only (it governs a
	// physical backing, not a lens column or constraint). First-class spec rather
	// than a catalog-local string so a typo fails loudly on every tag-validation
	// path, the same posture the rest of the namespace has.
	{
		key: ENGINE_MANAGED_TABLE_TAG,
		sites: siteSet('physical-table'),
		valueSchema: 'boolean',
		description: 'Mark a physical table as engine-synthesized/owned; excluded from the declarative diff and export_schema (boolean; default absent).',
	},
	// --- quereus.sync.replicate : per-table maintenance-write change-log opt-in ---
	// docs/migration.md § Synced vs. local derived tables. `= true` records a
	// maintained table / materialized view's maintenance writes in the sync change
	// log (the store backing host queues a DataChangeEvent per realized
	// BackingRowChange — column versions / HLC stamps / tombstones, like an ordinary
	// table write — on the row-time maintenance path AND the create-fill / refresh
	// path, the latter as the minimal keyed diff so a value-identical re-fill
	// suppresses). Boolean (the host reads `=== true`), default off. Sited at
	// view-ddl (the `create materialized view … with tags (…)` authoring form) and
	// physical-table (the canonical `create table … using store() maintained as …`
	// form) — the two authoring forms of a migration target. NOT a logical-* site:
	// the tag governs a physical backing, not a lens column. Engine-global spec,
	// behaviorally store-only (the memory host stays event-free — see
	// quereus-store/src/common/backing-host.ts).
	{
		key: SYNC_REPLICATE_TAG,
		sites: siteSet('view-ddl', 'physical-table'),
		valueSchema: 'boolean',
		description: 'Opt this maintained table / materialized view\'s maintenance writes into the sync change log '
			+ '(the backing host records column versions / tombstones for each derivation write). Default off.',
	},
	// --- quereus.sync.evict : per-table basis-eviction override ---
	// docs/migration.md § 4 Contract. Overrides the global SyncConfig.basisEviction
	// mode for one basis table: 'never' (keep storage forever), 'immediate' (reclaim
	// on the first sweep after detach), or a non-negative number of milliseconds (a
	// custom retention horizon). The sync layer captures it into its lifecycle record
	// at lens-deploy time. Sited like quereus.sync.replicate — the two authoring forms
	// of a basis table (the `create materialized view … with tags` form and the
	// canonical `create table … using store()` form). Engine-global spec, consumed by
	// the sync layer (the engine attaches no eviction behavior).
	{
		key: SYNC_EVICT_TAG,
		sites: siteSet('view-ddl', 'physical-table'),
		valueSchema: 'eviction-policy',
		description: 'Per-table basis-eviction override: \'never\', \'immediate\', or a non-negative retention horizon in milliseconds.',
	},
	// --- quereus.lens.* : lens advisory acknowledgments / access hints ---
	// (The former quereus.update.* family is gone: routing became per-row
	// presence/membership columns; default_for.<column> became the first-class
	// `with defaults (col = expr, …)` body-select clause.)
	{
		// docs/lens.md:176, 190 — code is <code>[:<target>]; remainder captured whole.
		key: { template: 'quereus.lens.ack.<code>' },
		sites: siteSet('logical-table', 'logical-constraint'),
		valueSchema: 'required-nonempty-rationale',
		description: 'Acknowledge a lens advisory; the value is a required rationale.',
	},
	{
		// docs/lens.md:166, 176
		key: { template: 'quereus.lens.access.<col>' },
		sites: siteSet('logical-table'),
		valueSchema: 'string',
		description: 'Declare an expected lookup/ordering access pattern on a column.',
	},
	// --- quereus.lens.writable : per-logical-column writable-intent signal ---
	// docs/lens.md § Computed and Generated Columns. `= true` asserts the column
	// must be faithfully writable (an opaque / non-invertible body carrying it is a
	// deploy error via the round-trip prover); `= false` / absent is the
	// conservative read-only-derived admit. Boolean (the prover reads `=== true`),
	// logical-column site only.
	{
		key: LENS_WRITABLE_INTENT_TAG,
		sites: siteSet('logical-column'),
		valueSchema: 'boolean',
		description: 'Assert a logical column must have a faithful write path; an opaque/non-invertible body carrying it is a deploy error.',
	},
	// --- quereus.lens.policy.* : per-(logical-table) advisory escalation policy ---
	// A comma-separated list of advisory codes (e.g. `lens.no-backing-index`) the
	// project promotes beyond advisory. Codes carry dots and hyphens, so the value
	// is `string` (free CSV) rather than `csv-of-identifiers`. Read by the ack
	// governance (`lens-ack.ts`) after the prover runs; default-empty when absent.
	// See `docs/lens-prover.md` § Acknowledging advisories (Escalation policy).
	{
		key: 'quereus.lens.policy.error-on',
		sites: siteSet('logical-table'),
		valueSchema: 'string',
		description: 'CSV of advisory codes that are always a hard error; an ack cannot suppress them.',
	},
	{
		key: 'quereus.lens.policy.require-ack',
		sites: siteSet('logical-table'),
		valueSchema: 'string',
		description: 'CSV of advisory codes whose un-acknowledged instances are a hard error (a valid ack clears).',
	},
	// --- quereus.lens.decomp.* : module mapping-advertisement facts on basis tables ---
	// A generic module (memory/store) assembles a MappingAdvertisement from these
	// reserved tags on its basis tables via `buildAdvertisementsFromTags`
	// (docs/lens.md § The Default Mapper). Each decomposition `<id>`'s facts are
	// distributed across its member basis tables. The facet leads the key so each
	// is a single-placeholder template the registry validates (shape/site only —
	// the builder does the id/facet sub-parsing and the resolver does structural
	// validation). All sit at the `physical-table` site.
	{
		key: { template: 'quereus.lens.decomp.logical.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Logical table the decomposition <id> backs (declared on each member; resolver checks consistency).',
	},
	{
		key: { template: 'quereus.lens.decomp.role.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_ROLE_VALUES },
		description: 'Role of decomposition <id>: primary-storage (drives put) or auxiliary-access (read-path only).',
	},
	{
		key: { template: 'quereus.lens.decomp.anchor.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Existence-anchor relationId of decomposition <id> (must equal the advertisement id and be a member).',
	},
	{
		key: { template: 'quereus.lens.decomp.member.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'This table\'s member relationId within decomposition <id> (defaults to the table name when absent).',
	},
	{
		key: { template: 'quereus.lens.decomp.presence.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_PRESENCE_VALUES },
		description: 'This member\'s presence in decomposition <id>: mandatory (inner-join) or optional (outer-join).',
	},
	{
		key: { template: 'quereus.lens.decomp.keykind.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_KEYKIND_VALUES },
		description: 'Shared-key kind of decomposition <id>: surrogate (its value comes from the anchor key column\'s declared DEFAULT) or logical-tuple (the supplied logical PK).',
	},
	{
		key: { template: 'quereus.lens.decomp.key.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'csv-of-identifiers',
		description: 'This member\'s shared-key column(s) within decomposition <id> (the equi-join columns).',
	},
	{
		// Remainder captured whole as `<id>.<logicalColumn>`; the builder sub-parses it.
		key: { template: 'quereus.lens.decomp.col.<id_dot_column>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Basis column on THIS member backing logical column <logicalColumn> of decomposition <id>.',
	},
	{
		// Remainder captured whole as `<id>.<entity|attribute|value>`.
		key: { template: 'quereus.lens.decomp.pivot.<id_dot_facet>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'EAV pivot column (entity/attribute/value) on THIS member for decomposition <id>.',
	},
];

export const RESERVED_TAGS: readonly ReservedTagSpec[] = Object.freeze(
	RESERVED_TAG_SPECS.map(spec => Object.freeze(spec)),
);

/**
 * The value type a reserved key resolves to, keyed off the literal key. Every
 * retained reserved value is TEXT (a CSV, an expression, a rationale, an access
 * hint), so the result is always `string`. (Kept as a mapped type so a future
 * enum key can reintroduce a closed union without touching call sites.)
 */
export type TypedValueFor<K extends string> = K extends string ? string : string;

/**
 * Validates every `quereus.*` key in `tags` against the registry for the given
 * {@link TagSite}, returning a (possibly empty) list of {@link TagDiagnostic}.
 *
 * Per key: not in the namespace → skipped (free-form user tag); in the namespace
 * with no matching spec → `unknown-reserved-tag` (error); spec matches but the
 * site is illegal → `tag-not-allowed-here` (error); site OK but the value fails
 * its schema → `invalid-tag-value` (severity per {@link TagValueSchema} — an
 * empty ack rationale is a warning, all other value failures are errors).
 *
 * This function is policy-free: it never throws and never decides whether a
 * warning blocks. The caller (lens compile, the future escalation-policy parser)
 * owns that decision.
 */
export function validateReservedTags(
	tags: Record<string, SqlValue> | undefined,
	site: TagSite,
): TagDiagnostic[] {
	if (!tags) return [];
	const diagnostics: TagDiagnostic[] = [];
	for (const [key, value] of Object.entries(tags)) {
		if (!key.startsWith(RESERVED_TAG_NAMESPACE)) continue;
		const matched = matchSpec(key);
		if (!matched) {
			diagnostics.push(unknownReservedTag(key, site));
			continue;
		}
		if (!matched.spec.sites.includes(site)) {
			diagnostics.push(tagNotAllowedHere(key, site, matched.spec));
			continue;
		}
		const valueDiag = validateTagValue(key, value, site, matched.spec.valueSchema);
		if (valueDiag) diagnostics.push(valueDiag);
	}
	return diagnostics;
}

/**
 * Typed read of one reserved tag by its **exact** key. Does no validation —
 * callers run {@link validateReservedTags} first. Returns undefined when the key
 * is absent or null. For templated key families use
 * {@link getReservedTagByTemplate}.
 */
export function getReservedTag<K extends string>(
	tags: Record<string, SqlValue> | undefined,
	key: K,
): TypedValueFor<K> | undefined {
	const value = tags?.[key];
	return value == null ? undefined : (value as TypedValueFor<K>);
}

/** One enumerated instance of a templated reserved key. */
export interface TemplatedTagInstance {
	/** The captured remainder after the template's literal prefix (e.g. `created`, `no-backing-index:vin`). */
	readonly segment: string;
	/** The tag value, read verbatim (templated reserved values are all TEXT). */
	readonly value: string;
}

/**
 * Enumerates every instance of a templated reserved key family. For
 * `'quereus.lens.ack.<code>'`, a `tags` carrying
 * `quereus.lens.ack.no-backing-index:vin` yields one instance with
 * `segment === 'no-backing-index:vin'`. Like {@link getReservedTag}, this does
 * no validation; non-TEXT values are coerced to string so a mis-typed tag does
 * not crash enumeration (validate first to reject it).
 */
export function getReservedTagByTemplate(
	tags: Record<string, SqlValue> | undefined,
	template: string,
): TemplatedTagInstance[] {
	if (!tags) return [];
	const prefix = templatePrefix(template);
	const result: TemplatedTagInstance[] = [];
	for (const [key, value] of Object.entries(tags)) {
		if (!key.startsWith(prefix)) continue;
		const segment = key.slice(prefix.length);
		if (segment.length === 0) continue; // empty remainder is not an instance
		result.push({ segment, value: value == null ? '' : String(value) });
	}
	return result;
}

// === internal: matching ===

interface MatchedSpec {
	readonly spec: ReservedTagSpec;
	/** For a template spec, the captured remainder; undefined for an exact spec. */
	readonly segment?: string;
}

/**
 * Finds the spec a reserved key matches. Exact specs are tried first, then
 * single-placeholder templates (remainder captured whole, including any
 * `:target` refinement — sub-parsing is the consumer's job). A template whose
 * remainder would be empty does not match (so `quereus.lens.ack.` with no code
 * is an unknown key).
 */
function matchSpec(key: string): MatchedSpec | undefined {
	for (const spec of RESERVED_TAGS) {
		if (typeof spec.key === 'string' && spec.key === key) return { spec };
	}
	for (const spec of RESERVED_TAGS) {
		if (typeof spec.key === 'string') continue;
		const prefix = templatePrefix(spec.key.template);
		if (key.startsWith(prefix) && key.length > prefix.length) {
			return { spec, segment: key.slice(prefix.length) };
		}
	}
	return undefined;
}

/** The literal prefix of a template, up to its `<placeholder>`. */
function templatePrefix(template: string): string {
	const idx = template.indexOf('<');
	return idx < 0 ? template : template.slice(0, idx);
}

/** A frozen, genuinely-immutable list of legal sites for one spec. */
function siteSet(...sites: TagSite[]): readonly TagSite[] {
	return Object.freeze(sites);
}

// === internal: value-schema validation ===

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$.]*$/;

/** TEXT predicate — reserved tag values that must be strings. */
function isText(value: SqlValue): value is string {
	return typeof value === 'string';
}

/**
 * Validates one value against its {@link TagValueSchema}. Returns a diagnostic
 * on failure, or undefined when the value is well-shaped. Severity follows the
 * doc rule: an empty `required-nonempty-rationale` is a warning; all other value
 * failures are errors.
 */
function validateTagValue(
	key: string,
	value: SqlValue,
	site: TagSite,
	schema: TagValueSchema,
): TagDiagnostic | undefined {
	if (typeof schema === 'object') {
		return validateEnum(key, value, site, schema.enum);
	}
	switch (schema) {
		case 'string':
			return isText(value)
				? undefined
				: invalidValue(key, site, `must be a text value`, 'error');
		case 'boolean':
			return typeof value === 'boolean'
				? undefined
				: invalidValue(key, site, `must be a boolean value`, 'error');
		case 'csv-of-identifiers':
			return validateCsvOfIdentifiers(key, value, site);
		case 'required-nonempty-rationale':
			return validateRationale(key, value, site);
		case 'eviction-policy':
			return validateEvictionPolicy(key, value, site);
	}
}

/**
 * A `quereus.sync.evict` value: the keyword `'never'` / `'immediate'`
 * (case-insensitive), or a non-negative number of milliseconds (a numeric value
 * or a numeric string). Anything else is an error. Structural only — the sync
 * layer re-parses the accepted shapes into its {@link EvictPolicy}.
 */
function validateEvictionPolicy(
	key: string,
	value: SqlValue,
	site: TagSite,
): TagDiagnostic | undefined {
	if (typeof value === 'string') {
		const v = value.trim().toLowerCase();
		if (v === 'never' || v === 'immediate') return undefined;
		const n = Number(v);
		if (v.length > 0 && Number.isFinite(n) && n >= 0) return undefined;
	} else if (typeof value === 'number') {
		if (Number.isFinite(value) && value >= 0) return undefined;
	} else if (typeof value === 'bigint') {
		if (value >= 0n) return undefined;
	}
	return invalidValue(
		key,
		site,
		`must be 'never', 'immediate', or a non-negative number of milliseconds`,
		'error',
	);
}

function validateEnum(
	key: string,
	value: SqlValue,
	site: TagSite,
	allowed: readonly string[],
): TagDiagnostic | undefined {
	if (isText(value) && allowed.includes(value)) return undefined;
	return invalidValue(
		key,
		site,
		`has invalid value ${formatValue(value)}; expected one of: ${allowed.join(', ')}`,
		'error',
	);
}

function validateCsvOfIdentifiers(
	key: string,
	value: SqlValue,
	site: TagSite,
): TagDiagnostic | undefined {
	if (!isText(value) || value.trim().length === 0) {
		return invalidValue(key, site, `must be a non-empty comma-separated list of identifiers`, 'error');
	}
	const segments = value.split(',');
	for (const seg of segments) {
		const token = seg.trim();
		if (token.length === 0 || !IDENTIFIER_RE.test(token)) {
			return invalidValue(
				key,
				site,
				`must be a comma-separated list of identifiers (offending segment: ${formatValue(token)})`,
				'error',
			);
		}
	}
	return undefined;
}

/**
 * A `quereus.lens.ack.*` rationale. An empty / missing / whitespace / non-TEXT
 * value is a **warning** (docs/lens.md:176 — "an empty or missing rationale is
 * itself a warning"); the ack never hard-blocks a deploy.
 */
function validateRationale(
	key: string,
	value: SqlValue,
	site: TagSite,
): TagDiagnostic | undefined {
	if (isText(value) && value.trim().length > 0) return undefined;
	return invalidValue(
		key,
		site,
		`has an empty or missing acknowledgment rationale; provide a non-empty justification`,
		'warning',
		`set ${JSON.stringify(key)} = '<why this advisory is accepted>'`,
	);
}

// === internal: diagnostic constructors ===

function unknownReservedTag(key: string, site: TagSite): TagDiagnostic {
	return {
		reason: 'unknown-reserved-tag',
		severity: 'error',
		key,
		site,
		message: `Unknown reserved tag ${formatValue(key)} on ${siteLabel(site)}: no such key in the reserved 'quereus.*' namespace`,
		suggestion: `Recognized keys: quereus.{id, previous_name}, quereus.expose_implicit_index, quereus.engine_managed, quereus.sync.replicate, quereus.sync.evict, quereus.lens.ack.<code>, quereus.lens.access.<col>, quereus.lens.writable, quereus.lens.policy.{error-on, require-ack}, quereus.lens.decomp.{logical,role,anchor,member,presence,keykind,key}.<id>, quereus.lens.decomp.{col,pivot}.<id>.<...>`,
	};
}

function tagNotAllowedHere(key: string, site: TagSite, spec: ReservedTagSpec): TagDiagnostic {
	const allowed = spec.sites.map(siteLabel).join(', ');
	return {
		reason: 'tag-not-allowed-here',
		severity: 'error',
		key,
		site,
		message: `Reserved tag ${formatValue(key)} is not allowed on ${siteLabel(site)}; it is valid only on: ${allowed}`,
	};
}

function invalidValue(
	key: string,
	site: TagSite,
	detail: string,
	severity: 'error' | 'warning',
	suggestion?: string,
): TagDiagnostic {
	return {
		reason: 'invalid-tag-value',
		severity,
		key,
		site,
		message: `Reserved tag ${formatValue(key)} on ${siteLabel(site)} ${detail}`,
		suggestion,
	};
}

/** Human label for a {@link TagSite}, for sited messages. */
function siteLabel(site: TagSite): string {
	switch (site) {
		case 'view-ddl': return 'a view declaration';
		case 'dml-stmt': return 'a DML statement';
		case 'logical-table': return 'a logical table';
		case 'logical-constraint': return 'a logical constraint';
		case 'logical-column': return 'a logical column';
		case 'physical-table': return 'a basis table';
		case 'physical-column': return 'a physical column';
		case 'physical-index': return 'a physical index';
		case 'physical-constraint': return 'a physical constraint';
	}
}

/** Render a tag key/value for a message: quote strings, stringify the rest. */
function formatValue(value: SqlValue): string {
	return typeof value === 'string' ? `'${value}'` : String(value);
}
