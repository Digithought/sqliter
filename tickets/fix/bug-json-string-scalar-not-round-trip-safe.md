---
description: If a JSON column holds a plain piece of text rather than a list or an object, then changing or deleting that row goes wrong — the text is silently rewritten as a number, or the statement fails with a confusing conversion error, or the delete quietly does nothing.
files:
  - packages/quereus/src/types/json-type.ts                  # JSON_TYPE.parse — re-parses a value that is already native
  - packages/quereus/src/types/validation.ts                 # coerceRowToSchema / validateAndParse — the shared re-coercion step
  - packages/quereus/src/vtab/memory/layer/manager.ts        # performUpdate coerces the whole row (~line 738)
  - packages/quereus-isolation/src/isolated-table.ts         # coerceRow (~line 1090), insertTombstoneForPK (~line 1532); comment at ~1119 already names the hazard
difficulty: hard
---

# A JSON value that is a bare piece of text does not survive being written back

## What goes wrong

JSON has six kinds of value: null, true/false, a number, a **piece of text**, a list,
and an object. Quereus stores the first four as the corresponding native JavaScript
value — so a JSON value that is the text `abc` is stored as the JavaScript string
`abc`, indistinguishable from the *serialized JSON text* `abc` would be if it were
JSON source.

That ambiguity means converting a stored JSON value "to JSON" a second time is not a
no-op. Every write path re-converts whole rows before writing them, including columns
the statement never mentioned. So a row whose JSON column holds a bare piece of text
gets damaged the moment anything touches it.

All four behaviours below were observed at HEAD.

**1. UPDATE silently rewrites the value (memory backend, the default):**

```sql
create table m (j json primary key, v text);
insert into m values ('"9"', 'a'), ('"9.0"', 'b');
-- rows are: "9" / a   and   "9.0" / b
update m set v = 'X' where v = 'a';
-- rows are now: 9 / X   and   "9.0" / b
```

The primary key of the touched row changed from the text `"9"` to the **number** `9`.
The statement only assigned `v`. Nothing warned.

**2. UPDATE fails outright when the text is not itself valid JSON:**

```sql
create table m2 (j json primary key, v text);
insert into m2 values ('"abc"', 'a');
update m2 set v = 'X';
```

raises `QuereusError: Type conversion failed for column 'j': Cannot convert 'abc' to
JSON: invalid JSON syntax` — a column the statement never assigned. The same happens
on the store backend.

**3. DELETE inside a transaction silently deletes nothing** (store backend behind the
isolation layer — `createIsolatedStoreModule`):

```sql
create table d (j json primary key, v text) using store;
insert into d values ('"9"', 'a'), ('"9.0"', 'b');
delete from d where v = 'a';
-- both rows still there, no error
```

**4. …or fails with the same conversion error** when the text is not valid JSON
(`'"abc"'` in place of `'"9"'` above): `Cannot convert 'abc' to JSON: invalid JSON
syntax`, raised by the DELETE.

Structured JSON values are unaffected — `'[2]'`, `'{"a":1}'` re-convert to themselves,
which is why every existing test passes. The plain store backend (no isolation layer)
also deletes correctly; only the isolation overlay's tombstone path breaks.

## Why

`JSON_TYPE.parse` (`packages/quereus/src/types/json-type.ts`, ~line 37) treats any
JavaScript string it is handed as *serialized JSON source* and parses it:

```ts
if (typeof v === 'string') {
    const parsed = safeJsonParse(v);
    ...
}
```

That is correct at the SQL boundary — the literal `'"abc"'` must become the string
`abc`. It is wrong for a value already in native form, where the string `abc` **is**
the value. `parse` is not idempotent on string scalars: `abc` → error, `9` → the
number 9.

`coerceRowToSchema` (`packages/quereus/src/types/validation.ts:105`) runs
`validateAndParse` over **every cell of a row**, and is the shared pre-write step for
the memory backend, the store backend, and the isolation overlay. Rows that come out
of storage and go back in — an UPDATE's carried-over columns, the isolation layer's
tombstone row (which copies the old row's primary key) — pass through it a second time
and are damaged.

Symptom 3 in particular: `insertTombstoneForPK`
(`packages/quereus-isolation/src/isolated-table.ts:1532`) builds a tombstone row
carrying the deleted row's primary key and inserts it into the overlay, which is a
memory table and re-coerces on insert. The key `"9"` becomes the number `9`, so the
tombstone lands at a key that shadows nothing and the committed row stays visible.

The hazard is already known in one place: `isolated-table.ts` ~line 1119 carries a
comment explaining that JSON's `parse` is not idempotent for a string scalar, and
deliberately writes the *un*-coerced row to the overlay for that reason. That
workaround does not cover the tombstone path, and does not help the memory backend's
own `performUpdate` (`packages/quereus/src/vtab/memory/layer/manager.ts:738`).

## Expected behaviour

A row read out of a table and written back unchanged must be unchanged — regardless of
what kind of JSON value its columns hold. Concretely: all four reproductions above must
behave as they do for structured JSON. UPDATE of an unmentioned column must leave a
JSON string scalar byte-identical; DELETE must delete, inside a transaction as well as
outside; neither must raise a conversion error for a column the statement never
assigned.

## Directions to investigate

Not yet decided — the fix stage should weigh these:

- **Convert only at the SQL boundary.** Values arriving from expressions/literals need
  conversion; values carried over from a row already in the table do not. Would mean
  `coerceRowToSchema` losing its "coerce the whole row" role at re-write sites, or
  gaining a way to say which cells are new.
- **Make conversion idempotent by making the representation unambiguous.** e.g. a
  wrapper for JSON string scalars, so a native value is never confused with JSON
  source. Wide blast radius — every place that reads a JSON cell.
- **Make `parse` tolerate already-native input.** Hardest case is exactly the
  ambiguity: for the JS string `9`, "already native" and "JSON source" are both
  plausible readings and they disagree. Any rule here needs to be stated explicitly in
  `docs/types.md`, since it decides what `'"9"'` means.

Whatever is chosen must keep the SQL literal `'"abc"'` inserting the text `abc`, and
must not regress the `bug-store-isolation-upsert-affinity-coerced-pk` behaviour the
`coerceRow` comment cites (a TEXT `'1'` proposed against an INTEGER key holding `1`
must still coerce before probing).

## Notes

- Found while reproducing `bug-json-pk-equality-drops-collation`. The two are
  independent: that one is a comparator dropping its collation, this one is a
  representation round-trip. Verified that this bug still reproduces with that fix
  applied.
- Regression tests for the isolation layer in
  `packages/quereus-store/test/json-semantic-key-order.spec.ts` currently avoid UPDATE
  and DELETE over string-scalar JSON keys because of this bug; once fixed, that file
  should gain the update/delete cases.
