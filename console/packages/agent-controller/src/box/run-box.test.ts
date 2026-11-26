import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../errors';
import { silentLogger } from '../log';
import { dataLayout } from '../paths';
import { ProviderRechecks } from '../provider-rechecks';
import { boxRunFlags, boxStatusFlags, checkBoxRunFlags, prepareBoxRun } from './run-box';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-box-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('box flags', () => {
  it('keeps only the box flags, each held to its type', () => {
    expect(boxRunFlags({ 'agents-workspaces': '/w', 'test-box': true, 'data-dir': '/d' })).toEqual({
      'agents-workspaces': '/w',
      'test-box': true,
    });
    expect(() => boxRunFlags({ 'operator-exec': 'yes' })).toThrow(UsageError);
    expect(boxStatusFlags({ live: true, 'live-dir': '/l', 'data-dir': '/d' })).toEqual({
      live: true,
      'live-dir': '/l',
    });
  });

  it('refuses operator exec outside a split test box, whatever else is set', () => {
    expect(() => checkBoxRunFlags({ 'operator-exec': true }, 'default', {})).toThrow(
      /--operator-exec is for test boxes only/
    );
    expect(() =>
      checkBoxRunFlags({ 'operator-exec': true, 'test-box': true }, 'default', {})
    ).toThrow(/--operator-exec is for test boxes only/);
  });

  it('takes the gateway proxy out of the environment, and refuses it off a split box', () => {
    const env: NodeJS.ProcessEnv = { SWITCH_CONTROLLER_GATEWAY_PROXY: 'http://u:p@proxy:3128' };
    expect(() => checkBoxRunFlags({}, 'default', env)).toThrow(/is for split boxes only/);
    expect(env).not.toHaveProperty('SWITCH_CONTROLLER_GATEWAY_PROXY');
  });
});

describe('prepareBoxRun', () => {
  it('builds a box that is not split: agent hosts here, a test prompt, no launcher', async () => {
    const env: NodeJS.ProcessEnv = {
      SWITCH_CONTROLLER_REST_AFTER_MS: '600000',
      SWITCH_CONTROLLER_PROVIDER_GATEWAY: '1',
      SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS: '500',
      SWITCH_OWNER_MARKER: 'inherited',
    };
    const run = await prepareBoxRun({
      flags: {},
      agentRuntime: 'default',
      dataDir: dir,
      layout: dataLayout(dir),
      env,
      log: silentLogger,
      rechecks: new ProviderRechecks(),
    });
    expect(run.splitRuntime).toBeNull();
    expect(run.verifyLogin).toBe(true);
    // A stale control file is cleared before a launch, and hosts carry their owner marker.
    expect(run.detached.box).toBe(true);
    expect(run.detached.ownerMarkers).toBeDefined();
    expect(run.workspacesFor).toBeNull();
    expect(run.deps).toMatchObject({
      restAfterMs: 600_000,
      providerGateway: true,
      providerGatewayDailyCalls: '500',
    });
    expect(run.deps.split).toBeUndefined();
    expect(run.deps.checkGivenLogin).toBeTypeOf('function');
    // A marker in the controller's own environment never passes on.
    expect(env).not.toHaveProperty('SWITCH_OWNER_MARKER');
  });

  it('never rests, sweeps or gives markers to agents running as users of their own', async () => {
    const run = await prepareBoxRun({
      flags: { 'agents-workspaces': join(dir, 'w') },
      agentRuntime: 'separate-user',
      dataDir: dir,
      layout: dataLayout(dir),
      env: { SWITCH_CONTROLLER_REST_AFTER_MS: '600000', SWITCH_CONTROLLER_PROVIDER_GATEWAY: '1' },
      log: silentLogger,
      rechecks: new ProviderRechecks(),
    });
    expect(run.deps.restAfterMs).toBeNull();
    expect(run.deps.providerGateway).toBe(false);
    expect(run.deps.sweepAgent).toBeUndefined();
    expect(run.deps.ownerMarkers).toBeUndefined();
    expect(run.workspacesFor?.()).toBe(join(dir, 'w'));
  });
});
