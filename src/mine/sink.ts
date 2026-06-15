// Matrix Phase 2 - Mine v1 sink. Persists findings to their two destinations:
//   1. a dated ~/notes/daily/<YYYY-MM-DD>.md note (APPEND a section; never clobber the note)
//   2. an outcome(turn_id, fed_work, artifact_ref) row per finding (the first-class anti-slop
//      signal; fed_work starts false and flips true later when a finding actually drives work)
//
// The low-signal gate lives at the CALLER: when runMineV1 returns lowSignal=true the caller must
// NOT call writeFindings. As a defensive backstop, writeFindings on an empty list writes nothing.

import type { Database } from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from './mine-v1.js';

export interface SinkConfig {
  /** Directory for dated daily notes. Default ~/notes/daily. Injected in tests. */
  vaultDailyDir?: string;
  /** Wall clock in ms. Default Date.now(). Injected in tests. */
  now?: number;
}

export interface SinkResult {
  /** Path of the daily note written to (empty string if nothing was written). */
  notePath: string;
  /** Number of outcome rows inserted. */
  outcomeRows: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local YYYY-MM-DD for the daily-note filename. */
function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local YYYY-MM-DD HH:MM for the section header. */
function localTimeStamp(d: Date): string {
  return `${localDateStamp(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Write findings to the daily note (append) and the outcome table (one row per finding).
 * Returns what was written. An empty findings list is a no-op (defensive low-signal backstop).
 */
export function writeFindings(
  db: Database,
  findings: Finding[],
  config: SinkConfig = {},
): SinkResult {
  if (findings.length === 0) return { notePath: '', outcomeRows: 0 };

  const now = config.now ?? Date.now();
  const dir = config.vaultDailyDir ?? join(homedir(), 'notes', 'daily');
  const when = new Date(now);
  const notePath = join(dir, `${localDateStamp(when)}.md`);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  lines.push(`## Matrix Mine - ${localTimeStamp(when)}`);
  lines.push('');
  lines.push(
    `Second brain talks back: ${findings.length} lifecycle gap(s) where discussion outran shipping.`,
  );
  lines.push('');
  for (const f of findings) {
    lines.push(`- ${f.headline}`);
  }
  lines.push('');
  const section = `${lines.join('\n')}\n`;

  // Append so an existing daily note (and any earlier Mine section that day) is preserved. A
  // leading blank line separates this section from prior content.
  if (existsSync(notePath)) {
    appendFileSync(notePath, `\n${section}`);
  } else {
    writeFileSync(notePath, section);
  }

  const insert = db.prepare(
    'INSERT INTO outcome (turn_id, fed_work, artifact_ref) VALUES (?, ?, ?)',
  );
  const insertAll = db.transaction((items: Finding[]) => {
    for (const f of items) {
      // fed_work starts 0 (false): the finding has been surfaced, not yet acted on. artifact_ref
      // points at the note where it landed so the outcome is traceable back to the surface.
      insert.run(f.representativeTurnId, 0, notePath);
    }
  });
  insertAll(findings);

  return { notePath, outcomeRows: findings.length };
}
