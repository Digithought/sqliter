description: When a decimal number is shown as text, the engine prints it the way JavaScript does rather than the way SQLite does, so a whole number stored as a decimal loses its ".0" and very large or undefined results print as "Infinity" or "NaN" instead of SQLite's shorter spellings.
files:
  - packages/quereus/src/util/value-text.ts   # the number arm of the one value-to-text conversion
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # existing cast-to-text assertions
severity: cosmetic
likelihood: normal-use
repro: static
tradeoffs: Changing the spelling of every number-rendered-as-text is a visible output change for anyone already comparing or storing those strings, and buys only SQLite compatibility on a value that is not wrong, merely spelled differently.
---

# Numbers rendered as text use JavaScript's spelling, not SQLite's

The one value-to-text conversion (`util/value-text.ts`, from ticket
`canonical-value-to-text`) renders a number with JavaScript's default shortest-round-trip
spelling. SQLite renders the same values differently:

| value | Quereus | SQLite |
|---|---|---|
| the real `1.0` | `1` | `1.0` |
| `1e21` | `1e+21` | `1.0e+21` |
| a positive overflow | `Infinity` | `Inf` |
| a not-a-number result | `NaN` | (SQLite yields NULL rather than a NaN value at all) |

The `1.0` case is the one a user is most likely to meet: a REAL column holding a whole
number becomes indistinguishable from an INTEGER column once rendered, so
`cast(1.0 as text) = cast(1 as text)` is true here and false in SQLite.

This was noticed while unifying the engine's value-to-text conversions and was deliberately
kept out of that ticket: it is a separate decision with its own blast radius (every existing
assertion that renders a number as text), and it does not lose information the way the
conversions that ticket fixed did.

Whoever picks this up should settle whether Quereus wants SQLite's float text spelling at
all, given that Quereus draws the INTEGER/REAL line differently from SQLite in the first
place (a `bigint` value space, a NUMERIC type that holds either). If the answer is "no", the
right outcome is a `NOTE:` at the number arm recording the accepted divergence, not a change.
