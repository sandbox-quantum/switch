import { activityLog, err, noActivity, ok, plainText, type Activity } from '@switch-console/shared';
import { describe, expect, it } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import type { InstallCommandSpec } from '../../host-dependencies/runtime/types';
import { checkAll, checkStep, cliStep, runAction, runCommand, runContext, step } from './steps';
import type { Executable, ProviderSetup, SetupHost } from './types';
import { checkForUpdates } from './versions';

/** A machine on which every command succeeds, but those in `failing`. */
function machine(failing: string[] = []) {
  const ran: InstallCommandSpec[] = [];
  const host: SetupHost = {
    platform: 'macos',
    exec: { refreshShellEnv: () => Promise.resolve() } as unknown as IExecutionContext,
    runSetupCheck: null,
    runLegacyCheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
    runLegacyRecheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
    loginCommand: () => 'unused',
    runCommand: (command) => {
      ran.push(command);
      return Promise.resolve(
        typeof command === 'string' && failing.includes(command)
          ? err({ type: 'command-failed', message: 'it failed', output: '' })
          : ok()
      );
    },
  };
  return { s: { host }, ran };
}

/** An activity log, and the last whole list it gave, as `title: status outcome`. */
function recorded() {
  let last: readonly Activity[] = [];
  const log = activityLog((activities) => (last = activities));
  const seen = () =>
    last.map((a) => `${a.title}: ${a.status}${a.outcome ? ` ${plainText(a.outcome)}` : ''}`);
  return { log, seen };
}

const ids = (steps: { id: string }[]) => steps.map((done) => done.id);

/** Two steps, recording which ran; the first throws where `firstThrows`. */
async function twoSteps(authorized: Parameters<typeof runContext>[0], firstThrows = false) {
  const ran: string[] = [];
  const { log, seen } = recorded();
  const run = runContext(authorized, log);
  await step(run, { id: 'first', title: 'First', description: [] }, async () => {
    ran.push('first');
    if (firstThrows) throw new Error('it failed');
  });
  await step(run, { id: 'second', title: 'Second', description: [] }, async () => {
    ran.push('second');
  });
  return { ran, run, seen };
}

describe('step', () => {
  it('runs nothing when nothing is authorized, listing the steps for a person', async () => {
    const { ran, run, seen } = await twoSteps([]);
    expect(ran).toEqual([]);
    expect(ids(run.manual)).toEqual(['first', 'second']);
    expect(seen()).toEqual(['First: waiting needs you', 'Second: waiting needs you']);
  });

  it('runs every step when all are authorized', async () => {
    const { ran, run, seen } = await twoSteps(['first', 'second']);
    expect(ran).toEqual(['first', 'second']);
    expect(ids(run.done)).toEqual(['first', 'second']);
    expect(run.manual).toEqual([]);
    expect(seen()).toEqual(['First: done', 'Second: done']);
  });

  it('runs only the step authorized by its id', async () => {
    const { ran, run } = await twoSteps(['first']);
    expect(ran).toEqual(['first']);
    expect(ids(run.manual)).toEqual(['second']);
  });

  it('runs an authorized step after one left to a person', async () => {
    const { ran, run } = await twoSteps(['second']);
    expect(ran).toEqual(['second']);
    expect(ids(run.manual)).toEqual(['first']);
  });

  it('runs no step after one that failed, recording how', async () => {
    const { ran, run, seen } = await twoSteps(['first', 'second'], true);
    expect(ran).toEqual(['first']);
    expect(run.failure).toEqual({ type: 'step-failed', message: 'it failed' });
    expect(ids(run.manual)).toEqual(['second']);
    expect(seen()).toEqual(['First: failed failed', 'Second: waiting not run']);
  });

  it('leaves a step with nothing to run to a person', async () => {
    const run = runContext(['first'], noActivity);
    await step(run, { id: 'first', title: 'First', description: [] }, null);
    expect(ids(run.manual)).toEqual(['first']);
  });
});

describe('runCommand', () => {
  it('throws where the command fails, which a step records', async () => {
    const { s, ran } = machine(['npm i']);
    const run = runContext(['install'], noActivity);
    await step(run, { id: 'install', title: 'Install', description: [] }, () =>
      runCommand(s, 'npm i')
    );
    expect(ran).toEqual(['npm i']);
    expect(run.failure).toEqual({ type: 'command-failed', message: 'it failed', output: '' });
    expect(run.done).toEqual([]);
  });
});

describe('cliStep', () => {
  it('describes a step with its paragraphs, then the command line', async () => {
    const { s, ran } = machine();
    const run = runContext([], noActivity);
    await cliStep(s, run, {
      id: 'update',
      title: 'Updating it',
      description: [[{ text: 'Update it.' }]],
      command: { command: '/Applications/My Tool/tool', args: ['update'] },
    });
    expect(ran).toEqual([]);
    expect(run.manual).toEqual([
      {
        id: 'update',
        title: 'Updating it',
        description: [
          { kind: 'paragraph', text: [{ text: 'Update it.' }] },
          { kind: 'cli', command: '"/Applications/My Tool/tool" update' },
        ],
      },
    ]);
  });

  it('runs its command where authorized, reporting it as an activity', async () => {
    const { s, ran } = machine();
    const { log, seen } = recorded();
    const run = runContext(['install'], log);
    await cliStep(s, run, {
      id: 'install',
      title: 'Installing it',
      description: [],
      command: 'npm i',
    });
    expect(ran).toEqual(['npm i']);
    expect(ids(run.done)).toEqual(['install']);
    expect(seen()).toEqual(['Installing it: done']);
  });
});

