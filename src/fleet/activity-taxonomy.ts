// activity-taxonomy.ts — the ONE source of truth for classifying a hive_mind /
// activity_event `action` string into a cognitive activity CATEGORY.
//
// Why this exists: the brain-graph visualization used to key its lobes off
// agent_id via a hardcoded map that drifted (roster renamed -> everything fell
// to one lobe). Lobes are now keyed off the TYPE of activity (this classifier).
// Matrix's fleet lane reads the SAME hive_mind table (its activity_event.action),
// so the taxonomy is shared rather than reinvented per consumer.
//
// PURE module: no framework imports, no DOM, no Node APIs. Safe to import from a
// preact component (claudeclaw-os/web) AND from a Node service (matrix/src).
//
// CANONICAL COPY: claudeclaw-os/web/src/lib/activity-taxonomy.ts
// VENDORED COPIES (e.g. matrix/src/fleet/activity-taxonomy.ts) keep the CLASSIFIER
// LOGIC in sync; per-repo Prettier configs differ on whitespace, so byte-equality
// is not required — categorizeAction's rules and category set must match.

export type ActivityCategory =
  | 'dispatch' // plan / dispatch / execute — the executive loop
  | 'learn' // sense / integrate / analyze
  | 'communicate' // dialogue / digests / hand-offs
  | 'produce' // visible output / publishing
  | 'lifecycle'; // session housekeeping — neutral, de-emphasised

export interface ActivityCategoryMeta {
  id: ActivityCategory;
  label: string;
  blurb: string;
}

export const ACTIVITY_CATEGORIES: ActivityCategoryMeta[] = [
  { id: 'dispatch', label: 'Dispatch', blurb: 'plan, delegate, execute' },
  { id: 'learn', label: 'Learn', blurb: 'analyze, review, integrate' },
  { id: 'communicate', label: 'Communicate', blurb: 'dialogue, digests, hand-offs' },
  { id: 'produce', label: 'Produce', blurb: 'published / visible output' },
  { id: 'lifecycle', label: 'Lifecycle', blurb: 'session housekeeping (neutral)' },
];

/**
 * Classify a raw `action` string into an activity category.
 * Ordered rules; first match wins. Unknown actions default to 'dispatch'
 * (the executive loop is the most defensible home for an unclassified action).
 */
export function categorizeAction(action: string): ActivityCategory {
  const a = (action || '').toLowerCase();

  // 1. Lifecycle / housekeeping — the dim neutral zone (session_end is ~1/3 of rows)
  if (a === 'session_end' || a.includes('log_skipped') || a === 'hil-pending') return 'lifecycle';

  // 2. Produce / publish — visible output
  if (a.includes('post') || a.includes('publish') || a.includes('profile-update')) return 'produce';

  // 3. Communicate / recall — dialogue, digests, hand-offs
  if (
    a.includes('digest') ||
    a.includes('wrap') ||
    a.includes('standup') ||
    a.includes('delegate_result')
  )
    return 'communicate';

  // 4. Sense / integrate / learn — analysis, review, audits, nudges, coaching prep
  if (
    a.includes('analysis') ||
    a.includes('retro') ||
    a.includes('rollback') ||
    a.includes('audit') ||
    a.includes('nudge') ||
    a.includes('preference') ||
    a.includes('intake') ||
    a.includes('prep') ||
    a.includes('primer') ||
    a.includes('review') ||
    a.includes('research') ||
    a.includes('coaching')
  )
    return 'learn';

  // 5. Plan / dispatch / execute — the executive loop, and the default for unknowns
  // (orchestrator_log, dispatch*, delegate, mission_complete, subtask_*, kup-dispatch)
  return 'dispatch';
}
