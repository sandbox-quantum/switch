import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecrets } from '../secret-values';
import { readLocalServerBundle } from './bundle';
import { CORE_ENV_FILE, renderEnv } from './core-process';
import { buildNativeCoreSettings } from './core-settings';
import {
  buildGatewayUi,
  checkoutGatewayUi,
  GATEWAY_UI_ENV,
  hasGatewayUiBuild,
  nativeAdminPages,
  runningServesAdminPages,
} from './gateway-ui';
import { nativeLayout } from './native-paths';
import { installSwitchCore } from './switch-core-install';
import { BUNDLE_FORMAT } from './toolchain-pins';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const unix = it.skipIf(process.platform === 'win32');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'switch-gateway-ui-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeBuild(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html>');
  await writeFile(path.join(dir, 'assets', 'app.js'), '');
}

async function writeExecutable(file: string, lines: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
}

function settingsWith(gatewayUiDir: string | null): Record<string, string> {
  return buildNativeCoreSettings({
    apiPort: 51001,
    postgresPort: 51002,
    callbackPort: 51003,
    secrets: generateSecrets(),
    telemetryEnabled: false,
    telemetryEnvironment: 'local',
    telemetryInternal: false,
    telemetryEndpoint: 'https://relay.example.test',
    gatewayUiDir,
  });
}

describe('core settings', () => {
  it('hands switch-core the pages when there are some', () => {
    expect(settingsWith('/srv/pages')[GATEWAY_UI_ENV]).toBe('/srv/pages');
  });

  it('leaves the setting out when there are none, which switch-core reads as off', () => {
    expect(settingsWith(null)).not.toHaveProperty(GATEWAY_UI_ENV);
  });
});

describe('finding a build', () => {
  it('needs an index.html, as switch-core does', async () => {
    const dir = path.join(root, 'dist');
    await mkdir(dir);
    expect(await hasGatewayUiBuild(dir)).toBe(false);
    await writeBuild(dir);
    expect(await hasGatewayUiBuild(dir)).toBe(true);
  });

  it("uses a checkout's own build, and nothing when it has none", async () => {
    expect(await checkoutGatewayUi(root)).toBeNull();
    await writeBuild(path.join(root, 'gateway', 'dist'));
    expect(await checkoutGatewayUi(root)).toBe(path.join(root, 'gateway', 'dist'));
  });
});

describe('what a running server serves', () => {
  const layout = () => nativeLayout(root);

  async function startedWith(settings: Record<string, string>): Promise<void> {
    await mkdir(layout().run, { recursive: true });
    await writeFile(path.join(layout().run, CORE_ENV_FILE), renderEnv(settings));
  }

  it('reads it off the environment the server was started with', async () => {
    expect(await runningServesAdminPages(layout())).toBe(false);
    await startedWith(settingsWith(null));
    expect(await runningServesAdminPages(layout())).toBe(false);
    await startedWith(settingsWith('/srv/pages'));
    expect(await runningServesAdminPages(layout())).toBe(true);
  });

  it('offers a restart only where one would bring the pages', async () => {
    await startedWith(settingsWith(null));
    expect(await nativeAdminPages(layout(), async () => true)).toBe('restart');
    expect(await nativeAdminPages(layout(), async () => false)).toBe('unavailable');
    await startedWith(settingsWith('/srv/pages'));
    expect(await nativeAdminPages(layout(), async () => false)).toBe('served');
  });
});

