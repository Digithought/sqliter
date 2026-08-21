description: Sorting a column that can hold blanks in descending order used to put the blank rows at the wrong end whenever the engine took a shortcut through a matching index; the shortcut is now refused unless the blanks are provably absent, so the answer no longer depends on which indexes exist.
files:
  - packages/quereus/src/vtab/best-access-plan.ts                   # nullSafeOrderingPrefixLength + NULL_EXCLUDING_OPS (~line 152)
  - packages/quereus/src/index.ts                                   # re-export (~line 113)
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering (~1058), buildMonotonicAdvertisement (~590), bare PK advertisement (~514)
  - packages/quereus-store/src/common/store-module-access-plan.ts   # local copy deleted; buildPkOrderingAdvertisement gated (~1382)
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts     # two new describes (6 + 4 cases)
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic # section 3 rewritten
  - packages/quereus-store/test/index-ordering.spec.ts              # 'primary-key ordering advertisement: NULL placement gate' (8 cases)
  - docs/invariants.md                                              # NEW: OPT-060
  - docs/module-authoring.md                                        # capability contract + OPT-060 back-link
----

# DESC ordering claims no longer misplace NULLs

## The rule

`ORDER BY` places NULLs **first for both directions** — placement is absolute, never
conditioned on ASC/DESC (`orderByNullResult`, `packages/quereus/src/util/comparison.ts`).

Both storage backends disagree on a **descending** key column. The store bit-inverts the
column's key bytes, so NULL's low `0x00` tag lands at the end of the walk; the memory
module negates the ascending comparator, and NULL is the lowest value, so negation sends
it to the end too. An ascending column agrees with the engine, so only DESC columns were
ever affected.

When a module claimed an ordering over such a column the sort-absorption rule deleted the
Sort with no further check, and the NULL rows came out at the wrong end. Same query, two
answers, depending on whether the index existed.

Columns are NOT NULL by default in this engine — a column is exposed only once it is
explicitly declared `null`. That is what kept the blast radius small.

## What shipped

**One shared predicate, in core.** `nullSafeOrderingPrefixLength`
(`packages/quereus/src/vtab/best-access-plan.ts`, exported from the package root)
truncates an ordered key's order-preserving prefix at the first DESC column a NULL could
reach. A DESC column survives when **any** of: it is declared NOT NULL; it is pinned by
this plan's own equality; or a pushed filter on it is NULL-excluding (`=`, `IN`, the four
range ops, `IS NOT NULL`). It takes key columns as `ReadonlyArray<IndexColumnSchema>`,
which `PrimaryKeyColumnDefinition[]` satisfies structurally, so an index's `columns` and a
table's `primaryKeyDefinition` both go in unchanged. The store's local copy was deleted
and its call sites repointed.

Gated claim sites, all four of them:

| site | form |
| --- | --- |
| memory `indexSatisfiesOrdering` | boolean — both callers claim `requiredOrdering` verbatim |
| memory `buildMonotonicAdvertisement` | leading column only; drops `supportsAsofRight` with it |
| memory bare PK advertisement (`findBestAccessPlan`) | truncation; claim dropped at prefix 0 |
| store `buildPkOrderingAdvertisement` | truncation; `{}` at prefix 0 |
| store `buildIndexOrderingAdvertisement` / `chooseOrderingPlan` | truncation (pre-existing, from the earlier ticket) |

## Review findings

**Read first:** the implement diff (`5fd54ba07`), before the handoff summary. Then the
surrounding code at every claim site, the doc files the change touched, and
`docs/invariants.md`, which it did not.

### Major — fixed in this pass

**The memory module had a fourth ordering-claim site the ticket never named, and it was
ungated.** `findBestAccessPlan` (`packages/quereus/src/vtab/memory/module.ts:514`)
advertises the whole primary key as `providesOrdering` when the request carries **no**
`requiredOrdering` at all — the branch that exists so the merge-join rule can pick an
already-ordered leaf. It is the direct twin of the store's `buildPkOrderingAdvertisement`,
which the implementer *did* gate, so the two backends disagreed on the same table shape.

Confirmed by observation, not inference: for
`create table p (a integer null, b integer, primary key (a desc, b)) using memory`, the
plan printed `INDEX SCAN p USING _primary_ ORDER BY 0 DESC, 1` while the scan returned
`3, 2, 1, null` — NULLs last under a claim that means NULLs first. The implementer's own
memory tests did not catch it because every one of them supplies a `requiredOrdering`,
which routes through the gated path instead.

The fix reuses the same helper and truncates, matching the store arm exactly. Behaviour
now, all verified: nullable DESC leading member → no claim; `(a asc, b desc)` with
nullable `b` → truncated to `ORDER BY 0`; declared NOT NULL → full claim kept; ascending
nullable → full claim kept; `where a > 0` → claim restored. Four regression cases added
under `memory module — bare primary-key ordering advertisement`, and negative-controlled
(gate stubbed to `pk.length`): the two wrong-claim cases fail, the two must-still-claim
cases stay green, so they are not passing by accident of a disabled optimization. The
control is removed — `grep -rn TEMP-NEGATIVE-CONTROL packages/ docs/` is clean.

