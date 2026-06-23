// Matrix Phase 2 - Mine v1: semantic-vs-structural gap + ~/projects git-staleness join.
//
// "Second brain talks back": surfaces projects the owner is still DISCUSSING heavily but whose
// git history has gone STALE (the notes over-reports "active"; git is lifecycle truth). Each
// finding is enriched with structural recurrence (how many distinct conversations circled the
// topic) and an optional light-semantic recurrence (near-duplicate turns in OTHER contexts,
// the "same topic, never linked" gap, operationalized without the still-empty link table).
//
// Anti-slop is existential (CLAUDE.md): when nothing clears the thresholds the pass returns
// lowSignal=true and the caller writes NOTHING. No filler.
//
// Safety: this module only ever reads the warehouse handle it is GIVEN. It never opens a DB
// itself and never touches the live ClaudeClaw agent DB. Git + filesystem access go through
// injectable seams so tests are hermetic.

import type { Database } from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

export interface MineConfig {
  /** Wall clock in ms. Default Date.now(). Injected in tests for deterministic windows. */
  now?: number;
  /** Root scanned for git repos to join against. Default ~/projects. */
  projectsRoot?: string;
  /** Discussion-recency window in days. Default 14. */
  recentWindowDays?: number;
  /** Git-staleness threshold in days. Default 30. */
  staleThresholdDays?: number;
  /** Minimum recent turns for a project to be considered. Default 3. */
  minTurnsInWindow?: number;
  /** Maximum findings emitted. Default 7. */
  maxFindings?: number;
  /**
   * Encoded-project -> real directory map (the git-staleness join key). Default is built by
   * scanning projectsRoot for immediate child git repos and forward-encoding each path the way
   * Claude Code encodes transcript dirs (`/` and `.` -> `-`). Injected in tests.
   */
  projectDirMap?: Map<string, string>;
  /** Last-commit time (ms) for a repo dir, or undefined if not a repo. Injected in tests. */
  gitLastCommitMs?: (dir: string) => number | undefined;
  /** Optional light-semantic enrichment seam. Omitted => structural-only findings. */
  semantic?: SemanticEnricher;
}

/** Light-semantic seam: near-duplicate turns of `turnId` that live OUTSIDE `project`. */
export interface SemanticEnricher {
  crossContextRecurrence(turnId: string, project: string): Promise<number>;
}

export interface Finding {
  project: string;
  projectDir: string;
  representativeTurnId: string;
  recentTurns: number;
  distinctConversations: number;
  lastDiscussedMs: number;
  gitLastCommitMs: number;
  gitStaleDays: number;
  crossContextRecurrence?: number;
  headline: string;
  score: number;
}

export interface MineResult {
  lowSignal: boolean;
  findings: Finding[];
  scannedProjects: number;
}

interface TurnRow {
  project: string;
  ts: string | number | null;
  conversation_id: string | null;
  turn_id: string;
}

/**
 * Normalize the warehouse's MIXED-format `ts` column to epoch ms. Some connectors wrote unix
 * seconds (e.g. 1773458170), others ISO-8601 strings (e.g. 2026-06-14T04:06:05.168Z), in the
 * same column (memory: matrix-warehouse-ts-mixed-format). Bare numbers below the 1e12 ms-vs-s
 * boundary are seconds and get *1000. Unparseable values return undefined and are skipped.
 */
export function normalizeTs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Forward-encode an absolute path the way Claude Code names transcript dirs: `/` and `.` -> `-`. */
export function encodePath(absDir: string): string {
  return absDir.replace(/[/.]/g, '-');
}

/** Build the encoded-project -> real-dir map by scanning projectsRoot for immediate git repos. */
export function defaultProjectDirMap(projectsRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return map;
  }
  for (const name of entries) {
    const dir = join(projectsRoot, name);
    if (existsSync(join(dir, '.git'))) {
      map.set(encodePath(dir), dir);
    }
  }
  return map;
}

/**
 * Commit subject written by ~/bin/git-wip-snapshot.sh (every 30 min on every
 * ~/projects repo). These auto-snapshots are BACKUPS, not lifecycle "shipping",
 * so they must not count as a fresh commit when measuring staleness. Otherwise
 * the snapshot cron masks every real lifecycle gap: a repo whose last genuine
 * commit was 7 weeks ago still looks "committed 2 days ago" and never surfaces.
 */
const WIP_SNAPSHOT_GREP = '^WIP: auto-snapshot';

/**
 * Default git last-MEANINGFUL-commit time in ms, EXCLUDING WIP auto-snapshot
 * commits (`git log -1 --invert-grep --grep '^WIP: auto-snapshot' --format=%ct`).
 * Returns undefined if dir is not a repo, or has no non-snapshot commit (then the
 * project simply can't be lifecycle-checked and is skipped, not mis-joined).
 */
export function defaultGitLastCommitMs(dir: string): number | undefined {
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'log', '-1', '--format=%ct', '--invert-grep', '--grep', WIP_SNAPSHOT_GREP],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!/^\d+$/.test(out)) return undefined;
    return Number(out) * 1000;
  } catch {
    return undefined;
  }
}

interface ProjectAgg {
  project: string;
  recentTurns: number;
  distinctConversations: number;
  lastDiscussedMs: number;
  representativeTurnId: string;
}

