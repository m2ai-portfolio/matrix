# v1 Decision-Fidelity Eval: Contract (skeleton)

Phase 3 of the Soundwave -> Matrix track / v1 of the beta-digital-longevity roadmap.
This is the FIRST held-out decision-fidelity eval. It proves the mechanism on one narrow
labeled lane; it is not a final fidelity number.

Source plan: `~/notes/planning/2026-06-26/soundwave-to-matrixP3.md` (subtasks 4-10).
Recon verified against the live warehouse on 2026-06-26 (see numbers below).

## The question this eval answers

Given an article the owner has NOT been shown grading, can the warehouse predict whether he
would thumbs-up or thumbs-down it, using only his prior grading behavior as context? How much
better than a dumb prior (always-guess-his-majority-vote) is that prediction?

## Signal (verified, do not trust memory)

- `source='soundwave'` rows in `conversation_turn`: **27**, all `role='article'`.
- All 27 carry `meta.verdict` in {`up`,`down`}: **18 up / 9 down** (global approval rate 0.667).
- All 27 are embedded (`embedding` table, `gemini-embedding-001`, 3072-dim, Float32 BLOB).
- `meta` fields: `verdict`, `notes` (the owner's rationale), `tag`, `batch`, `domain`, `url`.
- 8 distinct domains, skewed: venturebeat 9, huggingface 8, reddit 4, substack 2, and
  4 singletons (arxiv, github, cachd, vibesolve).

## Contract

| Element        | Definition                                                                                |
| -------------- | ----------------------------------------------------------------------------------------- |
| Input          | One held-out graded article: its `content` (+ `domain`, `url`). Verdict AND notes hidden. |
| Task           | Predict `verdict` in {up, down} + a probability `pUp` in [0,1].                           |
| Ground truth   | The hidden `meta.verdict`.                                                                |
| Context        | The OTHER 26 grades (their content, verdict, notes, domain). Plus their stored vectors.   |
| Split          | Leave-one-out: 27 folds, each holds out exactly 1, context = remaining 26.                |
| Primary metric | Accuracy (correct up/down over 27 folds).                                                 |
| Calibration    | Brier score = mean( (pUp - 1[actual=up])^2 ). Lower is better.                            |
| Baselines      | (a) majority-class prior; (b) per-domain approval-rate prior.                             |

Decision fidelity is the ONLY thing scored here. Voice fidelity is OUT OF SCOPE for this
skeleton and is NOT computed, NOT averaged in. (Roadmap invariant: two scores, never blended.)

## Leakage guard (critical)

- A fold's context is strictly the other 26 grades. The held-out verdict is never in context.
- Retrieval uses the held-out item's STORED vector as the query, then excludes its own `turn_id`.
- The held-out item's `notes` are NEVER passed to any predictor (the notes state the rationale and
  would leak the verdict, e.g. "not actionable, shiny object" => down). Notes are passed ONLY for
  the 26 context examples.

## Predictors (both run, compared)

1. **embedding-kNN** (local, deterministic, zero network): L2-distance from the held-out vector to
   each of the 26 context vectors; take the k nearest; similarity-weighted vote of their verdicts
   (sim = 1/(1+distance), matching `src/search/semantic.ts`). `pUp` = weighted up-fraction.
2. **Gemini LLM-judge** (gated, network): retrieve the k nearest context grades as labeled
   examples (content snippet + verdict + notes), show the held-out article (content only), ask
   Gemini for up/down + confidence. `pUp` = confidence if up else 1-confidence. Built behind an
   injectable `Judge` seam so the build/test loop stays zero-network (same pattern as `Embedder`).
   Model id verified via `/chub` immediately before the one gated live run, never hardcoded from memory.

## Baselines

- **majority-class**: predict the context majority verdict; `pUp` = context approval rate. With LOO
  this is `up` on every fold (18/27 always leaves an up-majority), so its accuracy is exactly the
  prevalence of `up` = the number a predictor must BEAT to show any signal.
- **per-domain approval-rate**: among context grades sharing the held-out item's domain, predict by
  that domain's approval rate; if the domain is a singleton (no same-domain context in the fold),
  fall back to the global context approval rate. `pUp` = that rate.

## Kill gate (honored)

PASSES: 27 >= 20 usable grades, retrieval returns context. So we run.
The skeleton still reports loudly that N=27 is thin and the per-domain baseline degrades to the
global prior for 4 of 8 domains. A win here is a mechanism proof, not a trustworthy fidelity score.

## Pressure-test (failure modes this design accepts)

- **Tiny N.** 27 folds, 9 of one class. One flipped prediction moves accuracy ~3.7 points.
  Report N and absolute counts, never just a percentage.
- **Narrow facet.** This is AI-article taste, not general decision-making. The report says so explicitly.
- **kNN can echo the prior.** If embeddings cluster by topic not by taste, kNN may just reproduce the
  majority. That is exactly why the baseline is reported alongside: if kNN ~= majority-class, the
  warehouse adds nothing on this lane yet, which is a real (publishable) finding, not a failure to hide.
- **Judge leakage via notes.** Guarded above. Tests assert the held-out notes never reach a predictor.

## Done when

A reusable harness (parameterized by N/k/predictor) outputs decision-fidelity accuracy + Brier for
each predictor AND the baseline-prior numbers; a report under `~/notes/planning/2026-06-26/` records
both, N, predictor design, calibration, and the narrow-signal caveat. No single blended fidelity number.