describe('the bundle', () => {
  async function writeBundle(dir: string, withPages: boolean): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ bundle: BUNDLE_FORMAT, switchVersion: '0.31.0', builtAt: 'now' })
    );
    await mkdir(path.join(dir, 'switch', 'src', 'core'), { recursive: true });
    if (withPages) await writeBuild(path.join(dir, 'switch', 'gateway-ui'));
  }

  it('names its pages, or none for a bundle built before it shipped them', async () => {
    await writeBundle(path.join(root, 'old'), false);
    await writeBundle(path.join(root, 'new'), true);
    expect((await readLocalServerBundle(path.join(root, 'old'), '0.31.0'))?.gatewayUi).toBeNull();
    expect((await readLocalServerBundle(path.join(root, 'new'), '0.31.0'))?.gatewayUi).toBe(
      path.join(root, 'new', 'switch', 'gateway-ui')
    );
  });

  unix(
    "installs the pages beside the server's own source, never serving them from the bundle",
    async () => {
      const bundleRoot = path.join(root, 'bundle');
      await writeBundle(bundleRoot, true);
      const bundle = await readLocalServerBundle(bundleRoot, '0.31.0');
      if (bundle === null) throw new Error('fixture bundle unreadable');
      // Stands in for uv: `venv <python> <dir>` makes the directory the
      // install writes its .pth file into; anything else succeeds silently.
      const uv = path.join(root, 'uv');
      await writeExecutable(uv, [
        'if [ "$1" = venv ]; then mkdir -p "$4/lib/python3.12/site-packages"; fi',
        'exit 0',
      ]);
      const layout = nativeLayout(path.join(root, 'server'));
      const install = await installSwitchCore({
        layout,
        uv: { path: uv, version: '0.0.0', source: 'installed' },
        bundle,
        version: '0.31.0',
        owner: 'example',
        repo: 'switch',
        checkoutRoot: null,
        buildGatewayUiFromSource: false,
        onMessage: () => {},
      });
      expect(install.gatewayUiDir).toBe(path.join(layout.switchCore, '0.31.0', 'gateway-ui'));
      expect(install.gatewayUiDir?.startsWith(bundleRoot)).toBe(false);
      expect(await hasGatewayUiBuild(install.gatewayUiDir ?? '')).toBe(true);
      // Gone from the app (an update replaced it): the server's copy stays.
      await rm(bundleRoot, { recursive: true, force: true });
      expect(await hasGatewayUiBuild(install.gatewayUiDir ?? '')).toBe(true);
    }
  );
});

describe('building the pages from source', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** Puts an `npm` on PATH that records its arguments and, on `run build`,
   * writes a build (or fails, with `fail`). */
  async function fakeNpm(fail = false): Promise<string> {
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'npm-calls');
    await writeExecutable(path.join(bin, 'npm'), [
      `echo "$@ NODE_ENV=$NODE_ENV" >> "${calls}"`,
      'if [ "$1" = ci ]; then mkdir -p node_modules; fi',
      fail
        ? 'if [ "$1" = run ]; then echo "vite: build failed" >&2; exit 1; fi'
        : 'if [ "$1" = run ]; then mkdir -p dist && echo ok > dist/index.html; fi',
      'exit 0',
    ]);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    return calls;
  }

  async function source(): Promise<string> {
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'gateway'), { recursive: true });
    await writeFile(path.join(src, 'gateway', 'package.json'), '{}');
    return src;
  }

  unix('installs, builds, keeps the build and drops the packages', async () => {
    const calls = await fakeNpm();
    const src = await source();
    const destination = path.join(root, 'gateway-ui');
    process.env.NODE_ENV = 'production';
    try {
      const built = await buildGatewayUi({
        layout: nativeLayout(root),
        sourceRoot: src,
        destination,
        onMessage: () => {},
      });
      expect(built).toBe(destination);
    } finally {
      delete process.env.NODE_ENV;
    }
    expect(await hasGatewayUiBuild(destination)).toBe(true);
    const lines = (await readFile(calls, 'utf8')).trim().split('\n');
    // Dev dependencies hold the build tools: npm must not drop them.
    expect(lines).toEqual(['ci --no-audit --no-fund NODE_ENV=', 'run build NODE_ENV=']);
    expect(await hasGatewayUiBuild(path.join(src, 'gateway', 'node_modules'))).toBe(false);
  });

  unix('reports a failed build and carries on without the pages', async () => {
    await fakeNpm(true);
    const src = await source();
    const messages: string[] = [];
    const built = await buildGatewayUi({
      layout: nativeLayout(root),
      sourceRoot: src,
      destination: path.join(root, 'gateway-ui'),
      onMessage: (message) => messages.push(message),
    });
    expect(built).toBeNull();
    expect(messages.at(-1)).toMatch(/starts without them/);
    const buildLog = await readFile(
      path.join(nativeLayout(root).logs, 'gateway-build.log'),
      'utf8'
    );
    expect(buildLog).toContain('vite: build failed');
  });

  it('has nothing to build from a source without the gateway', async () => {
    expect(
      await buildGatewayUi({
        layout: nativeLayout(root),
        sourceRoot: root,
        destination: path.join(root, 'gateway-ui'),
        onMessage: () => {},
      })
    ).toBeNull();
  });
});
