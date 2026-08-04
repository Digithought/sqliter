/**
 * Output column-name disambiguation, shared by every node that publishes a
 * user-visible `RelationType.columns` list.
 *
 * A result row is delivered to callers as an object keyed by column name
 * (`rowToObject`), so two output columns sharing a name silently drop one of the
 * values — `select l.a, r.a, count(*) c from l join r … group by l.a, r.a` would
 * hand back a single `a`. Later occurrences therefore take a `:<n>` suffix:
 * `a`, `a:1`, `a:2`.
 */
export function disambiguateColumnNames(baseNames: readonly string[]): string[] {
	const nameCount = new Map<string, number>();
	return baseNames.map(baseName => {
		const currentCount = nameCount.get(baseName) ?? 0;
		nameCount.set(baseName, currentCount + 1);
		// First occurrence keeps the base name; subsequent ones are numbered.
		return currentCount === 0 ? baseName : `${baseName}:${currentCount}`;
	});
}
