// Deterministic fake embedder for tests — ZERO network (C-15/C-23).
// Records calls so tests can assert the worker/search only ever use the INJECTED embedder.

import type { Embedder } from '../../src/embed/embedder.js';
import { EMBED_DIM } from '../../src/db/vec.js';

export interface RecordingEmbedder {
  embedder: Embedder;
  calls: string[];
  count(): number;
}

/**
 * A deterministic embedder: maps a text to a fixed 3072 vector derived from a stable hash of the
 * text, so equal text → equal vector (lets a query "match" a known turn). Never touches the network.
 */
export function makeFakeEmbedder(): RecordingEmbedder {
  const calls: string[] = [];
  const embedder: Embedder = async (text: string): Promise<number[]> => {
    calls.push(text);
    return vectorForText(text);
  };
  return { embedder, calls, count: () => calls.length };
}

/** A fake embedder that throws after `n` successful calls, to simulate a mid-run interruption (C-27). */
export function makeThrowingEmbedder(n: number): RecordingEmbedder {
  const calls: string[] = [];
  const embedder: Embedder = async (text: string): Promise<number[]> => {
    if (calls.length >= n) {
      throw new Error('simulated interruption');
    }
    calls.push(text);
    return vectorForText(text);
  };
  return { embedder, calls, count: () => calls.length };
}

/** Stable text → 3072 vector. Distinct texts get distinguishable vectors; equal texts are identical. */
export function vectorForText(text: string, dim = EMBED_DIM): number[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  const seed = (h % 100000) / 100000;
  const v: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * 1000 + i * 0.001);
  }
  return v;
}
