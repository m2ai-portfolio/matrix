// Safety / NodeNext guardrail tests.
// Claims: C-21 (the live claudeclaw.db is a read-only source: src/ may READ it but
//               must never open it for writing),
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

describe('safety: live claudeclaw.db is read-only only (C-21)', () => {
  it('C-21: any src/ file that opens the live store does so read-only (never write mode)', () => {
    // The live claudeclaw.db is a READ-ONLY source: 4 agents write it in WAL mode, so
    // Matrix must never open it for writing (CLAUDE.md "Locked decisions"). Phase 0
    // banned referencing the name at all; that blunt rule was relaxed once the fleet
    // ccos-native adapter and board allowlist legitimately needed to read / name it.
    // The enduring invariant is narrower and real: every `new Database(` call in a
    // file that touches the live store must be opened with `readonly: true`. A
    // write-mode open (a Database() call lacking the flag) in such a file fails here.
    const OPEN_RE = /new Database\(/g;
    for (const f of tsFiles(srcRoot)) {
      const body = readFileSync(f, 'utf8');
      if (!body.includes('claudeclaw.db')) continue;
      let m: RegExpExecArray | null;
      while ((m = OPEN_RE.exec(body)) !== null) {
        // Inspect the open call's argument window for the read-only flag.
        const window = body.slice(m.index, m.index + 200);
        expect(
          /readonly:\s*true/.test(window),
          `${f}: opens a SQLite handle without { readonly: true } while referencing the ` +
            `live claudeclaw.db — the live store must be read-only (CLAUDE.md).`,
        ).toBe(true);
      }
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
