// Matrix Phase 4: decision-source extractors.
// See ./decision-etl-design.md. Each extractor parses ONE source kind into DecisionTriples.
// Built one-end-to-end-then-scale: notes decisions/ first, then daily/, active-work/cards/, afk-tasks/.
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DecisionTriple } from './decision.js';

/** Split a markdown file into its YAML-ish front-matter map + the body below it. */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fm, body: m[2] };
}

/** Return the body of the first `## <heading>` section matching `headingRe`, up to the next `## `. */
export function sectionBody(body: string, headingRe: RegExp): string | null {
  const lines = body.split('\n');
  let capturing = false;
  const out: string[] = [];
  for (const line of lines) {
    const isH2 = /^##\s+/.test(line);
    if (isH2) {
      if (capturing) break; // next section starts
      if (headingRe.test(line)) {
        capturing = true;
        continue;
      }
    }
    if (capturing) out.push(line);
  }
  return capturing ? out.join('\n').trim() : null;
}

/** First non-empty paragraph (up to the first blank line), with surrounding bold markers stripped. */
export function firstParagraph(text: string): string {
  const para: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (para.length > 0) break;
      continue;
    }
    para.push(line.trim());
  }
  return para.join(' ').replace(/^\*\*/, '').replace(/\*\*$/, '').trim();
}

/**
 * The decision sentence from a recommendation section: prefer the FIRST **bold** span (the memo's
 * bolded verdict, even when followed immediately by prose), else fall back to the first paragraph.
 */
export function decisionFromSection(section: string): string {
  const bold = section.match(/\*\*([\s\S]+?)\*\*/);
  if (bold) return bold[1].replace(/\s+/g, ' ').trim();
  return firstParagraph(section);
}

/** Date from front-matter `date:`, falling back to a leading YYYY-MM-DD in the filename. */
function tsFor(fm: Record<string, string>, file: string): string {
  if (fm.date) return fm.date;
  const m = basename(file).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * SOURCE 1, notes decisions/: one structured `# DECISION MEMO:` per file. situation = the memo
 * subject (H1 / `**Subject:**`), choice = the first paragraph of `## ... Reconciled recommendation`,
 * rationale = the full body. status:decided yields a labeled outcome (fed_work=true).
 */
export function extractVaultDecisions(dir: string): DecisionTriple[] {
  if (!existsSync(dir)) return [];
  const triples: DecisionTriple[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    if (fm.type && fm.type !== 'decision') continue;

    const h1 =
      body
        .match(/^#\s+(.+)$/m)?.[1]
        ?.replace(/^DECISION MEMO:\s*/i, '')
        .trim() ?? '';
    const subjectLine = body.match(/^\*\*Subject:\*\*\s*(.+)$/m)?.[1]?.trim();
    const situation = subjectLine || h1;
    if (situation === '') continue;

    const recSection = sectionBody(body, /Reconciled recommendation/i);
    const choice = recSection ? decisionFromSection(recSection) : '';
    if (choice === '') continue; // no decision extractable -> skip (kill-gate counts this)

    const decided = (fm.status ?? '').toLowerCase() === 'decided';
    triples.push({
      situation,
      choice,
      rationale: body.trim(),
      outcome: decided ? { fedWork: true, artifactRef: fm.project ?? path } : undefined,
      sourceKind: 'vault_decision',
      sourcePath: path,
      anchor: 'decision-memo',
      ts: tsFor(fm, path),
      project: fm.project,
    });
  }
  return triples;
}

const DECIDED_HEADING = /(What was (decided|figured out))|(^##\s+Decisions\b)/i;

/**
 * SOURCE 2, notes daily/ (/tldr notes): one triple per note that has a "What was decided /
 * figured out" section. This is the volume source. situation = the note title/topic, choice = the
 * lead decision of the section, rationale = the whole section. No labeled outcome (daily decisions
 * carry no clean terminal verdict).
 */
export function extractDailyDecisions(dir: string): DecisionTriple[] {
  if (!existsSync(dir)) return [];
  const triples: DecisionTriple[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    const section = sectionBody(body, DECIDED_HEADING);
    if (!section || section.trim() === '') continue;
    const choice = decisionFromSection(section);
    if (choice === '') continue;
    const situation = fm.title || fm.topic || `Daily note ${tsFor(fm, path)}`;
    triples.push({
      situation,
      choice,
      rationale: section,
      sourceKind: 'daily_tldr',
      sourcePath: path,
      anchor: 'what-was-decided',
      ts: tsFor(fm, path),
      project: fm.project,
    });
  }
  return triples;
}

/**
 * SOURCE 3, notes active-work/cards/: cleanest LABELED outcomes. Only terminal cards
 * (status done|blocked) become decisions. choice = the verdict + its result lead; the outcome row
 * carries fed_work (done=true, blocked=false) + the sink/result as artifact_ref.
 */
export function extractActiveWorkCards(dir: string): DecisionTriple[] {
  if (!existsSync(dir)) return [];
  const triples: DecisionTriple[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    const status = (fm.status ?? '').toLowerCase();
    if (status !== 'done' && status !== 'blocked') continue;
    const title = fm.title ?? '';
    if (title === '') continue;
    const notes = sectionBody(body, /\bNotes\b/i) ?? '';
    const resultLead = fm.result ? firstParagraph(fm.result) : '';
    const choice = resultLead ? `${status}: ${resultLead}` : status;
    triples.push({
      situation: title,
      choice,
      rationale: [fm.result ?? '', notes].filter(Boolean).join('\n\n').trim(),
      outcome: { fedWork: status === 'done', artifactRef: fm.sink || fm.result || path },
      sourceKind: 'active_work_card',
      sourcePath: path,
      anchor: fm.id ?? 'card',
      ts: tsFor(fm, path),
    });
  }
  return triples;
}

/**
 * SOURCE 4, notes afk-tasks/ goal cards (id: Q-): situation = title, choice = the Goal statement,
 * rationale = Goal + Notes. A labeled outcome only when the card is terminal (done|blocked).
 */
export function extractGoalCards(dir: string): DecisionTriple[] {
  if (!existsSync(dir)) return [];
  const triples: DecisionTriple[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    if (!(fm.id ?? '').startsWith('Q-')) continue; // goal cards only
    const title = fm.title ?? '';
    if (title === '') continue;
    const goal = sectionBody(body, /\bGoal\b/i);
    const choice = goal ? firstParagraph(goal) : title;
    if (choice === '') continue;
    const notes = sectionBody(body, /\bNotes\b/i) ?? '';
    const status = (fm.status ?? '').toLowerCase();
    const terminal = status === 'done' || status === 'blocked';
    triples.push({
      situation: title,
      choice,
      rationale: [goal ?? '', notes].filter(Boolean).join('\n\n').trim(),
      outcome: terminal ? { fedWork: status === 'done', artifactRef: fm.sink || path } : undefined,
      sourceKind: 'goal_card',
      sourcePath: path,
      anchor: fm.id ?? 'goal',
      ts: tsFor(fm, path),
    });
  }
  return triples;
}
