description: When you hand a text function something that is not text — binary data, a JSON document, a number — different functions do different things with it, so some give an answer built from an internal spelling of the value, some quietly return nothing, and none of them agree with what the same value looks like everywhere else in the engine.
files:
  - packages/quereus/src/func/builtins/string.ts     # substr/substring, trim/ltrim/rtrim, replace, instr, lower, upper, reverse, lpad, rpad, split_string, string_concat, length
  - packages/quereus/src/util/value-text.ts          # valueToText — the one conversion these should be using
  - packages/quereus/src/func/registration.ts        # createScalarFunction — where an argument-coercion policy would live
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic  # the agreement assertions this would extend
  - docs/functions.md                                # § String Functions — the paragraph describing today's three behaviours
difficulty: medium
repro: verified
tradeoffs: Whatever policy wins changes results some application may already depend on, and pushing coercion into the registration layer touches every scalar builtin, not only the string family — a maintainer may prefer to leave the family alone now that the divergence is at least documented.

---

# One rule for "this argument should be text", applied by the framework

## What is wrong

`canonical-value-to-text` gave the engine one conversion from a value to text
(`valueToText`) and put every general-purpose site on it: `cast(x as text)`, `text(x)`,
writes into a TEXT column, `||`, `group_concat`, the `LIKE` operator, and the
`like`/`glob` functions. The rest of the string builtin family was outside that ticket
and still does its own thing — three different things, in fact:

| behaviour | functions | `substr(x'6162', 1, 1)`-style result |
|---|---|---|
| JavaScript stringification | `substr`, `substring`, `trim`, `ltrim`, `rtrim`, `replace`, `instr` | a BLOB becomes `97,98` (its comma-joined byte numbers), so `substr(x'6162',1,1)` is `9` |
| refuse the value | `lower`, `upper`, `reverse`, `lpad`, `rpad` return NULL; `split_string` yields no rows | `upper(x'6162')` is NULL |
| the one conversion | `like`, `glob` (and everything outside this file) | `cast(x'6162' as text)` is `ab` |

Verified by running each of these against the engine, not inferred.

The first row is the damaging one: `97,98` is a JavaScript array-to-string artifact that
appears nowhere else in the engine and means nothing in SQL. A user who writes
`substr(blob_col, 1, 1)` gets a digit out of a number they never asked to see.

## The invariant to aim for

For any value `x` and any builtin `f` that treats its argument as text:

```
f(x) = f(cast(x as text))
```

That is one property test over the whole family, and it is the point of the ticket — not
patching the functions one at a time. It also decides the NULL-returning row: `upper` may
keep returning NULL only if `upper(cast(x as text))` does too, which it does not.

## Where the fix belongs

Prefer the seam over the instances. A builtin that stringifies its own arguments is a
shape the registration layer currently permits; if `createScalarFunction`
(`func/registration.ts`) let a function declare "this argument is text" and applied
`valueToText` before the implementation ran, no future builtin could reintroduce the
divergence, and the family becomes a mechanical edit rather than thirteen judgement calls.
Editing the thirteen implementations directly is the fallback, not the goal.

Whatever lands, the property test above should cover every builtin that declares a text
argument, generated from the registry rather than hand-listed — a hand-list goes stale the
first time somebody adds a function.

## Decisions the implementer has to make first

- **NULL-returning vs coercing.** They cannot both be right. Coercing is what the rest of
  the engine now does, and is what SQLite does; the NULL behaviour is currently documented
  in `docs/functions.md` for `lower`/`upper`, so it is a stated behaviour being changed,
  not an accident being fixed.
- **`length()` is deliberately not in the family.** It reports a byte count for a BLOB and
  a character count for TEXT — it is asking about the value's storage class on purpose, and
  coercing its argument would destroy that. It stays as it is.
- **`string_concat`** silently drops non-string values today (unlike `group_concat`, which
  now renders them), and `split_string` yields no rows rather than an error when either
  argument is not text. Same family, same decision.

## Interaction with what already landed

`docs/functions.md` § String Functions and `docs/types.md` § Value to text both state
today's divergence in plain terms and name this ticket. Both paragraphs come out when this
lands.
