// Test helper: strip line and block comments from TS source so a static
// safety check asserts against actual CODE, not explanatory prose. The safety
// claims (no live ccos-native default, no corpus/claudeclaw open, no
// Preact/Vite/Tailwind) are about what the code DOES; comments that name those
// forbidden tokens to explain why they are absent must not trip the check.
//
// This is a deliberately small, conservative stripper: it removes /* ... */
// blocks and // ... line comments. It does not attempt to preserve // or /*
// appearing inside string/regex literals, which is acceptable here because the
// files under test do not contain such literals on the same lines as the tokens
// being asserted.

export function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return noLine;
}
