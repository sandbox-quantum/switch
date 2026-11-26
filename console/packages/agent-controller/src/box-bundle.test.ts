import { describe, expect, it } from 'vitest';
import {
  assertBoxBundle,
  assertDesktopBundle,
  boxModules,
  isBoxModule,
  staticBoxImports,
} from '../scripts/box-bundle.mjs';

type Edge = { path: string; kind: string; external?: boolean };
const meta = (inputs: Record<string, Edge[]>) => ({
  inputs: Object.fromEntries(Object.entries(inputs).map(([path, imports]) => [path, { imports }])),
});

describe('isBoxModule', () => {
  it.each([
    '../../packages/agent-providers/src/host/box/index.ts',
    '../agent-providers/src/host/box/valve.ts',
    'src/box/gateway.ts',
    '../../packages/agent-controller/src/box/launcher.ts',
    '../agent-providers/dist/box.mjs',
  ])('counts %s as box-only', (path) => expect(isBoxModule(path)).toBe(true));

  it.each([
    '../../packages/agent-providers/src/host/session-host.ts',
    'src/controller.ts',
    '../../node_modules/some-lib/src/box/x.js',
    'src/boxes.ts',
    '../agent-providers/dist/index.mjs',
    '../agent-providers/dist/server-AzOpuQgI.mjs',
  ])('does not count %s', (path) => expect(isBoxModule(path)).toBe(false));
});

describe('a desktop bundle', () => {
  it('may reach box code only through a dynamic import', () => {
    const ok = meta({
      'src/controller.ts': [{ path: 'src/box/launcher.ts', kind: 'dynamic-import' }],
      'src/box/launcher.ts': [{ path: 'src/box/gateway.ts', kind: 'import-statement' }],
      'src/box/gateway.ts': [],
    });
    expect(staticBoxImports(ok)).toEqual([]);
    expect(() => assertDesktopBundle(ok, 'agent-controller.mjs')).not.toThrow();
  });

  it('is refused when anything outside box/ imports box code statically', () => {
    const bad = meta({
      'src/controller.ts': [{ path: 'src/box/launcher.ts', kind: 'import-statement' }],
      '../agent-providers/src/index.ts': [
        { path: '../agent-providers/src/host/box/index.ts', kind: 'require-call' },
      ],
      'src/box/launcher.ts': [],
      '../agent-providers/src/host/box/index.ts': [],
    });
    expect(staticBoxImports(bad)).toEqual([
      'src/controller.ts -> src/box/launcher.ts (import-statement)',
      '../agent-providers/src/index.ts -> ../agent-providers/src/host/box/index.ts (require-call)',
    ]);
    expect(() => assertDesktopBundle(bad, 'agent-controller.mjs')).toThrow(
      'agent-controller.mjs imports box-only code outside a dynamic import'
    );
  });
});

describe('a box bundle', () => {
  it('must hold box code', () => {
    const none = meta({ 'src/controller.ts': [] });
    expect(boxModules(none)).toEqual([]);
    expect(() => assertBoxBundle(none, 'cli.mjs')).toThrow('cli.mjs has no box-only code in it');
    const some = meta({ 'src/controller.ts': [], 'src/box/launcher.ts': [] });
    expect(() => assertBoxBundle(some, 'cli.mjs')).not.toThrow();
  });
});
