// Matrix v1 decision-fidelity eval: real Gemini LLM-judge.
// See ./CONTRACT.md. This is the ONLY network path in the eval and is NEVER exercised by the
// build/test loop (tests inject a deterministic fake Judge). The live judge run is a gated step:
// it needs GEMINI_API_KEY and an explicit model id (verified via /chub, never hardcoded from memory).
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { GoogleGenAI } from '@google/genai';
import type { Verdict } from './dataset.js';
import type { Judge, JudgeExample, JudgeInput, JudgeOutput } from './predictors.js';

/** Truncate long article bodies so the prompt stays bounded; grades cap ~2.2k chars anyway. */
function clip(text: string, max = 1500): string {
  return text.length <= max ? text : text.slice(0, max) + ' [...]';
}

function renderExample(ex: JudgeExample, i: number): string {
  return [
    `Example ${i + 1} (domain: ${ex.domain}) -> verdict: ${ex.verdict}`,
    `  article: ${clip(ex.content, 600)}`,
    `  the owner's note: ${ex.notes || '(none)'}`,
  ].join('\n');
}

/** Build the judge prompt: the owner's prior grading behavior, then the new article to predict. */
export function buildPrompt(input: JudgeInput): string {
  const examples = input.examples.map(renderExample).join('\n\n');
  return [
    'You are predicting how the owner, an AI engineer, would grade a newly discovered article.',
    'He thumbs UP an article when it is useful and applicable to his current stack/projects and',
    'actionable now; he thumbs DOWN when it is off-stack, not actionable, or shiny-object noise.',
    '',
    'Here is his prior grading behavior on similar articles:',
    '',
    examples || '(no prior examples available)',
    '',
    `Now predict his verdict for this NEW article (domain: ${input.domain}):`,
    clip(input.article),
    '',
    'Respond with ONLY a JSON object: {"verdict": "up" | "down", "confidence": <number 0..1>}.',
    'confidence is how sure YOU are of the verdict you chose.',
  ].join('\n');
}

/** Parse the judge reply into a verdict + confidence, tolerating code fences and stray prose. */
export function parseJudgeReply(text: string): JudgeOutput {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`judge reply had no JSON object: ${text.slice(0, 120)}`);
  }
  const obj = JSON.parse(match[0]) as { verdict?: unknown; confidence?: unknown };
  const verdict: Verdict = obj.verdict === 'down' ? 'down' : 'up';
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
  return { verdict, confidence };
}

export interface GeminiJudgeOptions {
  /** Model id. REQUIRED and verified via /chub before the live run; never defaulted from memory. */
  model: string;
  /** Override the API key lookup (defaults to GEMINI_API_KEY then GOOGLE_API_KEY). */
  apiKey?: string;
}

/**
 * The real Gemini judge. Vendors the same key convention + SDK as src/embed/embedder.ts.
 * Returns a Judge closure so the predictor stays vendor-agnostic and testable.
 */
export function realGeminiJudge(opts: GeminiJudgeOptions): Judge {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No Gemini key set: export GEMINI_API_KEY (or GOOGLE_API_KEY), source ~/.env.shared before a live judge run.',
    );
  }
  if (!opts.model) {
    throw new Error('realGeminiJudge requires an explicit model id (verify via /chub first).');
  }
  const ai = new GoogleGenAI({ apiKey });

  return async (input: JudgeInput): Promise<JudgeOutput> => {
    const result = await ai.models.generateContent({
      model: opts.model,
      contents: buildPrompt(input),
    });
    const text = result.text ?? '';
    return parseJudgeReply(text);
  };
}
