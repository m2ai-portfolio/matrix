// Matrix Phase 1 — embedder seam.
// Spec claims: C-13, C-15, C-23. The real embedder vendors the CCOS gemini-embedding-001 call;
// tests NEVER call it — they inject a deterministic fake. This seam is what makes the build/test
// loop zero-network: every consumer (worker, search) takes an Embedder argument.

import { GoogleGenAI } from '@google/genai';

/** An embedder maps a text string to an embedding vector. Injectable for tests. */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * The canonical Gemini embedding model. Vendored verbatim from
 * ~/projects/claudeclaw-os/src/embeddings.ts — do NOT change this name or the dimension (3072).
 */
const EMBEDDING_MODEL = 'gemini-embedding-001';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  // Prefer the dedicated Gemini key (the owner's choice 2026-06-14); fall back to GOOGLE_API_KEY
  // for compatibility with the CCOS convention. Source ~/.env.shared before a live embed run.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No Gemini key set: export GEMINI_API_KEY (or GOOGLE_API_KEY) — source ~/.env.shared before a live embed run.',
    );
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * The real embedder: calls gemini-embedding-001 via @google/genai (C-13). This is the ONLY code
 * path that touches the network, and it is NEVER exercised in the build/test loop (C-23) — the
 * live 122k embed run is a separate, human-gated step that injects this implementation. Tests
 * inject a deterministic fake instead (C-15).
 */
export const realEmbedder: Embedder = async (text: string): Promise<number[]> => {
  const ai = getClient();
  const result = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });
  return result.embeddings?.[0]?.values ?? [];
};
