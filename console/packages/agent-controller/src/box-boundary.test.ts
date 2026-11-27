import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Box-only code lives in `src/box/` and the agent host's `box` subpath, and
 * desktop and self-installed machines must never load it. Nothing outside `src/box/` may import it
 * statically, except `import type`, which is erased from the build: the one
 * way in is a dynamic `import()` inside a box-mode branch, so the code is only
 * ever loaded once the controller is in box mode.
 */

const SRC = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'box' && dir === SRC ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Every static import or re-export's module name in `text` that stays in the
 * build: `import type` and `export type` are erased, and `import(...)` is not static.
 */
function staticImports(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /^\s*(import|export)\b(\s+type\b)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm
  ))
    if (!match[2]) names.push(match[3]!);
  for (const match of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) names.push(match[1]!);
  return names;
}

function isBoxOnly(name: string): boolean {
  return (
    name === '@switch-console/agent-providers/box' ||
    /^\.\/box(\/|$)/.test(name) ||
    /^(\.\.\/)+box(\/|$)/.test(name)
  );
}

describe('the box boundary', () => {
  it('finds static imports and re-exports, but not type-only or dynamic ones', () => {
    const text = [
      "import { a } from './box/a';",
      "import type { B } from '@switch-console/agent-providers/box';",
      "import { type F } from './box/f';",
      "export type { G } from './box/g';",
      "export { c } from './c';",
      "import './side-effect';",
      'import {',
      '  d,',
      "} from './d';",
      "const e = await import('./box/e');",
    ].join('\n');
    expect(staticImports(text)).toEqual([
      './box/a',
      './box/f', // only `import type` is surely erased
      './c',
      './d',
      './side-effect',
    ]);
  });

  it('keeps every module outside src/box/ from importing box-only code statically', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(20);
    const crossings = files.flatMap((file) =>
      staticImports(readFileSync(file, 'utf8'))
        .filter(isBoxOnly)
        .map((name) => `${relative(SRC, file)} -> ${name}`)
    );
    expect(crossings).toEqual([]);
  });
});
