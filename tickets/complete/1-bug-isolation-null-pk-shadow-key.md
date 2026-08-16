description: Fixed a bug where, inside a database transaction, reading a table through a secondary index could silently hide unrelated committed rows whenever the table's row-identity columns allowed empty (NULL) values.
files:
  - packages/quereus-isolation/src/isolated-table.ts (`mergedSecondaryIndexQuery` / `pkShadowKey`)
  - packages/quereus-isolation/test/null-pk-shadow-key.spec.ts (regression tests, 4)
  - packages/quereus-isolation/src/overlay-rows.ts (`makePkKeySerializer` — the shared recipe, unchanged, now consumed here too)
  - packages/quereus/src/util/key-serializer.ts (unchanged)
---

# Done: NULL primary-key components no longer collapse the isolation layer's shadow key

## What the change does

When a transaction reads a table through a secondary index, the isolation layer merges the
transaction's staged rows over the committed ones, and must hide ("shadow") each committed
row the transaction already touched. It identified rows for that comparison with an encoder
that returned the *same* value for every row containing a NULL anywhere in its row identity.
So touching one such row hid all the others — committed, untouched — from that transaction's
own query.

Reachable today on any table declared with no `PRIMARY KEY` (the engine synthesizes an
all-columns row identity for those and does not force those columns non-empty) that has at
least one nullable column.

Fixed by keying the shadow set through the engine's single shared row-identity recipe, which
tags a NULL component distinctly instead of collapsing the whole key.

## Review findings

**Checked:** the implement diff read first, before the handoff summary; the shared
row-identity recipe in `key-serializer.ts` and its existing test
(`packages/quereus/test/util/pk-identity.spec.ts`); an independent re-sweep of every
`serializeKey`/`serializeRowKey` call site in the monorepo; the merge path's callers to
establish what state `pkShadowKey` can actually be built under; `docs/schema.md`
(Primary-key nullability), `docs/sync.md`, and `packages/quereus-isolation/README.md`
against the new reality; lint and tests.

### Fixed in this pass (minor / inline)

- **Duplicated row-identity recipe — this *was* the bug's root cause, not a side note.**
  `pkShadowKey` hand-rolled the same "are these two primary keys the same row?" recipe that
  `makePkKeySerializer` (isolation's own thin wrapper over the engine's
  `makePkIdentitySerializer`) already provides — per-column collation normalizer, semantic
  key transform, serialization. `key-serializer.ts` explicitly documents that recipe as the
  ONE implementation and names its two legitimate callers (the isolation overlay and the
  sync engine). The local third copy drifted (`serializeKey` vs the canonical
  `serializeKeyNullGrouping`), and that drift *is* the reported bug. The implement pass
  patched the copy and left the copy in place, so the class could recur. Collapsed
  `pkShadowKey` onto `makePkKeySerializer`: −53 lines of duplicated logic and its explaining
  comment, and the site now inherits the recipe's existing guard test
  (`pk-identity.spec.ts` "groups NULL instead of collapsing the whole key"). Removed the
  now-dead `keyNormalizerResolver` field and the `serializeKeyNullGrouping` /
  `semanticKeyTransform` / `KeyNormalizerResolver` imports it needed.
- **Behavior parity on an unpopulated schema.** The old local code tolerated a not-yet-
  populated `tableSchema` (empty PK indices, empty key); routing through the shared recipe
  would have thrown a `TypeError` inside it. Guarded, with the reason at the site.
- **Test gap: no UPDATE coverage.** The three added tests exercised insert and delete only.
  An UPDATE on a no-`PRIMARY KEY` table relocates the row (every column is part of the row
  identity), so the overlay holds a deletion marker at the old key *and* the rewritten row
  at the new one — both with NULL components. Added a fourth test for that path.

### Major (new tickets)

None. The one architectural finding above (the duplicated recipe) was a ~10-line collapse
onto an existing shared function with existing test coverage, so it was cheaper to fix here
than to file.

### Verified and left alone

- **Other `serializeKey` call sites.** Re-swept independently of the implementer's sweep.
  Three remain — `store-module-index-build.ts` (`dedupeRowSignature`),
  `join-key-extractor.ts`, and `asof-scan.ts` (partition bucketing, two calls). Every one
  returns / handles `null` deliberately, because SQL's own semantics say a NULL never equals
  a NULL for UNIQUE, join equality, or partition matching. None is a row-identity key. No
  change.
- **Docs.** `docs/schema.md` § Primary-key nullability already states the exact rule this
  fix honors (a synthesized all-columns key does not promote its columns to NOT NULL);
  `docs/sync.md` already describes pk identity as a `serializeKeyNullGrouping` string — it
  described the correct behavior while the isolation copy disagreed with it, which is more
  evidence for the collapse above. `packages/quereus-isolation/README.md` describes the
  secondary-index merge at a level the change does not touch. Nothing was out of date.

### Tripwires

None recorded, deliberately. The only conditional concern at the site — the serializer is
rebuilt per merged read — is unchanged from before this ticket and is dwarfed by the full
overlay scan on the next line, which already carries its own `NOTE:` tripwire about growing
overlays.

### Accepted tradeoffs

No `NOTE: accepted tradeoff` markers exist at any site this change touches, so nothing was
previously declined here.

## Test coverage

`packages/quereus-isolation/test/null-pk-shadow-key.spec.ts`, four tests, each driving a
real `create index` + secondary-index read and asserting (via the underlying memory module's
captured `idxStr`) that the read was genuinely served by the secondary index — a primary-key
full scan never reaches this code and would pass vacuously.

- Untouched committed NULL-keyed rows survive an insert + delete of other NULL-keyed rows.
  **Verified failing before the fix** by the implement pass.
- Rows differing only in *which* column is NULL key distinctly. **Also verified failing
  before the fix.**
- A NULL component does not collide with the literal text `'N:'` (the NULL marker's
  spelling). Passes before and after — a forward guard on the encoder's type tagging, not a
  repro of this bug.
- (added in review) A staged UPDATE that relocates a NULL-keyed row shadows only that row.

## Validation

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation test` — 414 passing.
- `yarn workspace @quereus/store test` — 1794 passing (includes
  `timespan-semantic-key-identity.spec.ts`, which exercises the modified-PK shadow set
  through the semantic-transform path this refactor routes differently).
- `yarn workspace @quereus/sync test` — 725 passing.
- `yarn workspace @quereus/sync-client test` — 85 passing;
  `yarn workspace @quereus/sync-coordinator test` — 134 passing;
  `yarn workspace @quereus/quoomb-cli test` — 64 passing.
- `yarn workspace @quereus/quereus run lint` — exit 0, no findings (the only package with a
  real lint; it is untouched by this ticket, so this is a sanity pass).
- `packages/quereus`'s own 9601-test suite was **not** re-run in this pass: the engine core
  does not depend on `@quereus/isolation` (the dependency runs the other way), and no core
  file was modified by this ticket. Every package that *does* depend on isolation was run,
  listed above. The implement pass ran the full monorepo suite green at the pre-review SHA.
