# AUQ choice-prediction fidelity eval: Contract

A second held-out decision-fidelity lane, alongside the Soundwave up/down lane (`CONTRACT.md`).
This lane is **N-alternative forced choice**: predict WHICH option the owner picked when Claude put a
question to him via the AskUserQuestion tool. Scored SEPARATELY from the Soundwave lane; never
blended (roadmap invariant: two scores).

Goal card: `~/notes/afk-tasks/Q-20260626-0003-auq-choice-prediction-eval.md`.
Recon: `~/notes/planning/2026-06-26/askuserquestion-choice-dataset-recon.md` (re-confirmed 2026-06-26).

## The question this eval answers

Given a question with a fixed option set that the owner has NOT been shown answering, can the
warehouse predict which option he chose, using only his prior choosing behaviour? How much better
than the strong always-pick-recommended baseline is that prediction, especially on the deviation
cases where he did NOT take the recommendation?

## Signal (re-measured 2026-06-26, do not trust memory)

- Source: Claude Code transcripts `~/.claude/projects/*/*.jsonl`. No hook logs AUQ; it is entirely
  in the transcripts the warehouse already ingests.
- The QUESTION + OPTIONS live in the `tool_use` block (name=AskUserQuestion,
  input.questions[].{question, header, multiSelect, options[].label}).
- The PICK lives in the matching `tool_result` (by tool_use_id):
  `Your questions have been answered: "<question>"="<chosen-label>", ...`.
- **CLEAN triple** = a question whose recorded answer string-matches one of the offered option
  labels (case/whitespace-normalized). Free-text "Other" answers are excluded.
- Re-measure: **428 clean triples** (427 single-select, 1 multiSelect), option-count 2/3/4 =
  91/273/64. always-pick-recommended/first = **73.6%** (315/428); 1/N random = 35.6%.

## Contract

| Element        | Definition                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| Input          | One held-out triple: its `situation` (question + header) and its option labels.        |
| Task           | Predict the index (into options) the owner picked.                                       |
| Ground truth   | The recorded `chosenIdx`.                                                              |
| Context        | The OTHER triples (their situations, options, picks) + their stored situation vectors. |
| Split          | Leave-one-out: N folds, each holds out exactly 1, context = remaining N-1.             |
| Primary metric | Top-1 accuracy (correct option over N folds).                                          |
| Secondary      | Deviation-case accuracy (accuracy on triples where the owner did NOT pick baseline).     |
| Baselines      | (a) always-pick-recommended/first; (b) 1/N random (analytic mean of 1/option-count).   |

## Leakage guard (critical)

- A fold's context is strictly the other triples; the held-out chosen index never enters context.
- **Situation never contains an option label** (asserted in `auq-dataset.test.ts`; triples that
  would violate this are dropped at extraction, keeping the set leak-free by construction).
- Situations are embedded under the DISTINCT model key `gemini-embedding-001#auq-situation`, so the
  AUQ vectors never collide with the warehouse's conversation vectors. The eval loader reads the
  `embedding` table directly by (turn_id, model); the vec0 index is skipped.

## Predictors (compared)

1. **judge:gemini-zeroshot**: Gemini picks given situation + options only (no examples).
2. **judge:gemini-knn@k**: Gemini picks given situation + options + the k nearest prior
   (situation, pick) examples retrieved via the situation embedding. Built behind an injectable
   `ChoiceJudge` seam so the build/test loop stays zero-network (same pattern as `Judge`/`Embedder`).
   Model id verified via `/chub` immediately before the one gated live run, never hardcoded.

**kNN design decision (per goal card Assumptions):** a standalone local kNN predictor is DROPPED.
Option sets vary per question, so a neighbour's picked LABEL does not exist in the held-out item's
option set, and a "deviation" has no concrete target. The situation embedding instead powers the
judge's few-shot retrieval; the kNN contribution is measured as zero-shot vs knn@k (retrieval off/on).

## Baselines

- **always-recommended/first**: predict the explicit "(recommended)" option if present, else option
  index 0. This is the number to beat (= the prevalence of follow-the-recommendation behaviour).
- **1/N random**: analytic expected accuracy = mean over triples of 1/(option count). No dice rolled.

## Kill gate (honored)

PASSES: 428 >= 100 clean triples and always-recommended 73.6% <= 90% (re-measured before build;
see report). `runAuqFidelity` still HALTs loudly if fewer than `MIN_TRIPLES = 100` triples are
embedded, rather than fabricating a number from a degenerate set.

## Pressure-test (failure modes this design accepts)

- **Strong baseline.** 73.6% already encodes situation reasoning. A small top-1 lift is only
  meaningful if concentrated in the deviation cases, which is why deviation accuracy is reported.
- **Self-questions.** These are Claude's questions capturing the owner's picks: the eval tests his
  decision preference given a frame Claude chose, not free-form decisions. The report says so.
- **Judge echoes the recommendation.** If the judge just always picks the recommended option it
  reproduces the baseline. That is exactly why the baseline is reported alongside and the deviation
  split is the headline signal, not the blended top-1.

## Done when

A report under `~/notes/planning/2026-06-26/auq-choice-eval-report.md` records N (re-confirmed),
both predictors' top-1 accuracy vs BOTH baselines, deviation-case accuracy, and an explicit
beats / does-NOT-beat statement for each predictor vs always-recommended. No blended fidelity number.
