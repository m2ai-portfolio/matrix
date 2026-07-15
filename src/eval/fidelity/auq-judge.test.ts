// Tests for the AUQ forced-choice judge prompt + reply parser. Pure: no network, no SDK call.

import { describe, it, expect } from 'vitest';
import { buildChoicePrompt, parseChoiceReply } from './auq-judge.js';

describe('buildChoicePrompt', () => {
  it('renders options with indices and omits the example block when zero-shot', () => {
    const prompt = buildChoicePrompt({
      situation: 'Pick a deploy target?',
      options: ['Render', 'Railway'],
      examples: [],
    });
    expect(prompt).toContain('[0] Render');
    expect(prompt).toContain('[1] Railway');
    expect(prompt).toContain('no prior examples');
    expect(prompt).toContain('"chosenIdx"');
  });

  it('includes retrieved prior picks as labeled examples when present', () => {
    const prompt = buildChoicePrompt({
      situation: 'New decision?',
      options: ['A', 'B'],
      examples: [{ situation: 'Old decision?', options: ['A', 'B'], chosenIdx: 1 }],
    });
    expect(prompt).toContain('prior choosing behaviour');
    expect(prompt).toContain('the owner picked: [1] B');
  });
});

describe('parseChoiceReply', () => {
  it('parses a plain JSON object', () => {
    expect(parseChoiceReply('{"chosenIdx": 2}', 3)).toEqual({ chosenIdx: 2 });
  });
  it('tolerates code fences and stray prose', () => {
    expect(parseChoiceReply('Sure:\n```json\n{"chosenIdx": 1}\n```', 2)).toEqual({ chosenIdx: 1 });
  });
  it('falls back to 0 on an out-of-range index', () => {
    expect(parseChoiceReply('{"chosenIdx": 9}', 2)).toEqual({ chosenIdx: 0 });
  });
  it('recovers the index from a malformed object with an unquoted key (Gemini quirk)', () => {
    expect(parseChoiceReply('{chosenIdx: 2}', 3)).toEqual({ chosenIdx: 2 });
  });
  it('recovers the index from a malformed object with trailing prose', () => {
    expect(parseChoiceReply('{"chosenIdx": 1, because it fits}', 2)).toEqual({ chosenIdx: 1 });
  });
  it('throws when there is no JSON object', () => {
    expect(() => parseChoiceReply('no json here', 2)).toThrow();
  });
});
