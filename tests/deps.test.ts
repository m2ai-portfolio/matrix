// Dependency pin check — sqlite-vec 0.1.9 and @google/genai 2.8.0 (versions verified via npm view).
// Claims: C-31.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

describe('dependency pins (C-31)', () => {
  it('C-31: package.json pins sqlite-vec 0.1.9 and @google/genai 2.8.0', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..');
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    expect(deps['sqlite-vec']).toBeDefined();
    expect(deps['sqlite-vec']).toContain('0.1.9');
    expect(deps['@google/genai']).toBeDefined();
    expect(deps['@google/genai']).toContain('2.8.0');
  });
});
