import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { STABLE_SWITCH_VERSION } from '@shared/app-identity';
import { pickFreePorts } from '../free-port';
import { waitForHealth } from '../health';
import { generateSecrets } from '../secret-values';
import { materializeBundle, readLocalServerBundle } from './bundle';
import { runningCore, startCore, stopCore } from './core-process';
import { buildNativeCoreSettings, nativeApiUrl } from './core-settings';
import { nativeLayout } from './native-paths';
import { resolvePostgres } from './postgres-binaries';
import {
  initCluster,
  startCluster,
  stopCluster,
  syncPasswords,
  writeClusterConfig,
} from './postgres-cluster';
import { installSwitchCore } from './switch-core-install';
import { resolveUv } from './uv';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * The whole native toolchain against the network and a real PostgreSQL:
 * download what is missing, create the cluster, install the stable switch-core
 * pin and boot it until the gateway answers. Slow and online, so opt-in:
 *
 *   SWITCH_NATIVE_INTEGRATION=1 pnpm vitest run --project node native-toolchain
 *
 * Add SWITCH_LOCAL_SERVER_BUNDLE=$PWD/dist-local-server (after
 * `pnpm run build:local-server`) to run the packaged app's offline path.
 */
describe.skipIf(!process.env.SWITCH_NATIVE_INTEGRATION)('native toolchain', () => {
  let root = '';
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('boots switch-core on its own PostgreSQL', { timeout: 20 * 60 * 1000 }, async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'switch-native-'));
    const layout = nativeLayout(root);
    const log = (line: string) => process.stdout.write(`  ${line}\n`);
    const secrets = generateSecrets();
    const ports = await pickFreePorts();

    // With SWITCH_LOCAL_SERVER_BUNDLE set to a built bundle, the packaged
    // (offline) path; without, the download path.
    const shipped = await readLocalServerBundle(
      process.env.SWITCH_LOCAL_SERVER_BUNDLE ?? null,
      STABLE_SWITCH_VERSION
    );
    if (process.env.SWITCH_LOCAL_SERVER_BUNDLE) expect(shipped).not.toBeNull();
    // Run from a copy, as the app does, never from the bundle itself.
    const bundle = shipped && (await materializeBundle(shipped, layout.toolchain, log));
    if (bundle) expect(bundle.root.startsWith(layout.toolchain)).toBe(true);
    const uv = await resolveUv(layout, bundle, log);
    const postgres = await resolvePostgres(layout, bundle, log);
    const install = await installSwitchCore({
      layout,
      uv,
      bundle,
      version: STABLE_SWITCH_VERSION,
      owner: 'sandbox-quantum',
      repo: 'switch',
      checkoutRoot: null,
      onMessage: log,
    });

    const passwords = { owner: secrets.dbPassword, runtime: secrets.dbRuntimePassword };
    await initCluster(postgres, layout, passwords, () => {});
    await writeClusterConfig(layout, ports.postgres);
    await startCluster(postgres, layout, () => {});
    try {
      await startCore(
        layout,
        install,
        buildNativeCoreSettings({
          apiPort: ports.api,
          postgresPort: ports.postgres,
          callbackPort: ports.gateway,
          secrets,
          telemetryEnabled: false,
          telemetryEnvironment: 'local',
          telemetryInternal: false,
        })
      );
      expect(await waitForHealth(nativeApiUrl(ports.api), { timeoutMs: 120_000 })).toBe(true);
      expect(await runningCore(layout)).not.toBeNull();
    } finally {
      await stopCore(layout);
      await stopCluster(postgres, layout, () => {});
    }
    expect(await runningCore(layout)).toBeNull();

    // A second start goes through the restart path: passwords re-set with the
    // cluster stopped, then both processes back up on the same data.
    await syncPasswords(postgres, layout, passwords, () => {});
    await startCluster(postgres, layout, () => {});
    try {
      await startCore(
        layout,
        install,
        buildNativeCoreSettings({
          apiPort: ports.api,
          postgresPort: ports.postgres,
          callbackPort: ports.gateway,
          secrets,
          telemetryEnabled: false,
          telemetryEnvironment: 'local',
          telemetryInternal: false,
        })
      );
      expect(await waitForHealth(nativeApiUrl(ports.api), { timeoutMs: 120_000 })).toBe(true);
    } finally {
      await stopCore(layout);
      await stopCluster(postgres, layout, () => {});
    }
  });
});