/**
 * Run a Mine v1 pass over the warehouse handle. Pure analysis: it reads conversation_turn and
 * returns findings (or lowSignal). It performs NO writes; persisting findings (daily note +
 * outcome rows) is the caller's job (src/mine/sink.ts), so the low-signal "write nothing" gate
 * is enforced by the caller checking lowSignal.
 */
export async function runMineV1(db: Database, config: MineConfig = {}): Promise<MineResult> {
  const now = config.now ?? Date.now();
  const projectsRoot = config.projectsRoot ?? join(homedir(), 'projects');
  const recentWindowMs = (config.recentWindowDays ?? 14) * DAY_MS;
  const staleThresholdMs = (config.staleThresholdDays ?? 30) * DAY_MS;
  const minTurns = config.minTurnsInWindow ?? 3;
  const maxFindings = config.maxFindings ?? 7;
  const dirMap = config.projectDirMap ?? defaultProjectDirMap(projectsRoot);
  const gitLastCommit = config.gitLastCommitMs ?? defaultGitLastCommitMs;

  // Only projects that resolve to a real ~/projects git repo can be lifecycle-checked. Pulling
  // just those rows keeps the scan tight (pseudo-projects like `memories` and /tmp/cmd/* dirs
  // are not repos and are excluded here, not silently mis-joined later).
  const wanted = new Set(dirMap.keys());
  if (wanted.size === 0) return { lowSignal: true, findings: [], scannedProjects: 0 };

  const rows = db
    .prepare(
      `SELECT project, ts, conversation_id, turn_id FROM conversation_turn
       WHERE project IS NOT NULL AND project <> ''`,
    )
    .all() as TurnRow[];

  const aggs = new Map<string, ProjectAgg>();
  for (const row of rows) {
    if (!wanted.has(row.project)) continue;
    const tsMs = normalizeTs(row.ts);
    if (tsMs === undefined) continue;
    if (now - tsMs > recentWindowMs) continue; // outside the recency window
    let agg = aggs.get(row.project);
    if (!agg) {
      agg = {
        project: row.project,
        recentTurns: 0,
        distinctConversations: 0,
        lastDiscussedMs: 0,
        representativeTurnId: row.turn_id,
      };
      aggs.set(row.project, agg);
    }
    agg.recentTurns += 1;
    if (tsMs > agg.lastDiscussedMs) {
      agg.lastDiscussedMs = tsMs;
      agg.representativeTurnId = row.turn_id; // most-recent recent turn represents the finding
    }
  }

  // distinct-conversation counts need a second structural pass over the same in-window rows.
  const convoSets = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!aggs.has(row.project)) continue;
    const tsMs = normalizeTs(row.ts);
    if (tsMs === undefined || now - tsMs > recentWindowMs) continue;
    let set = convoSets.get(row.project);
    if (!set) {
      set = new Set<string>();
      convoSets.set(row.project, set);
    }
    if (row.conversation_id) set.add(row.conversation_id);
  }

  const findings: Finding[] = [];
  for (const agg of aggs.values()) {
    if (agg.recentTurns < minTurns) continue;
    const dir = dirMap.get(agg.project);
    if (!dir) continue;
    const commitMs = gitLastCommit(dir);
    if (commitMs === undefined) continue; // can't prove staleness without git truth
    const staleMs = now - commitMs;
    if (staleMs <= staleThresholdMs) continue; // recently committed => actively shipped, not a gap
    const gitStaleDays = staleMs / DAY_MS;
    const distinctConversations = convoSets.get(agg.project)?.size ?? 0;
    findings.push({
      project: agg.project,
      projectDir: dir,
      representativeTurnId: agg.representativeTurnId,
      recentTurns: agg.recentTurns,
      distinctConversations,
      lastDiscussedMs: agg.lastDiscussedMs,
      gitLastCommitMs: commitMs,
      gitStaleDays,
      headline: '',
      score: 0,
    });
  }

  // Light-semantic enrichment (optional): the "same topic, never linked" gap. Counts near-
  // duplicate turns of the representative turn that live outside this project.
  if (config.semantic) {
    for (const f of findings) {
      f.crossContextRecurrence = await config.semantic.crossContextRecurrence(
        f.representativeTurnId,
        f.project,
      );
    }
  }

  for (const f of findings) {
    // Score: recent discussion volume, amplified by how far past the staleness threshold the repo
    // is, plus structural and semantic recurrence. Deterministic and monotonic in each input.
    const stalenessRatio = f.gitStaleDays / (config.staleThresholdDays ?? 30);
    f.score =
      f.recentTurns * stalenessRatio + f.distinctConversations + (f.crossContextRecurrence ?? 0);
    f.headline = formatHeadline(f, config.recentWindowDays ?? 14);
  }

  findings.sort((a, b) => b.score - a.score);
  const top = findings.slice(0, maxFindings);
  return { lowSignal: top.length === 0, findings: top, scannedProjects: aggs.size };
}

function formatHeadline(f: Finding, windowDays: number): string {
  const dir = f.projectDir.replace(homedir(), '~');
  const staleDays = Math.round(f.gitStaleDays);
  const recurrence =
    f.crossContextRecurrence !== undefined && f.crossContextRecurrence > 0
      ? `; topic recurs in ${f.crossContextRecurrence} turns outside the project (never linked)`
      : '';
  return (
    `${dir}: ${f.recentTurns} turns across ${f.distinctConversations} conversation(s) ` +
    `in the last ${windowDays}d, but no git commit in ${staleDays}d${recurrence}. ` +
    `Lifecycle gap: discussed, not shipped.`
  );
}
