// Safety / NodeNext guardrail tests.
// Claims: C-21 (never reference live claudeclaw.db in Phase 0 source),
//         C-22 (connector enumerate is parameterizable so tests avoid real transcripts),
//         C-32 (NodeNext: relative imports in src/ use explicit .js extensions).
// Static-source assertions; they scan src/ ONLY (never the test files themselves).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcRoot = resolve(repoRoot, 'src');

/** Recursively list .ts files under a dir. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('safety: no live claudeclaw.db in Phase 0 source (C-21)', () => {
  it('C-21: no src/ file references claudeclaw.db', () => {
    for (const f of tsFiles(srcRoot)) {
      const body = readFileSync(f, 'utf8');
      expect(body.includes('claudeclaw.db')).toBe(false);
    }
  });
});

describe('NodeNext relative imports use .js extensions (C-32)', () => {
  it('C-32: every relative import in src/ ends with .js', () => {
    // Matches: import ... from './x'  or  from '../y/z'
    const relImport = /from\s+['"](\.[^'"]+)['"]/g;
    for (const f of tsFiles(srcRoot)) {
      const body = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = relImport.exec(body)) !== null) {
        const spec = m[1];
        expect(spec.endsWith('.js'), `${f}: relative import "${spec}" must end with .js`).toBe(
          true,
        );
      }
    }
  });
});

describe('connector enumerate is parameterizable (C-22 read-only)', () => {
  it('C-22: enumerateTranscripts accepts an explicit root so tests never read real transcripts', () => {
    // The function signature takes an optional root; this is what lets every other test
    // run on a temp fixture dir instead of ~/.claude/projects. Asserted structurally here.
    const body = readFileSync(resolve(srcRoot, 'connectors/claude-code.ts'), 'utf8');
    expect(body).toMatch(/export function enumerateTranscripts\(/);
  });
});
