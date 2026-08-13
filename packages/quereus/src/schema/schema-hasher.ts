import type * as AST from '../parser/ast.js';
import { generateDeclaredDDL } from './catalog.js';
import { astToString } from '../emit/ast-stringify.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Strips tags from a declared schema AST so they don't affect hash computation.
 * Tags are informational metadata and must not influence schema versioning.
 */
function stripTagsFromDeclaredSchema(schema: AST.DeclareSchemaStmt): AST.DeclareSchemaStmt {
	return {
		...schema,
		items: schema.items.map(item => {
			if (item.type === 'declaredTable') {
				const { tags: _t, ...tableStmt } = item.tableStmt;
				return {
					...item,
					tableStmt: {
						...tableStmt,
						columns: tableStmt.columns.map(col => {
							const { tags: _ct, ...colRest } = col;
							return {
								...colRest,
								constraints: col.constraints.map(c => {
									const { tags: _cct, ...cRest } = c;
									return cRest;
								}),
							};
						}),
						constraints: tableStmt.constraints.map(c => {
							const { tags: _tct, ...cRest } = c;
							return cRest;
						}),
					},
				};
			}
			if (item.type === 'declaredIndex') {
				const { tags: _it, ...indexStmt } = item.indexStmt;
				return { ...item, indexStmt };
			}
			if (item.type === 'declaredView') {
				const { tags: _vt, ...viewStmt } = item.viewStmt;
				return { ...item, viewStmt };
			}
			if (item.type === 'declaredMaterializedView') {
				const { tags: _mvt, ...viewStmt } = item.viewStmt;
				return { ...item, viewStmt };
			}
			return item;
		}),
	};
}

/**
 * Canonical text of a declared schema — the `isLogical` kind prefix plus the
 * generated DDL, joined by newlines.
 *
 * **Tags-inclusive, deliberately.** This is the reconciliation rendering: the
 * schema differ DOES diff tags and emits `ALTER … SET TAGS` steps for them, so
 * `apply schema`'s applied-state snapshot (see `runtime/emit/schema-declarative.ts`)
 * must treat a tag-only edit as a change. {@link computeSchemaHash} calls this on
 * a tag-STRIPPED copy instead, because tags must not affect schema *versioning*.
 * One renderer, two callers, one difference — do not conflate them.
 */
export function renderDeclaredSchemaCanonical(declaredSchema: AST.DeclareSchemaStmt): string {
	// Prefix the schema kind so a physical↔logical flip changes the rendering and the
	// logical declarations (their tables / columns / constraints, emitted by
	// generateDeclaredDDL) are covered.
	const kindPrefix = declaredSchema.isLogical ? 'logical\n' : '';
	return kindPrefix + generateDeclaredDDL(declaredSchema).join('\n');
}

/**
 * Computes a hash of a declared schema (or a lens block) for versioning.
 *
 * A `declare lens` block is **behavioral** — it changes what `select * from X.T`
 * returns — so it participates in hashing on its own canonical SQL (the basis
 * binding + every override, tags-free by construction). Keyed independently of
 * the logical schema it binds, matching how the lens block is stored.
 */
export function computeSchemaHash(declaredSchema: AST.DeclareSchemaStmt | AST.DeclareLensStmt): string {
	if (declaredSchema.type === 'declareLens') {
		const canonicalText = 'lens\n' + astToString(declaredSchema);
		return toBase64Url(fnv1aHash(canonicalText));
	}

	// Strip tags before rendering — tags are non-behavioral metadata, so they must
	// not move the version hash. This strip is the ONLY difference from the
	// reconciliation rendering (see {@link renderDeclaredSchemaCanonical}), which
	// keeps tags because the differ acts on them.
	//
	// The kind prefix inside the shared renderer makes a physical↔logical flip
	// change the hash. The basis hash lives on the basis schema's own declaration,
	// so a logical-table removal changes this logical hash without perturbing the
	// basis hash (asymmetric removal).
	const canonicalText = renderDeclaredSchemaCanonical(stripTagsFromDeclaredSchema(declaredSchema));

	// Compute hash using FNV-1a algorithm and encode as base64url
	const hashBytes = fnv1aHash(canonicalText);
	return toBase64Url(hashBytes);
}

/**
 * Computes a short hash (first 8 characters) for display
 */
export function computeShortSchemaHash(declaredSchema: AST.DeclareSchemaStmt | AST.DeclareLensStmt): string {
	const fullHash = computeSchemaHash(declaredSchema);
	return fullHash.substring(0, 8);
}


