// Tests for the decision-source extractors. Hermetic: a temp dir with a synthetic decision memo.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFrontmatter,
  sectionBody,
  firstParagraph,
  extractVaultDecisions,
  extractDailyDecisions,
  extractActiveWorkCards,
  extractGoalCards,
} from './decision-extractors.js';

describe('parseFrontmatter', () => {
  it('splits front-matter from body and parses key: value', () => {
    const { fm, body } = parseFrontmatter(
      '---\ndate: 2026-06-24\ntype: decision\n---\n# Title\nbody',
    );
    expect(fm).toMatchObject({ date: '2026-06-24', type: 'decision' });
    expect(body).toContain('# Title');
  });
  it('returns empty fm when there is no front-matter', () => {
    expect(parseFrontmatter('no fm here').fm).toEqual({});
  });
});

describe('sectionBody', () => {
  it('captures one ## section up to the next ##', () => {
    const body = '## A\nalpha\n## Reconciled recommendation\n**Do X.**\nbecause\n## B\nbeta';
    expect(sectionBody(body, /Reconciled recommendation/i)).toBe('**Do X.**\nbecause');
    expect(sectionBody(body, /Nope/)).toBeNull();
  });
});

describe('firstParagraph', () => {
  it('takes the first paragraph and strips surrounding bold', () => {
    expect(firstParagraph('**Build DaaS first.**\n\nmore text')).toBe('Build DaaS first.');
  });
});

describe('extractVaultDecisions', () => {
  it('extracts one triple per decision memo with a labeled outcome when status: decided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matrix-dec-'));
    writeFileSync(
      join(dir, '2026-06-24-x.md'),
      [
        '---',
        'date: 2026-06-24',
        'type: decision',
        'project: beta',
        'status: decided',
        '---',
        '',
        '# DECISION MEMO: DaaS vs CCaaS',
        '**Subject:** DaaS vs CCaaS commercial',
        '',
        '## 1. Context',
        'stuff',
        '',
        '## 5. Reconciled recommendation',
        '**Build DaaS first, solo.**',
        'because it wins 5 of 6 lenses',
        '',
      ].join('\n'),
    );
    // a non-decision file in the same dir must be ignored
    writeFileSync(join(dir, 'note.md'), '---\ntype: daily\n---\n# not a decision');

    const triples = extractVaultDecisions(dir);
    expect(triples).toHaveLength(1);
    const t = triples[0];
    expect(t.situation).toBe('DaaS vs CCaaS commercial'); // Subject line preferred
    expect(t.choice).toBe('Build DaaS first, solo.');
    expect(t.rationale).toContain('wins 5 of 6 lenses');
    expect(t.outcome).toEqual({ fedWork: true, artifactRef: 'beta' });
    expect(t.sourceKind).toBe('vault_decision');
    expect(t.ts).toBe('2026-06-24');
  });

  it('returns [] for a missing dir', () => {
    expect(extractVaultDecisions('/no/such/dir')).toEqual([]);
  });
});

describe('extractDailyDecisions', () => {
  it('extracts one triple per note with a what-was-decided section, no outcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matrix-daily-'));
    writeFileSync(
      join(dir, '2026-06-24-x.md'),
      '---\ntitle: Soundwave ETL\ndate: 2026-06-24\ntopic: matrix\n---\n## 1. What was decided / figured out\n- **Close the loop first.** ship it\n## 2. Key things to remember\nstuff',
    );
    writeFileSync(join(dir, 'no-decision.md'), '---\ntitle: nope\n---\n## Notes\nnothing decided');
    const triples = extractDailyDecisions(dir);
    expect(triples).toHaveLength(1);
    expect(triples[0].situation).toBe('Soundwave ETL');
    expect(triples[0].choice).toBe('Close the loop first.');
    expect(triples[0].outcome).toBeUndefined();
    expect(triples[0].sourceKind).toBe('daily_tldr');
  });
});

describe('extractActiveWorkCards', () => {
  it('extracts only terminal (done/blocked) cards with a labeled outcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matrix-aw-'));
    writeFileSync(
      join(dir, 'Q-1.md'),
      '---\nid: Q-1\ntitle: Verify cron\nstatus: done\nresult: Health check passed clean\nsink: this card\n---\n## Notes\nall green',
    );
    writeFileSync(
      join(dir, 'Q-2.md'),
      '---\nid: Q-2\ntitle: Restore AutoResearch\nstatus: blocked\nsink: escalation log\n---\n## Notes\nAlienPC offline',
    );
    writeFileSync(
      join(dir, 'Q-3.md'),
      '---\nid: Q-3\ntitle: WIP\nstatus: doing\n---\n## Notes\nongoing',
    );
    const triples = extractActiveWorkCards(dir).sort((a, b) => a.anchor.localeCompare(b.anchor));
    expect(triples).toHaveLength(2); // doing card skipped
    expect(triples[0].outcome).toEqual({ fedWork: true, artifactRef: 'this card' });
    expect(triples[0].choice).toContain('done:');
    expect(triples[1].outcome).toEqual({ fedWork: false, artifactRef: 'escalation log' });
  });
});

describe('extractGoalCards', () => {
  it('extracts Q- goal cards; outcome only when terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matrix-goal-'));
    writeFileSync(
      join(dir, 'Q-1.md'),
      '---\nid: Q-20260613-0001\ntitle: Starscream scaffold\nstatus: doing\nsink: producer code\n---\n## Goal\nBuild the producer scaffold.\n## Notes\nbuilt',
    );
    writeFileSync(join(dir, 'plain.md'), '---\ntitle: not a goal\n---\nbody'); // no Q- id -> skipped
    const triples = extractGoalCards(dir);
    expect(triples).toHaveLength(1);
    expect(triples[0].situation).toBe('Starscream scaffold');
    expect(triples[0].choice).toBe('Build the producer scaffold.');
    expect(triples[0].outcome).toBeUndefined(); // doing is not terminal
  });
});