I did **not** produce an end-to-end wrong *answer* through this site. The consumer that
would show one is merge join, and the cost model picked hash join on every shape I tried
(both sides `primary key (a desc, …)`, 200–300 rows, inner and left). The other consumers
of a bare ordering claim — streaming aggregate, streaming distinct — need adjacency only,
which NULL placement does not disturb. So the site was a false claim in the plan with no
demonstrated user-visible symptom; it is fixed on the strength of the claim being false,
which is the invariant, not on a repro.

### Major — the invariant register was not updated

`docs/invariants.md` is the normative text for exactly this kind of cross-module contract,
and this rule meets all four of its admission criteria (a property the code upholds;
violation is a wrong answer, not a lost optimization; statable in 120 words; names a
concrete site). It had no entry. Added **OPT-060 — An ordering claim over a descending key
column excludes NULLs**, naming the shared helper and both backends' PK arms, guarded by
the memory secondary-index test. `yarn docs:check` passes.

### Minor — fixed in this pass

- **`docs/module-authoring.md`'s capability bullet was a ~400-word single paragraph** that
  restated the invariant in full — which the register's own convention says a topic doc
  must not do. Rewritten as a lead sentence plus three sub-bullets (how `keyColumns` is
  typed, truncation vs the boolean form, and *gate every claim, not only a requested one*
  — the point the old text left implicit and the memory bare-PK site got wrong). The
  section now carries the `> **Invariant:** [OPT-060](…)` back-link.
- **`NULL_EXCLUDING_OPS`'s comment explained only `OR_RANGE`'s absence.** `NOT IN`,
  `MATCH`, `LIKE` and `GLOB` are NULL-rejecting too and are equally absent. Comment now
  says the set is deliberately incomplete, that incompleteness costs an optimization and
  never correctness, and names them.
- **`tickets/backlog/debt-oversized-source-files.md`** already claims both large files this
  ticket edits; its dated `wc -l` figures were refreshed rather than a new ticket filed
  (`store-module-access-plan.ts` 1,591 → 1,568, this ticket shrank it; `memory/module.ts`
  1,230 → 1,284).

### Checked and clean

- **Every `providesOrdering` assignment in the tree** was enumerated
  (`grep -rn "providesOrdering:" packages/*/src`) — 7 sites, 3 memory + 4 store. After the
  fix above, all are gated. No other shipped module advertises an ordering.
- **The load-bearing claim in the new `OR_RANGE` comment holds for the memory module**:
  `adjustPlanForOrdering` and `evaluateOrderingOnlyPlans` both exclude an OR_RANGE-handled
  plan from an ordering claim on independent grounds, so leaving `OR_RANGE` out of
  `NULL_EXCLUDING_OPS` costs nothing.
- **`PredicateConstraint.usable` is not consulted by the helper.** Every constraint the
  planner mints today sets `usable: true` (`constraint-extractor.ts`, `rule-key-set-seek`,
  `rule-select-access-path` — checked all of them), and an unusable one would still be
  enforced as a residual `Filter`, so the NULL-exclusion argument survives either way. No
  action.
- **`IndexColumnSchema` and `PrimaryKeyColumnDefinition` are byte-identical interface
  declarations** (`schema/table.ts:602` and `:1194`) — the structural-compatibility
  argument in the helper's doc comment is sound. The duplication predates this ticket and
  is not its business.
- **`best-access-plan.ts`'s new `../schema/table.js` import is `import type`**, so it is
  erased and introduces no runtime cycle.
- The implementer's three flagged judgement calls were re-examined and all stand:
  `supportsAsofRight` riding on `monotonicOn` (its declaration says it implies it, so they
  cannot be gated apart); `NO_PINNED_COLUMNS` on the PK arm (an equality on a PK member
  reaches the helper through `request.filters` regardless — I relied on the same argument
  for the memory bare-PK site); and the extra `buildMonotonicAdvertisement` gate, which is
  in scope and correct.

### Tripwires — parked, not filed

- **Both `monotonicOn` gates remain preventative and untestable from SQL.** The
  implementer's honest gap stands after review:
  `deriveOrderingFromMonotonicOn` has no callers, and `rule-monotonic-limit-pushdown`
  requires `supportsOrdinalSeek`, which no shipped module advertises (memory defers it in a
  TODO at `module.ts:563`). Both gates are correct-by-argument; neither can be observed as
  a wrong answer today. The condition is named in the module doc-comments at each site and
  the class-level runtime guard is already filed as
  `backlog/debt-nothing-checks-advertised-row-order` — no new ticket.
- **A false bare ordering claim is only reachable through merge join, which the cost model
  does not currently pick for the shapes that would expose it** (see the major finding).
  If merge join's cost model changes, that is the path that turns a stale claim into
  dropped rows. Parked in the code comment at
  `packages/quereus/src/vtab/memory/module.ts:524`, which names merge join as the consumer.

### Empty categories

- **No new tickets filed.** Both findings resolved at a single site each, in this pass; the
  one class-level guard worth having is already on the board.
- **No accepted-tradeoff `NOTE:`s were tripped.** Grepped the touched sites; none carries
  one, so nothing was re-filed against a decision already made.
- **No pre-existing failures surfaced**; `tickets/.pre-existing-error.md` was not written.

## Validation

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn lint` | clean |
| `yarn docs:check` | clean |
| `yarn test` (all workspaces) | clean — quereus 10005 passing (+4), store 1905 passing, 0 failing |
| `yarn test:store` (LevelDB-backed logic tests) | 9997 passing, 33 pending, 0 failing |

Negative controls run and removed for both the review fix (above) and, per the implement
handoff, for every gate case it added.
