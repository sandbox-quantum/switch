import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  checkForUpdates: vi.fn(),
  listAgentTypeStatuses: vi.fn(),
  probe: vi.fn(),
  getHostDependency: vi.fn(),
  enrichHostDependency: vi.fn(),
  remoteDependencyDescriptor: vi.fn(),
  probeGhAuthStatus: vi.fn(),
  getUpdateInfo: vi.fn(),
  runSingleStep: vi.fn(),
  runnerUpdateStep: vi.fn(),
  runnerSkip: vi.fn(),
}));

// The runner sequences steps and knows nothing about reporting; what it does
// with a step is its own test's business. Only the plan it hands back matters
// here.
vi.mock('./host-setup-runner', () => ({
  HostSetupRunner: class {
    runSingleStep = mocks.runSingleStep;
    updateStep = mocks.runnerUpdateStep;
    skip = mocks.runnerSkip;
    checkAll = vi.fn();
    checkStep = vi.fn();
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: vi.fn() }));
vi.mock('@main/core/switch-setup/remote-switch-setup', () => ({
  getRemoteSwitchSetupService: () =>
    Promise.resolve({
      getStatus: mocks.getStatus,
      checkForUpdates: mocks.checkForUpdates,
      listAgentTypeStatuses: mocks.listAgentTypeStatuses,
    }),
}));

vi.mock('@main/core/dependencies/agent-update-service', () => ({
  agentUpdateService: {
    getUpdateInfo: mocks.getUpdateInfo,
    enrichHostDependency: mocks.enrichHostDependency,
  },
}));

vi.mock('@main/core/dependencies/remote-dependency-manager', () => ({
  getRemoteDependencyManager: vi.fn(),
  remoteDependencyDescriptor: mocks.remoteDependencyDescriptor,
}));

vi.mock('../gh-auth', () => ({
  probeGhAuthStatus: mocks.probeGhAuthStatus,
  startGhAuth: vi.fn(),
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn() }) },
}));

