// Matrix Phase 1 — embedder seam.
// Spec claims: C-13, C-15, C-23. The real embedder calls DeepInfra's OpenAI-compatible
// embeddings endpoint (Qwen/Qwen3-Embedding-8B, 4096-dim; migrated off gemini-embedding-001
// 2026-07-12, see ~/notes/reports/gemini-replacement-cost-analysis-2026-07-12.md); tests NEVER
// call it, they inject a deterministic fake. This seam is what makes the build/test loop
// zero-network: every consumer (worker, search) takes an Embedder argument.

/** An embedder maps a text string to an embedding vector. Injectable for tests. */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * The canonical embedding model (GROUND TRUTH 2026-07-12, verified live against DeepInfra:
 * 4096-dim). Must stay in lockstep with EMBED_MODEL / EMBED_DIM in src/db/vec.ts.
 */
const EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-8B';

const ENDPOINT = 'https://api.deepinfra.com/v1/openai/embeddings';

/**
 * Qwen3-Embedding-8B accepts up to ~32k tokens; the warehouse holds outlier turns far past that
 * (max ~537k chars). Gemini truncated long input silently; an OpenAI-compatible endpoint may 400
 * instead, which would abort the pool. Truncate defensively: ~60k chars is ~15-25k tokens
 * depending on content, and embedding quality past that adds nothing for retrieval.
 */
const MAX_EMBED_CHARS = 60_000;

function getKey(): string {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No DeepInfra key set: export DEEPINFRA_API_KEY (source ~/.env.shared before a live embed run).',
    );
  }
  return apiKey;
}

/**
 * The real embedder: calls Qwen/Qwen3-Embedding-8B via DeepInfra's OpenAI-compatible endpoint
 * (C-13). This is the ONLY code path that touches the network, and it is NEVER exercised in the
 * build/test loop (C-23): live embed runs are a separate, human-gated step that injects this
 * implementation. Tests inject a deterministic fake instead (C-15).
 */
export const realEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      // An empty string is rejected by the endpoint; a single space embeds to a valid vector.
      input: text.slice(0, MAX_EMBED_CHARS) || ' ',
      encoding_format: 'float',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepInfra embed HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  return json.data?.[0]?.embedding ?? [];
};

/**
 * Wraps an embedder to handle context-length errors from providers like DeepInfra that return
 * HTTP 400 "input tokens exceeds context length". On such an error the input is halved and
 * retried up to maxHalvings times. For all other errors the throw propagates unchanged.
 *
 * This is composable: `withContextFallback(withRetry(realEmbedder))`. realEmbedder already caps
 * every call at MAX_EMBED_CHARS, which for normal-density text (~4.9 chars/token) is ~12k tokens,
 * well under the 40960-token limit; this wrapper is the safety net for pathologically dense rows
 * (dense code / base64) where even the 60k-char slice can exceed the context window.
 */
export function withContextFallback(e: Embedder, maxHalvings = 3): Embedder {
  return async (text: string): Promise<number[]> => {
    // Start the halving ladder at MAX_EMBED_CHARS: realEmbedder caps every call there, so halving
    // the *original* length is a no-op while it stays above the cap (the endpoint keeps seeing a
    // 60k slice and 400s, wasting a halving each time), and a very long row would exhaust
    // maxHalvings before ever dropping below the cap. Starting at the cap makes the first halving
    // shrink what the endpoint actually receives — a 200k row embeds after one halving (60k -> 30k).
    let input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
    for (let attempt = 0; attempt <= maxHalvings; attempt++) {
      try {
        return await e(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          (msg.includes('context length') || msg.includes('input tokens')) &&
          attempt < maxHalvings
        ) {
          input = input.slice(0, Math.floor(input.length / 2));
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop above either returns or throws.
    throw new Error('[embed] withContextFallback: exhausted halvings');
  };
}
