----
description: Turning a parsed schema declaration back into SQL text produces broken SQL whenever the declaration contained a kind of item the engine doesn't understand yet — the rest of the declaration gets commented out and can no longer be read back.
prereq:
files:
  - packages/quereus/src/parser/parser.ts (`sourceSlice` ~4148 — stub returning `''`; `declareIgnoredItem` ~3682)
  - packages/quereus/src/emit/ast-stringify.ts (`declareItemToString` case `'declareIgnored'` ~1427; `declareSchemaToString` ~1392)
  - packages/quereus/src/parser/ast.ts (`DeclareIgnoredItem` ~918)
difficulty: medium
----

## What happens

`declare schema <name> { … }` may contain item kinds the parser has no grammar for
yet — `domain`, `collation`, `import`. The parser keeps a placeholder for each one
(`declareIgnored`) that is supposed to hold the item's original text. It doesn't:
the helper that would slice that text out of the SQL source is a stub that returns
an empty string, because the parser keeps only tokens, not the source string.

The SQL writer then falls back to a comment for an empty placeholder, and the
writer separates items with `;` on a single line. The result is a `--` line comment
followed by everything else on that line — so the closing brace is commented out:

```
input:    declare schema main { domain d1 as text  table t1 { id integer primary key } }
emitted:  declare schema main { -- ignored; table t1 (id integer primary key); }
re-parse: Expected '}' to close schema declaration block. Got ''.
```

Two distinct defects stack up:

- **The declared item's text is lost.** Anything the placeholder was meant to carry
  (for canonicalization or hashing) is gone.
- **The emitted SQL is not valid SQL.** A `--` comment inside a one-line block
  swallows the remainder of the line, so the round trip parse → stringify → parse
  fails for the whole declaration, not only for the ignored item.

Both predate the alias-barrier work; found while reviewing
`bug-declare-schema-materialized-swallowed-as-table-alias`.

## Expected behavior

Round-tripping any parseable `declare schema` block through the SQL writer must
produce text that parses back to an equivalent statement. For an unmodeled item
that means the writer needs *something* to emit that survives re-parsing:

- Preferred: the placeholder carries the item's real source text, and the writer
  emits it verbatim. This needs the parser to retain the SQL string (or the token
  span plus offsets) so the text can be sliced.
- Whatever is emitted must not be a `--` line comment, since block items are
  written on one line. A block comment (`/* … */`) or a newline before the closing
  brace would both be safe; emitting nothing at all for an item whose text is
  unknown is also defensible, but then say so — silently dropping is what makes
  the current behavior hard to notice.

Also worth settling while here: `DeclareIgnoredItem.kind` is typed
`'domain' | 'collation' | 'import'` but is hardcoded to `'domain'` no matter which
keyword was actually seen. Nothing reads it today. Either populate it from the
keyword or drop the field.

## Use cases to cover

- `declare schema main { domain d1 as text  table t1 { id integer primary key } }`
  → stringify → parse: succeeds, still two items, the table still named `t1`.
- Same with `collation` and `import` items, and with an item whose body contains a
  parenthesized or braced payload (`domain d1 as decimal(10, 2)`).
- An ignored item as the last item in the block (nothing after it to swallow) and
  as the first (a following item to swallow).
- A block with only ignored items.