// The module under test reaches the plan store, the event bus and the
// reachability service at import time; all three land in Electron. None is
// involved in observing a single step.
vi.mock('./setup-plan-store', () => ({
  getSetupPlan: vi.fn(),
  saveSetupPlan: vi.fn(),
  listSetupPlans: vi.fn(),
  deleteSetupPlan: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

vi.mock('../production-host-reachability', () => ({
  hostReachabilityService: { requireReachable: vi.fn() },
}));

vi.mock('@main/core/dependencies/install-output', () => ({
  installOutput: { subscribe: vi.fn(() => () => {}) },
}));

import type { HostDependencyManager } from '@switch-console/core/deps/runtime';
import { getRemoteDependencyManager } from '@main/core/dependencies/remote-dependency-manager';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type { HostSetupPlan, HostSetupStep } from '@shared/core/remote-hosts/setup';
import {
  checkStep,
  installSetupStep,
  readAllSetupPlans,
  skipSetupStep,
  updateSetupStep,
} from './host-setup-service';
import { getSetupPlan, listSetupPlans, saveSetupPlan } from './setup-plan-store';

const SSH_HOST = 'dev-vm';

function step(patch: Partial<HostSetupStep>): HostSetupStep {
  return {
    id: 'claude:plugin',
    kind: 'agent-plugin',
    name: 'Claude Code · Switch connector',
    state: 'pending',
    outcome: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: ['claude'],
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...patch,
  };
}

const manager = {
  probe: mocks.probe,
  getHostDependency: mocks.getHostDependency,
} as unknown as HostDependencyManager;

/** An installation as the manager reports it, enriched with update info. */
function installation(patch: Record<string, unknown> = {}) {
  return {
    realpath: '/usr/lib/node_modules/@openai/codex/bin/codex.js',
    version: '2.1.0',
    isActive: true,
    manageable: true,
    latestVersion: '2.2.0',
    updateAvailable: true,
    provenance: { kind: 'npm', confidence: 'confirmed' },
    ...patch,
  };
}

/** A full connector status, the shape the service always returns. */
function status(patch: Record<string, unknown> = {}) {
  return {
    agentId: 'claude',
    supported: true,
    installed: true,
    installedVersion: '0.7.7',
    latestVersion: null,
    updateAvailable: false,
    refreshError: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remoteDependencyDescriptor.mockReturnValue({ name: 'Claude Code' });
  mocks.getUpdateInfo.mockReturnValue({ latestVersion: null, updateAvailable: false });
});

/**
 * Checking one row must touch one agent type.
 *
 * This branch used to ask for *every* agent type's status and then discard all
 * but the one it wanted. Each discarded status ran that type's CLI over SSH, so
 * re-checking the Claude Code connector shelled out to `codex` as well — which
 * on a host without Codex produced `command not found` failures attributed to
 * the row the user had not touched, and cost two extra round trips per type.
 */
describe('checking an agent-plugin step', () => {
  it('asks about its own agent type only', async () => {
    mocks.checkForUpdates.mockResolvedValue(status());

    await checkStep(SSH_HOST, manager, step({}));

    expect(mocks.checkForUpdates).toHaveBeenCalledExactlyOnceWith('claude');
  });

  it('never enumerates the other agent types', async () => {
    mocks.checkForUpdates.mockResolvedValue(status());

    await checkStep(SSH_HOST, manager, step({}));

    expect(mocks.listAgentTypeStatuses).not.toHaveBeenCalled();
  });

  it('strips the plugin suffix to get the agent id', async () => {
    mocks.checkForUpdates.mockResolvedValue(status({ installed: false }));

    await checkStep(SSH_HOST, manager, step({ id: 'codex:plugin' }));

    expect(mocks.checkForUpdates).toHaveBeenCalledWith('codex');
  });

  it('reports an installed connector as satisfied, carrying its version', async () => {
    mocks.checkForUpdates.mockResolvedValue(status({ installedVersion: '0.7.7' }));

    expect(await checkStep(SSH_HOST, manager, step({}))).toEqual({
      outcome: 'satisfied',
      version: '0.7.7',
      latestVersion: null,
      updateAvailable: false,
    });
  });

  it('reports an absent connector as missing', async () => {
    mocks.checkForUpdates.mockResolvedValue(status({ installed: false }));

    expect(await checkStep(SSH_HOST, manager, step({}))).toEqual({ outcome: 'missing' });
  });

  it('reports unknown — not missing — for a type Switch Console cannot drive', async () => {
    // "We cannot answer this" is not "it is not installed".
    mocks.checkForUpdates.mockResolvedValue(status({ supported: false, installed: false }));

    const result = await checkStep(SSH_HOST, manager, step({}));

    expect(result.outcome).toBe('unknown');
    expect(result.error).toContain('no longer a known agent type');
  });
});

/**
 * A check that cannot see an update is a check that will report a stale
 * connector as fine forever.
 */
describe('update detection', () => {
  it('refreshes the catalog rather than reading what the host last fetched', async () => {
    // `getStatus` reads the host's cached marketplace snapshot, which can be
    // arbitrarily old; only `checkForUpdates` refreshes it first. Reading the
    // cache would let a published update go unreported indefinitely.
    mocks.checkForUpdates.mockResolvedValue(status());

    await checkStep(SSH_HOST, manager, step({}));

    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('carries an available connector update through', async () => {
    mocks.checkForUpdates.mockResolvedValue(
      status({ installedVersion: '0.7.6', latestVersion: '0.7.7', updateAvailable: true })
    );

    expect(await checkStep(SSH_HOST, manager, step({}))).toMatchObject({
      outcome: 'satisfied',
      latestVersion: '0.7.7',
      updateAvailable: true,
    });
  });

  it('does not claim an update when the latest version is unknowable', async () => {
    // Null latest means "we could not tell", which is not "there is one" and
    // not "you are current" either.
    mocks.checkForUpdates.mockResolvedValue(status({ latestVersion: null }));

    expect(await checkStep(SSH_HOST, manager, step({}))).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
    });
  });

  it('reports an agent CLI update from the shared coordinator', async () => {
    // Latest-version data is host-agnostic, so the same service that answers
    // for local agents answers here — no extra SSH to find it out.
    mocks.probe.mockResolvedValue({ id: 'claude', status: 'installed', version: '2.1.0' });
    mocks.getUpdateInfo.mockReturnValue({ latestVersion: '2.2.0', updateAvailable: true });
    mocks.getHostDependency.mockReturnValue({ installations: [installation()] });
    mocks.enrichHostDependency.mockReturnValue({ installations: [installation()] });

    const result = await checkStep(
      SSH_HOST,
      manager,
      step({ id: 'claude', kind: 'agent-cli', name: 'Claude Code' })
    );

    expect(mocks.getUpdateInfo).toHaveBeenCalledWith('claude', '2.1.0');
    expect(result).toMatchObject({ latestVersion: '2.2.0', updateAvailable: true });
  });
});

describe('checking a core-dependency step', () => {
  it('goes to the dependency manager, not the plugin CLIs', async () => {
    mocks.probe.mockResolvedValue({ id: 'git', status: 'installed', version: '2.43.0' });

    await checkStep(SSH_HOST, manager, step({ id: 'git', kind: 'core-dependency', name: 'Git' }));

    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith('git');
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });
});

/**
 * A persisted plan is a record of progress, not a fixed roster (CHOO-1809).
 *
 * Reported from a real host: Codex was absent from one host's page and present
 * on another. The plan had been built before Codex shipped, and nothing ever
 * rebuilt it — the page only built a plan when none existed at all. Worse than
 * the missing row: a *missing* step reads as no objection, so the readiness
 * verdict called that host fine for an agent type it had never looked for.
 */
describe('readAllSetupPlans', () => {
  function persisted(steps: HostSetupStep[]): HostSetupPlan {
    return {
      sshHost: 'dev-vm',
      status: 'idle',
      steps,
      currentStepId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  const claudeCli = step({
    id: 'claude',
    kind: 'agent-cli',
    name: 'Claude Code',
    state: 'satisfied',
    outcome: 'satisfied',
    version: '2.1.221',
    dependsOn: ['node'],
  });

  it('adds a step for an agent type that shipped after the plan was built', async () => {
    vi.mocked(listSetupPlans).mockResolvedValue([persisted([claudeCli])]);

    const [plan] = await readAllSetupPlans();

    expect(plan!.steps.some((s) => s.id === 'codex')).toBe(true);
  });

  it('keeps what was already known about the steps that survive', async () => {
    vi.mocked(listSetupPlans).mockResolvedValue([persisted([claudeCli])]);

    const [plan] = await readAllSetupPlans();
    const claude = plan!.steps.find((s) => s.id === 'claude');

    expect(claude).toMatchObject({ state: 'satisfied', version: '2.1.221' });
  });

  it('persists the new shape, so the next read is not a rebuild again', async () => {
    vi.mocked(listSetupPlans).mockResolvedValue([persisted([claudeCli])]);

    await readAllSetupPlans();

    expect(saveSetupPlan).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the step set is already current', async () => {
    // The common case. Rebuilding costs no SSH, but it must not turn every read
    // into a write and a push to the renderer.
    vi.mocked(listSetupPlans).mockResolvedValue([persisted([claudeCli])]);
    const [rebuilt] = await readAllSetupPlans();
    vi.mocked(saveSetupPlan).mockClear();
    vi.mocked(listSetupPlans).mockResolvedValue([rebuilt!]);

    await readAllSetupPlans();

    expect(saveSetupPlan).not.toHaveBeenCalled();
  });
});

/**
 * A newer version existing is not the same as being able to install it.
 *
 * Reported from a real host: Codex read "Update available", Update failed, and
 * the row went back to "Update available". The version comparison was right —
 * a newer Codex does exist — but the installation lived in a root-owned npm
 * prefix that Switch Console cannot write to, so the update could never have run.
 * The agents page gates this through `installationCanUpdate`; this path did not.
 */
describe('offering a CLI update only when it can be carried out', () => {
  const cliStep = () =>
    step({ id: 'codex', kind: 'agent-cli', name: 'Codex', dependsOn: ['node'] });

  beforeEach(() => {
    mocks.probe.mockResolvedValue({ id: 'codex', status: 'installed', version: '0.146.0' });
    mocks.getUpdateInfo.mockReturnValue({ latestVersion: '0.147.0', updateAvailable: true });
  });

  it('offers the update when the installation is one we can drive', async () => {
    const enriched = { installations: [installation({ updateAvailable: true })] };
    mocks.getHostDependency.mockReturnValue(enriched);
    mocks.enrichHostDependency.mockReturnValue(enriched);

    expect(await checkStep(SSH_HOST, manager, cliStep())).toMatchObject({
      updateAvailable: true,
    });
  });

  it('withholds it when the installation is not manageable', async () => {
    // Same version difference, but nothing Switch Console could do about it.
    const enriched = {
      installations: [installation({ manageable: false, updateAvailable: false })],
    };
    mocks.getHostDependency.mockReturnValue(enriched);
    mocks.enrichHostDependency.mockReturnValue(enriched);

    expect(await checkStep(SSH_HOST, manager, cliStep())).toMatchObject({
      updateAvailable: false,
    });
  });

  it('still reports the newer version it found', async () => {
    // Withholding the *offer* is not a reason to withhold the fact. The sheet
    // can still say what exists upstream.
    const enriched = {
      installations: [installation({ manageable: false, updateAvailable: false })],
    };
    mocks.getHostDependency.mockReturnValue(enriched);
    mocks.enrichHostDependency.mockReturnValue(enriched);

    expect(await checkStep(SSH_HOST, manager, cliStep())).toMatchObject({
      latestVersion: '0.147.0',
    });
  });

  it('withholds it when the host detail has not been built yet', async () => {
    // Host detail is populated asynchronously after the probe. Not knowing
    // whether an update can be performed is not grounds for offering it.
    mocks.getHostDependency.mockReturnValue(undefined);

    expect(await checkStep(SSH_HOST, manager, cliStep())).toMatchObject({
      updateAvailable: false,
    });
  });

  it('judges the active installation, not whichever comes first', async () => {
    // Several copies of a CLI on one PATH is ordinary. The one that answers is
    // the one whose updateability matters.
    const enriched = {
      installations: [
        installation({ isActive: false, manageable: true, updateAvailable: true }),
        installation({ isActive: true, manageable: false, updateAvailable: false }),
      ],
    };
    mocks.getHostDependency.mockReturnValue(enriched);
    mocks.enrichHostDependency.mockReturnValue(enriched);

    expect(await checkStep(SSH_HOST, manager, cliStep())).toMatchObject({
      updateAvailable: false,
    });
  });
});

/**
 * What a step reports, and about which row.
 *
 * The dimensions are the whole value of this event: a page of rows, each for a
 * different agent type, and the question it answers is which of them people get
 * stuck on. A failure filed under the wrong row is worse than an unreported one,
 * because it moves a count somewhere it does not belong.
 */
describe('what a setup step reports', () => {
  const HOST = 'report-vm';

  /** A plan with the ids the real builder produces, for the paths that read one. */
  function plan(): HostSetupPlan {
    return {
      sshHost: HOST,
      status: 'idle',
      steps: [
        step({ id: 'node', kind: 'core-dependency', name: 'Node.js', dependsOn: [] }),
        step({ id: 'claude', kind: 'agent-cli', name: 'Claude Code', dependsOn: ['node'] }),
        step({ id: 'claude:plugin' }),
      ],
      currentStepId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function satisfying(planIn: HostSetupPlan, stepId: string): HostSetupPlan {
    return {
      ...planIn,
      steps: planIn.steps.map((s) => (s.id === stepId ? { ...s, state: 'satisfied' } : s)),
    };
  }

  beforeEach(() => {
    vi.mocked(getRemoteDependencyManager).mockResolvedValue(manager);
    vi.mocked(getSetupPlan).mockResolvedValue(plan());
    mocks.runSingleStep.mockImplementation(async (p: HostSetupPlan, id: string) =>
      satisfying(p, id)
    );
    mocks.runnerUpdateStep.mockImplementation(async (p: HostSetupPlan, id: string) =>
      satisfying(p, id)
    );
    mocks.runnerSkip.mockImplementation(async (p: HostSetupPlan) => p);
  });

  it('names the row an install succeeded on', async () => {
    await installSetupStep(HOST, 'claude');

    expect(trackEvent).toHaveBeenCalledWith('host_setup_step', {
      step_kind: 'agent-cli',
      agent_type: 'claude',
      action: 'install',
      outcome: 'success',
    });
  });

  it('names the row an install failed on, when the host could not be reached', async () => {
    // Resolving the dependency manager is where the SSH connection is opened, so
    // an unreachable host fails here — before the runner is ever asked to do
    // anything. It is still that row, of that kind, for that agent type.
    vi.mocked(getRemoteDependencyManager).mockRejectedValueOnce(new Error('ssh: connect failed'));

    await expect(installSetupStep(HOST, 'claude')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith('host_setup_step', {
      step_kind: 'agent-cli',
      agent_type: 'claude',
      action: 'install',
      outcome: 'failure',
    });
  });

  it('names the agent type behind a connector row', async () => {
    vi.mocked(getRemoteDependencyManager).mockRejectedValueOnce(new Error('ssh: connect failed'));

    await expect(installSetupStep(HOST, 'claude:plugin')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith(
      'host_setup_step',
      expect.objectContaining({ step_kind: 'agent-plugin', agent_type: 'claude' })
    );
  });

  it('claims no agent type for a host-level dependency', async () => {
    vi.mocked(getRemoteDependencyManager).mockRejectedValueOnce(new Error('ssh: connect failed'));

    await expect(installSetupStep(HOST, 'node')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith(
      'host_setup_step',
      expect.objectContaining({ step_kind: 'core-dependency', agent_type: 'unknown' })
    );
  });

  it('names the row an update failed on', async () => {
    mocks.runnerUpdateStep.mockRejectedValueOnce(new Error('npm: EACCES'));

    await expect(updateSetupStep(HOST, 'claude')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith('host_setup_step', {
      step_kind: 'agent-cli',
      agent_type: 'claude',
      action: 'update',
      outcome: 'failure',
    });
  });

  it('reports a skip that took', async () => {
    await skipSetupStep(HOST, 'claude');

    expect(trackEvent).toHaveBeenCalledWith('host_setup_step', {
      step_kind: 'agent-cli',
      agent_type: 'claude',
      action: 'skip',
      outcome: 'success',
    });
  });

  it('reports a skip that never took', async () => {
    // Install and update both report a throw; a skip that threw used to report
    // nothing, so the same wall counted differently depending on which button
    // ran into it.
    vi.mocked(getRemoteDependencyManager).mockRejectedValueOnce(new Error('ssh: connect failed'));

    await expect(skipSetupStep(HOST, 'claude')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith('host_setup_step', {
      step_kind: 'agent-cli',
      agent_type: 'claude',
      action: 'skip',
      outcome: 'failure',
    });
  });

  it('still reports when there is no plan to name the row from', async () => {
    vi.mocked(saveSetupPlan).mockRejectedValueOnce(new Error('disk is full'));

    await expect(installSetupStep(HOST, 'claude')).rejects.toThrow();

    expect(trackEvent).toHaveBeenCalledWith(
      'host_setup_step',
      expect.objectContaining({ action: 'install', outcome: 'failure' })
    );
  });
});
