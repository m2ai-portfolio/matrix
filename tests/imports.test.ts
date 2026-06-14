// NodeNext ESM import hygiene — every relative import in src/**/*.ts ends in `.js`.
// Claims: C-33. The scan EXCLUDES the test files themselves (only src/ is scanned).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('NodeNext import hygiene (C-33)', () => {
  it('C-33: every relative import in src/**/*.ts uses a .js extension', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(here, '..', 'src'); // scans src/ ONLY, never this test file
    const files = walk(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const importRe = /(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(body)) !== null) {
        const spec = m[1];
        if (!spec.endsWith('.js')) offenders.push(`${f}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
