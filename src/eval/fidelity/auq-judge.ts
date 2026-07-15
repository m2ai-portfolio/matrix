// Matrix forced-choice fidelity eval (AUQ lane): real Gemini forced-choice judge.
// See ./AUQ-CONTRACT.md. This is the ONLY network path in the AUQ lane and is NEVER exercised by the
// build/test loop (tests inject a deterministic fake ChoiceJudge). The live run is a gated step: it
// needs GEMINI_API_KEY and an explicit model id (verified via /chub, never hardcoded from memory).
//
// NodeNext ESM: imports use the .js extension even though the source is .ts.

import { GoogleGenAI } from '@google/genai';
import type {
  ChoiceJudge,
  ChoiceJudgeInput,
  ChoiceJudgeOutput,
  ChoiceExample,
} from './auq-predictors.js';

/** Bound the prompt: situations and labels are short, but a stray long label cannot blow the budget. */
function clip(text: string, max = 600): string {
  return text.length <= max ? text : text.slice(0, max) + ' [...]';
}

function renderOptions(options: string[]): string {
  return options.map((o, i) => `  [${i}] ${clip(o, 300)}`).join('\n');
}

function renderExample(ex: ChoiceExample, i: number): string {
  return [
    `Prior decision ${i + 1}:`,
    `  situation: ${clip(ex.situation, 400)}`,
    `  options:`,
    renderOptions(ex.options),
    `  the owner picked: [${ex.chosenIdx}] ${clip(ex.options[ex.chosenIdx] ?? '', 200)}`,
  ].join('\n');
}

/** Build the forced-choice judge prompt: the owner's prior picks, then the new situation to predict. */
export function buildChoicePrompt(input: ChoiceJudgeInput): string {
  const examples = input.examples.map(renderExample).join('\n\n');
  return [
    'You are predicting which option the owner, an AI engineer, would choose when a question is put',
    'to him with a fixed set of options. Predict HIS pick, not the objectively "best" answer: he',
    'often deviates from the recommended option when it does not fit his stack, cost posture, or taste.',
    '',
    input.examples.length > 0
      ? 'Here is his prior choosing behaviour on similar decisions:\n\n' + examples + '\n'
      : '(no prior examples provided for this prediction)\n',
    'Now predict his pick for this NEW decision.',
    `situation: ${clip(input.situation, 600)}`,
    'options:',
    renderOptions(input.options),
    '',
    `Respond with ONLY a JSON object: {"chosenIdx": <integer 0..${input.options.length - 1}>}.`,
    'chosenIdx is the index of the option you predict the owner picked.',
  ].join('\n');
}

/** In-range integer or null. Centralizes the range check used by both parse paths. */
function inRangeIdx(value: number, n: number): number | null {
  return Number.isInteger(value) && value >= 0 && value < n ? value : null;
}

/**
 * Parse the judge reply into a chosen index, tolerating code fences and stray prose. Resilient over
 * a long LOO run: a present-but-malformed object (e.g. Gemini's unquoted `{chosenIdx: 2}`) must not
 * abort the eval, so JSON.parse failures fall back to extracting the first integer after "chosenIdx",
 * then to the first option (index 0). Only a reply with NO object at all throws.
 */
export function parseChoiceReply(text: string, n: number): ChoiceJudgeOutput {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`choice-judge reply had no JSON object: ${text.slice(0, 120)}`);
  }
  try {
    const obj = JSON.parse(match[0]) as { chosenIdx?: unknown };
    const idx = typeof obj.chosenIdx === 'number' ? obj.chosenIdx : Number(obj.chosenIdx);
    const ok = inRangeIdx(idx, n);
    if (ok !== null) return { chosenIdx: ok };
  } catch {
    // malformed JSON (unquoted key, trailing prose): fall through to the integer-extraction fallback
  }
  const m = match[0].match(/chosenidx\D*(\d+)/i);
  if (m) {
    const ok = inRangeIdx(Number(m[1]), n);
    if (ok !== null) return { chosenIdx: ok };
  }
  return { chosenIdx: 0 }; // out-of-range / unparseable: fall back to the first option
}

export interface GeminiChoiceJudgeOptions {
  /** Model id. REQUIRED and verified via /chub before the live run; never defaulted from memory. */
  model: string;
  /** Override the API key lookup (defaults to GEMINI_API_KEY then GOOGLE_API_KEY). */
  apiKey?: string;
}

/**
 * The real Gemini forced-choice judge. Vendors the same key convention + SDK as src/embed/embedder.ts
 * and src/eval/fidelity/judge.ts. Returns a ChoiceJudge closure so the predictor stays testable.
 */
export function realGeminiChoiceJudge(opts: GeminiChoiceJudgeOptions): ChoiceJudge {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No Gemini key set: export GEMINI_API_KEY (or GOOGLE_API_KEY), source ~/.env.shared before a live judge run.',
    );
  }
  if (!opts.model) {
    throw new Error(
      'realGeminiChoiceJudge requires an explicit model id (verify via /chub first).',
    );
  }
  const ai = new GoogleGenAI({ apiKey });

  return async (input: ChoiceJudgeInput): Promise<ChoiceJudgeOutput> => {
    const result = await ai.models.generateContent({
      model: opts.model,
      contents: buildChoicePrompt(input),
    });
    const text = result.text ?? '';
    return parseChoiceReply(text, input.options.length);
  };
}