describe('checkStep', () => {
  it('runs whatever is authorized, neither done nor left to a person', async () => {
    const { log, seen } = recorded();
    const run = runContext([], log);
    let ran = false;
    await checkStep(run, { title: 'Checking it', description: null }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(run).toMatchObject({ done: [], manual: [], failure: null });
    expect(seen()).toEqual(['Checking it: done']);
  });

  it('reports a check that failed, and the action goes on', async () => {
    const { log, seen } = recorded();
    const run = runContext([], log);
    await checkStep(run, { title: 'Checking it', description: null }, () =>
      Promise.reject(new Error('no answer'))
    );
    expect(run.failure).toBeNull();
    expect(seen()).toEqual(['Checking it: failed failed']);
  });
});

describe('checkAll', () => {
  const executable: Executable = {
    path: '/bin/tool',
    realpath: '/bin/tool',
    version: '1.0.0',
    provenance: { kind: 'unknown', confidence: 'inferred' },
  };
  const ID = 'executable-path:/bin/tool';
  const noAction = () => Promise.resolve();
  /** A setup listing `executable`, counting its checks and the installation's in `counts`. */
  function counted() {
    const counts = { checks: 0, installationChecks: 0 };
    const setup: ProviderSetup = {
      installationToRealpath: () => 'unused',
      realpathToInstallation: () => null,
      check: (s) => {
        counts.checks += 1;
        s.addInstallation(executable, { installedVia: null }, (i) => {
          counts.installationChecks += 1;
          i.state.signIn = { status: 'signed-out', detail: null };
          i.state.needsSignIn = true;
          i.setUpdateCheck(() => Promise.resolve('1.1.0'));
          i.setActions({
            verify: async (run) => {
              run.findings.signIn = { status: 'signed-in', detail: 'It answered.' };
            },
            signIn: noAction,
            uninstall: null,
            update: async (run) => {
              await cliStep(s, run, {
                id: 'update',
                title: 'Updating',
                description: [],
                command: 'up',
              });
            },
          });
          return Promise.resolve();
        });
        return Promise.resolve();
      },
    };
    return { setup, counts };
  }

  it('checks the provider, then each installation', async () => {
    const { s: host } = machine();
    const { setup, counts } = counted();
    const { installations } = await checkAll(setup, host.host, noActivity, []);
    expect(counts).toEqual({ checks: 1, installationChecks: 1 });
    expect(installations[ID]?.state).toEqual({
      signIn: { status: 'signed-out', detail: null },
      needsSignIn: true,
      latestVersion: null,
      updateAvailable: null,
    });
    expect(installations[ID]?.actions.uninstall).toBeNull();
  });

  it('fails for an installation whose check gives it no actions', async () => {
    const { s: host } = machine();
    const silent: ProviderSetup = {
      ...counted().setup,
      check: (s) => {
        s.addInstallation(executable, { installedVia: null }, () => Promise.resolve());
        return Promise.resolve();
      },
    };
    await expect(checkAll(silent, host.host, noActivity, [])).rejects.toThrow('gave it no actions');
  });

  it('runs an action on an installation, then checks everything again', async () => {
    const { s: host, ran } = machine();
    const { setup, counts } = counted();
    const { run } = await runAction(
      setup,
      host.host,
      [],
      (before) => before.installations[ID]?.actions.update,
      ['update'],
      noActivity
    );
    expect(ran).toEqual(['up']);
    expect(ids(run.done)).toEqual(['update']);
    expect(counts).toEqual({ checks: 2, installationChecks: 2 });
  });

  it('checks an installation for updates, against its version', async () => {
    const { s: host } = machine();
    const { s, installations } = await checkAll(counted().setup, host.host, noActivity, []);
    const found = installations[ID]!;
    expect(found.state).toMatchObject({ latestVersion: null, updateAvailable: null });
    expect(
      await checkForUpdates(s.state.installations[0]!, found.updateCheck!, noActivity)
    ).toEqual({ latestVersion: '1.1.0', updateAvailable: true });
  });

  it('gives what verifying found', async () => {
    const { s: host } = machine();
    const { run } = await runAction(
      counted().setup,
      host.host,
      [],
      (before) => before.installations[ID]?.actions.verify,
      [],
      noActivity
    );
    expect(run.findings).toEqual({ signIn: { status: 'signed-in', detail: 'It answered.' } });
  });

  it('fails for an action the check does not offer', async () => {
    const { s: host } = machine();
    await expect(
      runAction(
        counted().setup,
        host.host,
        [],
        (before) => before.installations[ID]?.actions.uninstall,
        ['uninstall'],
        noActivity
      )
    ).rejects.toThrow('There is no such action');
  });
});
