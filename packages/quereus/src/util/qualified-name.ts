/**
 * Recover the (schema, table) pair from a flat lowercased base key
 * `` `${schema}.${table}` ``. Splits on the FIRST dot only, so a quoted
 * table name that legally contains a dot (e.g. `"a.b"` → key `main.a.b`)
 * survives intact. NOTE: a dotted *schema* name is still ambiguous; dotted
 * schema names are effectively unreachable in practice and intentionally
 * unsupported — see bug-core-fq-name-split-mis-routes-dotted-table-names.
 */
export function splitBaseKey(base: string): [schema: string, table: string] {
	const dot = base.indexOf('.');
	if (dot < 0) return ['', base]; // defensive: no schema segment
	return [base.slice(0, dot), base.slice(dot + 1)];
}
