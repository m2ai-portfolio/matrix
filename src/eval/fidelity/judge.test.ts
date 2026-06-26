// Tests for the Gemini judge prompt builder + reply parser (no network; realGeminiJudge not called).

import { describe, it, expect } from 'vitest';
import { buildPrompt, parseJudgeReply } from './judge.js';
import type { JudgeInput } from './predictors.js';

const input: JudgeInput = {
  article: 'a new article about an off-stack tool',
  domain: 'example.com',
  examples: [
    {
      content: 'prior article 1',
      verdict: 'up',
      notes: 'useful for current stack',
      domain: 'a.com',
    },
    { content: 'prior article 2', verdict: 'down', notes: 'shiny object', domain: 'b.com' },
  ],
};

describe('buildPrompt', () => {
  it('includes the examples with their verdicts + notes and asks for JSON', () => {
    const p = buildPrompt(input);
    expect(p).toContain('verdict: up');
    expect(p).toContain('verdict: down');
    expect(p).toContain('useful for current stack');
    expect(p).toContain('a new article about an off-stack tool');
    expect(p).toMatch(/JSON/i);
  });
});

describe('parseJudgeReply', () => {
  it('parses a bare JSON object', () => {
    expect(parseJudgeReply('{"verdict":"down","confidence":0.7}')).toEqual({
      verdict: 'down',
      confidence: 0.7,
    });
  });
  it('tolerates code fences and surrounding prose', () => {
    const out = parseJudgeReply('Sure!\n```json\n{"verdict": "up", "confidence": 0.9}\n```');
    expect(out.verdict).toBe('up');
    expect(out.confidence).toBe(0.9);
  });
  it('defaults a missing verdict to up and missing confidence to 0.5', () => {
    expect(parseJudgeReply('{"foo": 1}')).toEqual({ verdict: 'up', confidence: 0.5 });
  });
  it('throws when there is no JSON at all', () => {
    expect(() => parseJudgeReply('no json here')).toThrow();
  });
});
