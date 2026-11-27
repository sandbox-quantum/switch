import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDesktopBundle, boxEvaluationGuard } from '../scripts/box-bundle.mjs';

/**
 * The desktop's controller and shared host, bundled as Switch Console bundles
 * them (`build-sidecar.mjs`: one file each, no splitting), with every box
 * module made to throw when its code runs. Run without `--box`, they must never
 * evaluate one; and their import graph must reach box code only through a
 * dynamic `import()`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const providers = join(root, '..', 'agent-providers');
let out: string;
const metafiles: Record<string, Metafile> = {};

async function bundle(name: string, entry: string, tsconfig: string): Promise<string> {
  const outfile = join(out, name);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    tsconfig,
    metafile: true,
    logLevel: 'silent',
    plugins: [boxEvaluationGuard],
    banner: {
      js: "import { createRequire as createGuardRequire } from 'node:module'; const require = createGuardRequire(import.meta.url);",
    },
  });
  metafiles[name] = result.metafile;
  return outfile;
}

function run(file: string, args: string[]) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: out,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SWITCH_CONTROLLER_LOG_LEVEL: 'error' },
  });
}

let cli: string;
let sharedHost: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'box-bundle-'));
  cli = await bundle(
    'agent-controller.mjs',
    join(root, 'src', 'cli.ts'),
    join(root, 'tsconfig.json')
  );
  sharedHost = await bundle(
    'shared-host.mjs',
    join(providers, 'src', 'host', 'shared-daemon.ts'),
    join(providers, 'tsconfig.json')
  );
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the desktop bundles', () => {
  it('reach box code only through a dynamic import', () => {
    for (const [name, metafile] of Object.entries(metafiles))
      expect(() => assertDesktopBundle(metafile, name)).not.toThrow();
  });

  it('never evaluate a box module in a desktop run of the controller', () => {
    for (const args of [
      ['--version'],
      ['--protocol'],
      ['help'],
      ['status', '--data-dir', join(out, 'data')],
    ]) {
      const result = run(cli, args);
      expect(`${result.stdout}${result.stderr}`).not.toContain('box module evaluated');
      expect(result.error).toBeUndefined();
    }
  });

  it('never evaluate a box module in the shared host, desktop config or provider check', () => {
    for (const args of [
      [join(out, 'host'), join(out, 'no-such-config.json')],
      ['--probe', 'claude', out, join(out, 'no-such-cli')],
    ]) {
      const result = run(sharedHost, args);
      expect(`${result.stdout}${result.stderr}`).not.toContain('box module evaluated');
    }
  });
});

describe('the guard itself', () => {
  it('fails a run that evaluates a box module, and only that one', async () => {
    const fixture = join(out, 'fixture');
    mkdirSync(join(fixture, 'src', 'box'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'box', 'feature.ts'), 'export const feature = 1;\n');
    writeFileSync(
      join(fixture, 'src', 'lazy.ts'),
      "export async function load() { return import('./box/feature'); }\nconsole.log('lazy ok');\n"
    );
    writeFileSync(
      join(fixture, 'src', 'eager.ts'),
      "import { feature } from './box/feature';\nconsole.log(feature);\n"
    );
    const make = async (name: string) => {
      const outfile = join(out, `${name}.mjs`);
      const result = await build({
        entryPoints: [join(fixture, 'src', `${name}.ts`)],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile,
        metafile: true,
        logLevel: 'silent',
        plugins: [boxEvaluationGuard],
      });
      return { outfile, metafile: result.metafile };
    };
    const lazy = await make('lazy');
    expect(run(lazy.outfile, []).stdout).toContain('lazy ok');
    expect(() => assertDesktopBundle(lazy.metafile, 'lazy.mjs')).not.toThrow();
    const eager = await make('eager');
    expect(run(eager.outfile, []).stderr).toContain('box module evaluated outside box mode');
    expect(() => assertDesktopBundle(eager.metafile, 'eager.mjs')).toThrow('imports box-only code');
  });
});
