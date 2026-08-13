---
description: A speed-up in the schema tool decides "nothing changed" by comparing two descriptions of the database as plain text, and text a user typed into the schema can imitate the punctuation that separates one item from the next — so a maliciously worded label could, in principle, hide a real change.
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts
difficulty: medium
severity: wrong-result
likelihood: contrived
tradeoffs: Nobody hits this without deliberately crafting hostile text, and the fix costs roughly a sixth of the speed-up it protects — a maintainer could reasonably say the current encoding is good enough and leave the NOTE in place as the record.
---

## What the code does today

`apply schema` decides whether anything needs migrating by rendering the live database structure
to one long string (`renderCatalogForComparison`) and comparing it against the string it rendered
the last time it checked and found nothing to do. Equal strings ⇒ skip the comparison entirely.

The rendering separates one field from the next with a space, one line of a table from the next
with a newline, and one table from the next with a newline. Nothing escapes those characters out
of the values being rendered.

## Why that is a problem

Several rendered values are free-form text the user chose:

- a tag value (`with tags ("app.note" = '…')`),
- a column `DEFAULT` that is a string literal,
- the generated `ddl` text, which embeds both of the above verbatim.

A newline inside any of them reaches the output as a real newline. Confirmed by running the
renderer against `create table a (id integer primary key, note text default 'x<newline>y')
with tags ("app.d" = 'line1<newline>line2')` — the newlines appear unescaped in the rendered
string.

So the boundaries between items are not unambiguous. A value crafted to imitate the rendering of
a *different* item makes two structurally different databases render to the same string, and a
change between exactly those two states would be reported as "nothing changed" and skipped.

**Nobody reaches this accidentally.** It takes a tag or default written specifically to imitate
the renderer's own output, *plus* an out-of-band structural change that lands on precisely the
imitated shape. It is filed because the code's job is to be an exact comparison, and right now it
is exact only for text that does not contain the separators.

## What would retire the class

Make the encoding uniquely decodable rather than separator-delimited — i.e. so that no two
distinct inputs can produce the same output, by construction rather than by argument about which
values can contain which characters.

The straightforward form: have each renderer return its parts as an array and JSON-encode once
per level, instead of joining on spaces/tabs/newlines. JSON escapes the separators inside string
values, and a JSON array of strings decodes back to exactly one input.

Any equivalent framing works (length-prefixing, for one). The requirement is the property, not
the format.

## What it costs

Measured with `node bench/apply-schema-unchanged.mjs 30` (54 tables / 14 views / 112.7 KB
declaration, one Windows box) as the baseline:

- rendered structure: 308.8 KB
- fast-pathed no-op apply today: 1.50 ms (vs 5.49 ms for the full comparison)
- `JSON.stringify` over an array of strings of that size, measured standalone: ~+0.25 ms per
  encoding level

So roughly +0.25–0.5 ms on a 1.50 ms operation. The original acceptance bar — at least half off a
full comparison at every schema size — still holds comfortably after the change; re-run the bench
to confirm rather than trusting this estimate.

## What to pin

A test that a value containing the renderer's separators cannot change how the output is parsed —
ideally a property test that renders two deliberately different structures, one of which embeds
the other's rendering in a tag value, and asserts the outputs differ. The existing white-box
harness in `test/apply-schema-unchanged-fast-path.spec.ts` (`plantSnapshot`) is the right place to
prove the end-to-end consequence: an apply that should reconcile actually does.

## Already recorded at the site

`catalog-rendering.ts` carries a `NOTE:` on `renderCatalogForComparison` describing this exact
gap and pointing here. If this ticket is declined, keep that note and add the decline reasoning to
it — otherwise the next reviewer re-discovers and re-files it.
