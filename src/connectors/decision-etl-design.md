# Decision/outcome ETL (matrix connector #2): design note

Phase 4 of the Soundwave -> Matrix track. The SECOND ETL: harvest decision triples
`(situation, choice, rationale [, outcome])` from the notes and load them into the warehouse,
embedded, reusing the Phase-2 `WarehouseSink`. Source plan:
`~/notes/planning/2026-06-26/soundwave-to-matrixP4.md` (subtasks 1-12).

## Recon findings (verified this session, do not trust from memory)

- **Target tables exist; no migration needed.** `conversation_turn` (11 cols, `meta JSON`) and
  `outcome(turn_id, fed_work BOOL, artifact_ref TEXT)` are in `src/db/schema.ts`. There is NO
  `decision` table and we do not add one. A decision is a `conversation_turn` with `role='decision'`.
- **Phase-2 WarehouseSink holds, NO modification (no HALT).** `src/connectors/sink.ts`:
  `WarehouseSink.write(NormalizedTurn[])` INSERT-OR-IGNOREs turns by `turn_id`. A decision row is
  just a `NormalizedTurn`, so the Sink represents it as-is. The Sink does NOT write the `outcome`
  table, but that is not a Sink modification: outcome writes are a separate, additive step, with
  precedent in `src/mine/sink.ts` (which already writes the `outcome` table outside the Sink).
- **`turnId()` is the idempotent-id primitive** (`src/connectors/claude-code.ts`): sha256 over
  `{source, source_id, conversation_id, role, content}`. `insertTurn` uses the provided `turn_id`
  as-is (INSERT OR IGNORE on the PK), so re-runs are idempotent by construction.
- **Source reality differs from the plan's assumption (material):**
  - `notes/decisions/` = **1 file** (not a plural corpus). Cleanest format, but yields ~1 triple.
    Good for proving the mechanism; NOT where the volume is.
  - `notes/daily/` = **133 files** with a `## ... What was decided / figured out` section. This is
    the real payload: it is where Phase 4 actually enlarges the labeled decision set.
  - `notes/active-work/cards/` = **10** cards with `status: done|blocked` + a `result:` field +
    `## Notes` verdict. The cleanest LABELED outcomes (done/blocked is a real judgment).
  - `notes/afk-tasks/` = **17** goal cards with `## Notes` dated progress.
  - Sequencing revision: prove the mechanism on `decisions/` (subtask 6) as the plan says, then
    prioritize `daily/` for volume and `active-work/cards/` for labeled outcomes.

## Decision-triple schema

```ts
interface DecisionTriple {
  situation: string; // the question / context that prompted a decision
  choice: string; // what was decided (the label-bearing part)
  rationale: string; // why; may be long / may drift in wording across edits
  outcome?: {
    // present ONLY when the source carries a terminal verdict
    fedWork: boolean; // did the decision lead to acted-on work? done/decided=true, blocked=false
    artifactRef: string; // sink / result / artifact pointer
  };
  sourceKind: string; // 'vault_decision' | 'daily_tldr' | 'active_work_card' | 'goal_card'
  sourcePath: string; // absolute file path
  anchor: string; // stable in-file anchor (heading slug, card id, or section title)
  ts: string; // ISO date (frontmatter date or filename date)
  project?: string; // frontmatter project, if any
}
```

## Mapping DecisionTriple -> NormalizedTurn (Option A)

| NormalizedTurn field | value                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `source`             | `'decision'` (one lane for all decision sources; `sourceKind` kept in meta)                                      |
| `source_id`          | `` `${sourceKind}:${sourcePath}#${anchor}` `` (stable)                                                           |
| `conversation_id`    | `sourcePath` (groups decisions from one file)                                                                    |
| `role`               | `'decision'`                                                                                                     |
| `content`            | `` `Situation: ${situation}\n\nChoice: ${choice}\n\nRationale: ${rationale}` ``                                  |
| `ts`                 | `triple.ts`                                                                                                      |
| `project`            | `triple.project ?? ''`                                                                                           |
| `tokens`             | `null`                                                                                                           |
| `ingestion_batch_id` | the run's batch id                                                                                               |
| `meta`               | `JSON.stringify({ sourceKind, sourcePath, anchor, choice, hasOutcome })`                                         |
| `turn_id`            | `turnId({ source:'decision', source_id, conversation_id, role:'decision', content: `${situation}\n${choice}` })` |

**Idempotent identity = situation + choice ONLY.** The volatile `rationale` is stored in `content`
but NOT hashed into the id, so re-running after a wording edit to the rationale does not create a
duplicate row. (v1 keeps the first row; true updates are a later concern.)

## Outcome-table write (labeled judgment)

Write one `outcome(turn_id, fed_work, artifact_ref)` row **only when `triple.outcome` is present**:

- `active-work cards`: `done -> fed_work=1`, `blocked -> fed_work=0`; `artifact_ref` = `result:`/`sink`.
- `vault_decision`: `status: decided -> fed_work=1`, `artifact_ref` = the recommendation/project.
- `daily_tldr` / `goal_card`: usually NO outcome row (no clean terminal verdict) -> turn only.

Idempotency: the `outcome` table has no PK, so `insertOutcome` is guarded (skip if a row already
exists for that `turn_id`). Turn enlargement is the main goal; the outcome label is the bonus where
a real verdict exists.

## Kill gates (honored)

- HALT a source if it yields **0 parseable triples** (degenerate extractor) and report the count.
- HALT Phase-2-gap if the WarehouseSink could not represent a decision row without modification.
  (Recon already cleared this: it can.)

## Build order (one-end-to-end-then-scale)

1. `decisionToTurn()` pure transform + `insertOutcome` + tests (`:memory:`).
2. `notes/decisions/` extractor (1 file) + `:memory:` dry-run -> prove the pipe.
3. Add `daily/` (volume), then `active-work/cards/` (labeled outcomes), then `afk-tasks/`, re-running
   the dry-run after each.
4. Verification loop green -> gated live ingest outside cron windows -> embed-batch -> verify queryable.
