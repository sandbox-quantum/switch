import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { STABLE_SWITCH_VERSION } from '@shared/app-identity';
import { bundledComposeYaml } from '../bundled-compose';
import { composeDown, composeUpService, runDocker, serviceContainerId } from '../compose';
import { COMPOSE_FILE_NAME, ENV_FILE_NAME } from '../constants';
import { buildEnvFile } from '../env-file';
import { pickFreePorts } from '../free-port';
import type { ServerHost } from '../host/types';
import { generateSecrets } from '../secret-values';
import { exportDockerStack, importIntoCluster } from './migrate-from-docker';
import { nativeLayout } from './native-paths';
import { resolvePostgres } from './postgres-binaries';
import { initCluster, startCluster, stopCluster, writeClusterConfig } from './postgres-cluster';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * The move off Docker against a real compose stack: data written into the
 * stack's Postgres comes out the other side in a native cluster. Needs Docker
 * and the network, so opt-in:
 *
 *   SWITCH_MIGRATION_INTEGRATION=1 pnpm vitest run --project node migrate-from-docker
 */
describe.skipIf(!process.env.SWITCH_MIGRATION_INTEGRATION)('moving off Docker', () => {
  let root = '';
  let host: ServerHost | null = null;
  afterAll(async () => {
    if (host) await composeDown(host, true).catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('carries the databases into a native cluster', { timeout: 20 * 60 * 1000 }, async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'switch-move-'));
    const ports = await pickFreePorts();
    const secrets = generateSecrets();
    const project = `switchmovetest${process.pid}`;
    host = {
      kind: 'local',
      ctx: new LocalExecutionContext({ root }),
      dockerBin: 'docker',
      composeProjectName: project,
      workingDir: root,
      stateDir: root,
      secretsKey: 'unused',
      label: 'this computer',
      sharedState: null,
      writeFile: async (rel, content) => writeFile(path.join(root, rel), content),
      readFile: async (rel) => {
        try {
          return (await import('node:fs/promises')).readFile(path.join(root, rel), 'utf8');
        } catch {
          return null;
        }
      },
      removeFile: async () => {},
      restrictMode: async () => {},
      streamCommand: async () => {},
      detectDocker: async () => ({ available: true, version: 'test' }),
      pickFreePorts: async () => ports,
      establishNetworking: async () => {},
      checkNetworking: async () => {},
      teardownNetworking: async () => {},
      dispose: () => {},
    };
    await writeFile(path.join(root, COMPOSE_FILE_NAME), bundledComposeYaml());
    await writeFile(
      path.join(root, ENV_FILE_NAME),
      buildEnvFile({
        version: STABLE_SWITCH_VERSION,
        registry: 'ghcr.io',
        namespace: 'sandbox-quantum',
        ports,
        secrets,
        telemetryEnabled: false,
        telemetryEnvironment: 'local',
        telemetryInternal: false,
      })
    );

    // A stack's database with something in each of its two databases.
    await composeUpService(host, 'postgres');
    const container = await serviceContainerId(host, 'postgres');
    const psql = (db: string, sql: string) =>
      runDocker(
        host!,
        ['exec', container, 'psql', '-U', 'postgres', '-d', db, '-tAc', sql],
        60_000
      );
    await psql('postgres', 'CREATE DATABASE mattermost');
    await psql('switch', 'CREATE TABLE agents (id int primary key, name text)');
    await psql('switch', "INSERT INTO agents VALUES (1, 'kept')");
    await psql('mattermost', 'CREATE TABLE posts (id int)');
    await psql('mattermost', 'INSERT INTO posts VALUES (7)');

    const layout = nativeLayout(root);
    const exported = await exportDockerStack(host, layout, () => {});
    expect(exported.dumps.map((dump) => dump.database).sort()).toEqual(['mattermost', 'switch']);

    const postgres = await resolvePostgres(layout, null, () => {});
    const passwords = { owner: secrets.dbPassword, runtime: secrets.dbRuntimePassword };
    await initCluster(postgres, layout, passwords, () => {});
    await writeClusterConfig(layout, ports.postgres);
    await startCluster(postgres, layout, () => {});
    try {
      await importIntoCluster(
        exported,
        ports.postgres,
        secrets.dbPassword,
        () => {},
        () => {}
      );
      const query = (db: string, sql: string) =>
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'host',
            '-e',
            'PGPASSWORD',
            'postgres:16-alpine',
            'psql',
            '-h',
            '127.0.0.1',
            '-p',
            String(ports.postgres),
            '-U',
            'postgres',
            '-d',
            db,
            '-tAc',
            sql,
          ],
          { env: { ...process.env, PGPASSWORD: secrets.dbPassword }, encoding: 'utf8' }
        ).trim();
      expect(query('switch', 'SELECT name FROM agents WHERE id = 1')).toBe('kept');
      expect(query('mattermost', 'SELECT id FROM posts')).toBe('7');
    } finally {
      await stopCluster(postgres, layout, () => {});
    }
  });
});
