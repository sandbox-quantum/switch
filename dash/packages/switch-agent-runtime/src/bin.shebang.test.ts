import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The interpreter this is published against.
 *
 * `npx` runs the `bin` under node, always — that is what npx is. A shebang
 * naming anything else makes the package unstartable on every host that does
 * not happen to have that interpreter, and the failure is `exit 127` from
 * `/usr/bin/env`, which says nothing about which package or why.
 *
 * This is not hypothetical: 0.1.1 shipped `#!/usr/bin/env bun`, left behind
 * when the server moved from `Bun.serve` to `node:http`. The code was correct
 * and the artifact would not start.
 */
const SHEBANG = '#!/usr/bin/env node';

const PKG_ROOT = join(import.meta.dirname, '..');

describe('bin shebang', () => {
  it('names node in source', () => {
    const source = readFileSync(join(PKG_ROOT, 'src/bin.ts'), 'utf8');
    expect(source.split('\n', 1)[0]).toBe(SHEBANG);
  });

  // The built artifact is what actually ships, so check it when it exists —
  // it always does in CI, which builds before publishing. Absent locally, the
  // source assertion above already covers the mistake anyone is likely to make.
  it('carries the shebang through the build', () => {
    const dist = join(PKG_ROOT, 'dist/bin.mjs');
    if (!existsSync(dist)) return;
    expect(readFileSync(dist, 'utf8').split('\n', 1)[0]).toBe(SHEBANG);
  });
});
