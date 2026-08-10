---
description: A table could be created with a computed-column formula naming something the formula never introduces, and every insert or update to that table then failed forever. CREATE TABLE now refuses the same declaration ALTER TABLE ADD COLUMN already refused, with the same message.
files:
  - packages/quereus/src/schema/generated-column-refs.ts   # classifyQualified — 'unbound' RefBinding + originalQualifier
  - packages/quereus/src/schema/table.ts                   # unboundQualifierError + both consumers
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic  # § 4 (6 sub-cases)
  - packages/quereus/test/logic/41-generated-column-scope.sqllogic   # § 8 updated, § 12 added in review
  - docs/sql-ddl.md   # Generated Columns bullet list
---

# Complete: unbound-qualifier generated column rejected at declaration time

## What shipped

`classifyQualified` in `generated-column-refs.ts` used to fold two situations into
one label, `'foreign'`: "an inner `FROM` in the body exposes this qualifier" (fine)
and "nothing anywhere binds this qualifier" (dead on arrival). Both consumers in
`table.ts` skipped `'foreign'` unconditionally, so the second case passed
`CREATE TABLE`'s check and then failed at every `INSERT`/`UPDATE`.

- New `RefBinding` value `'unbound'`, returned only when no frame on the walk binds
  the qualifier **and** no opaque frame (subquery / derived table / CTE source, or a
  DML body) was crossed on the way out. If one was, the walk still returns
  `'unknown'` — undecidable, so accepted rather than refused on a guess.
- `old.<col>` is no longer special-cased to `'foreign'`; it falls through the same
  path as any other qualifier that binds nothing.
- New `originalQualifier` on `GeneratedColumnRef` so the message names the reference
  as written (`d` or `s.d`).
- Shared `unboundQualifierError` in `table.ts`, thrown as the first check in both
  `extractGeneratedColumnDependencies` (CREATE TABLE, re-run by the ALTER emitter)
  and `validateAddColumnGeneratedRefs` (ADD COLUMN pre-flight), so the two authoring
  surfaces raise the byte-identical message by construction.

## Review findings

**Correctness of the classification — checked, nothing found.** Read the implement
diff before the handoff, then traced `classifyQualified` against the frame model in
`rename/scope-frame.ts` for the cases that could produce a FALSE rejection: an
aliased FROM source (alias hides the bare table name — rejection is correct SQL), a
CTE named in a FROM (`bound` carries it, `hasOpaque` set), compound/`union` legs
(each pushes its own frames), a correlated qualifier bound by an enclosing frame
(the loop scans the whole stack, so it returns `'foreign'` before reaching the
`'unbound'` fallthrough), and `insert`/`update`/`delete` bodies (visited under an
opaque frame, so `'unknown'`). `'unbound'` fires only where nothing on the stack
binds the qualifier and the walk saw everything it needed to. `'foreign'` is
checked before `hasOpaque` within a frame, which is the right precedence.

**Test coverage — one gap, fixed in this pass.** The new `opaque ? 'unknown' :
'unbound'` defer is the branch that keeps the fix from over-rejecting, and it had
zero tests: every § 4 sub-case exercises the reject arm. Added § 12 to
`41-generated-column-scope.sqllogic` — a generated body whose unbound qualifier sits
inside a derived table still creates, pinning the defer against a future edit that
turns it into a false rejection.

**Docs — one overclaim, fixed in this pass.** `docs/sql-ddl.md` asserted "Neither
surface ever produces a table that a later `INSERT` or `UPDATE` cannot write to."
That is false given the opaque residual the same change deliberately keeps (and
which § 12 now pins). Reworded to state what actually holds — the two surfaces
always agree — and to name the undecidable case. Re-read `docs/sql-alter.md`
§ ADD COLUMN and § RENAME and `docs/schema-rename-detection.md`; both remain
accurate under the change, no edit needed.

**Coverage removed by the implement pass — reviewed, accepted.** § 8 of
`41-generated-column-scope.sqllogic` lost its "another schema's qualifier is not a
self reference, so DROP COLUMN is allowed" case, because that declaration is now
rejected up front. The property it protected — a foreign qualifier records no false
self-dependency edge — is still covered by §§ 9 and 10, which use FROM-bound foreign
qualifiers and assert both the drop refusal and the rename rewrite. Nothing
restored.

**Interaction with table rename — checked, no defect.** A table rename rewrites
generated bodies (`renameTableInColumnExpressions`), including a bare self-qualifier
via the seedless-qualifier emit site, so renaming the owning table does not turn an
`'own'` reference into an `'unbound'` one.

**Tripwire recorded, not filed as a ticket.** The rejection also runs on catalog
reload (`withGeneratedColumnGraph`), so a table a pre-fix build persisted with such a
body now fails to LOAD rather than loading unwritable. Weighed and kept — the table
could never be written either way, and backwards compatibility is not yet a project
constraint — and recorded as an accepted-tradeoff `NOTE:` on `unboundQualifierError`
in `packages/quereus/src/schema/table.ts`, with its revisit condition.

**No major findings, so no new tickets were filed.** Nothing in the diff pointed at
an architectural invariant worth climbing to: the change already replaces a
two-hand-synced-strings arrangement with one shared thrower, which is the
class-level fix for the CREATE-vs-ALTER disagreement.

**Source hygiene — no findings.** `generated-column-refs.ts` is 330 lines,
`classifyQualified` 15; the new helper in `table.ts` is a single function with a
purposeful name and no duplicated message text.

## Validation

- `yarn build` — clean.
- `yarn test` (from `packages/quereus`) — 9233 passing, 0 failing, 25 pending
  (includes the rebuilt § 4, the updated § 8, and the § 12 added in review).
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test:store` not run: the change touches only schema-time reference
  classification, which is store-independent.

## Known gaps carried forward

- A `CHECK` body carrying an unbound qualifier is untested and unchanged — `CHECK`
  has no equivalent declaration-time reference analysis to extend.
- `tickets/plan/3-debt-schema-expression-scope-walker-duplicated.md` (if still open)
  plans to merge this walk with `schema/rename/self-qualifier-strip.ts`; that
  refactor must carry the `'unbound'` variant forward.
- Sibling ticket `bug-nondeterministic-generated-column-accepted-at-create-table`
  covers the other half of the same CREATE-vs-ALTER disagreement.
