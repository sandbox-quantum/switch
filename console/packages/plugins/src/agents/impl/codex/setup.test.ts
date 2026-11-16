import {
  checkAll,
  checkForUpdates,
  runAction,
  runContext,
  type SetupHost,
} from '@switch-console/core/agents/provider-setup';
import type { InstallCommandSpec } from '@switch-console/core/deps/runtime';
import type { IExecutionContext } from '@switch-console/core/exec';
import { activityLog, noActivity, ok, plainText, type Activity } from '@switch-console/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexSetup } from './setup';

const NPM_ROOT = '/usr/local/lib/node_modules';
const FROM_NPM = {
  path: '/usr/local/bin/codex',
  realpath: `${NPM_ROOT}/@openai/codex/bin/codex.js`,
};
const ID = `executable-path:${FROM_NPM.realpath}`;

/**
 * A Mac with Codex at `path`, or none, on which npm installs it. Its runtime
 * says it is signed in or out as `signIn` says, or cannot check where null; with
 * `legacy`, it runs no setup checks and answers only its legacy check.
 */
function machine(
  installed: { path: string; realpath: string; version: string } | null,
  signIn: 'authenticated' | 'unauthenticated' | null = 'authenticated',
  { legacy }: { legacy: boolean } = { legacy: false }
) {
  const invoked: string[] = [];
  let rechecks = 0;
  let codex = installed;
  const ran: InstallCommandSpec[] = [];
  const host: SetupHost = {
    platform: 'macos',
    exec: {
      exec: (command: string, args: string[] = []) => {
        const answer = (stdout: string) => Promise.resolve({ stdout, stderr: '' });
        if (command === 'which' && codex) return answer(codex.path);
        if (command === 'realpath' && codex) return answer(codex.realpath);
        if (command === 'npm' && args.join(' ') === 'root -g') return answer(NPM_ROOT);
        if (command === codex?.path) return answer(`codex-cli ${codex.version}`);
        return Promise.reject(Object.assign(new Error('not found'), { code: 1 }));
      },
      refreshShellEnv: () => Promise.resolve(),
    } as unknown as IExecutionContext,
    runCommand: (command) => {
      ran.push(command);
      if (command === 'npm install -g @openai/codex') codex = { ...FROM_NPM, version: '1.0.0' };
      return Promise.resolve(ok());
    },
    runSetupCheck: legacy
      ? null
      : (request) => {
          invoked.push(request.check);
          if (!signIn)
            return Promise.resolve({ ok: false, reason: 'This runtime has no such check.' });
          const loggedIn = signIn === 'authenticated';
          return Promise.resolve({
            ok: true,
            output: { loggedIn, message: loggedIn ? 'Logged in using ChatGPT' : 'Not logged in' },
          });
        },
    runLegacyCheck: () =>
      Promise.resolve(
        signIn
          ? { ok: true, output: { status: signIn, message: `Legacy: it is ${signIn}.` } }
          : { ok: false, reason: 'No answer.' }
      ),
    runLegacyRecheck: () => {
      rechecks += 1;
      return Promise.resolve({
        ok: true,
        output: { status: 'authenticated', message: 'Legacy: it answered a test prompt.' },
      });
    },
    loginCommand: () => 'codex login',
  };
  return { host, ran, invoked, rechecks: () => rechecks };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

/** Checks Codex on `host`, reporting to `activity`. */
const check = (host: SetupHost, activity = noActivity) => checkAll(codexSetup, host, activity, []);

describe('codexSetup', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ version: '1.0.0' })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers npm, then Homebrew, where it is missing, and lists no installation', async () => {
    const { host, ran } = machine(null);
    const { s, installations } = await check(host);
    expect(s.state.defaultInstallation).toBeNull();
    expect(ids(s.actions.install)).toEqual(['npm', 'homebrew']);
    expect(installations).toEqual({});
    const run = runContext([], noActivity);
    await s.actions.install[0]!.action(run);
    expect(ids(run.manual)).toEqual(['install']);
    expect(ran).toEqual([]);
  });

  it('reports what the checks do as activities', async () => {
    const { host } = machine({ ...FROM_NPM, version: '0.9.0' });
    let activities: readonly Activity[] = [];
    await check(
      host,
      activityLog((all) => (activities = all))
    );
    expect(activities.map((a) => `${a.title}: ${a.outcome ? plainText(a.outcome) : ''}`)).toEqual([
      'Looking for codex on PATH: found',
      'Running codex --version: version 0.9.0',
      'Checking the sign-in: signed in',
    ]);
  });

  it('installs it with npm, and returns the state it is in after', async () => {
    const { host, ran } = machine(null);
    const { run, found } = await runAction(
      codexSetup,
      host,
      [],
      ({ s }) => s.actions.install.find((offer) => offer.id === 'npm')?.action,
      ['install'],
      noActivity
    );
    expect(ran).toEqual(['npm install -g @openai/codex']);
    expect(ids(run.done)).toEqual(['install']);
    expect(found.s.state.defaultInstallation).toBe(ID);
    expect(Object.keys(found.installations)).toEqual([ID]);
  });

  it('updates an installation npm made that is behind', async () => {
    const { host, ran } = machine({ ...FROM_NPM, version: '0.9.0' });
    await runAction(
      codexSetup,
      host,
      [],
      ({ installations }) => installations[ID]?.actions.update,
      ['update'],
      noActivity
    );
    expect(ran).toEqual(['npm install -g @openai/codex']);
  });

  it('checks an installation for updates, offering to update it either way', async () => {
    for (const [version, behind] of [
      ['0.9.0', true],
      ['1.0.0', false],
    ] as const) {
      const { host } = machine({ ...FROM_NPM, version });
      const { installations } = await check(host);
      expect(installations[ID]?.state).toMatchObject({
        latestVersion: null,
        updateAvailable: null,
      });
      expect(installations[ID]?.actions.update).not.toBeNull();
      const { s } = await check(host);
      expect(
        await checkForUpdates(
          s.state.installations[0]!,
          installations[ID]!.updateCheck!,
          noActivity
        )
      ).toEqual({ latestVersion: '1.0.0', updateAvailable: behind });
    }
  });

  it('offers no update or uninstall for an installation it cannot tell the origin of', async () => {
    const { host } = machine({
      path: '/opt/codex/bin/codex',
      realpath: '/opt/codex/bin/codex',
      version: '1.0.0',
    });
    const { installations } = await check(host);
    const installation = installations['executable-path:/opt/codex/bin/codex'];
    expect(installation?.actions.update).toBeNull();
    expect(installation?.actions.uninstall).toBeNull();
  });

  it('tells whether each installation is signed in, and whether it needs signing in', async () => {
    const { host, ran } = machine({ ...FROM_NPM, version: '1.0.0' }, 'unauthenticated');
    const { installations } = await check(host);
    expect(installations[ID]?.state).toMatchObject({
      signIn: { status: 'signed-out', detail: 'Not logged in' },
      needsSignIn: true,
    });
    const run = runContext(['sign-in'], noActivity);
    await installations[ID]!.actions.signIn(run);
    expect(ran).toEqual(['codex login']);
  });

  it('offers signing in to an installation signed in already, as to any other', async () => {
    const { host } = machine({ ...FROM_NPM, version: '1.0.0' });
    const { installations } = await check(host);
    expect(installations[ID]?.state).toMatchObject({
      signIn: { status: 'signed-in' },
      needsSignIn: false,
    });
    expect(installations[ID]?.actions.signIn).toBeDefined();
  });

  it('leaves the sign-in unknown where the runtime cannot check it, and goes on', async () => {
    const { host } = machine({ ...FROM_NPM, version: '0.9.0' }, null);
    let activities: readonly Activity[] = [];
    const { installations } = await check(
      host,
      activityLog((all) => (activities = all))
    );
    expect(installations[ID]?.state).toMatchObject({
      signIn: { status: 'unknown', detail: 'This runtime has no such check.' },
      needsSignIn: false,
    });
    expect(installations[ID]?.actions.update).not.toBeNull();
    expect(activities.at(-1)).toMatchObject({ title: 'Checking the sign-in', status: 'failed' });
  });

  it('goes from an installation to the realpath Console saves, and back', async () => {
    const { host } = machine({ ...FROM_NPM, version: '1.0.0' });
    const { s } = await check(host);
    const [installation] = s.state.installations;
    expect(codexSetup.installationToRealpath(installation!)).toBe(FROM_NPM.realpath);
    expect(codexSetup.realpathToInstallation(s.state.installations, FROM_NPM.realpath)).toBe(
      installation
    );
  });

  it('verifies an installation, whatever is authorized, changing nothing', async () => {
    const { host, ran, invoked } = machine({ ...FROM_NPM, version: '1.0.0' });
    const { installations } = await check(host);
    let activities: readonly Activity[] = [];
    const run = runContext(
      [],
      activityLog((all) => (activities = all))
    );
    await installations[ID]!.actions.verify(run);
    expect(ran).toEqual([]);
    expect(invoked).toEqual(['login-status', 'login-status']);
    expect(run.findings).toMatchObject({ signIn: { status: 'signed-in' }, needsSignIn: false });
    expect(activities.map((a) => `${a.title}: ${a.outcome ? plainText(a.outcome) : ''}`)).toEqual([
      'Checking the sign-in: signed in',
    ]);
  });

  it('reads the sign-in with the legacy check where the runtime runs no setup checks', async () => {
    const { host, invoked, rechecks } = machine(
      { ...FROM_NPM, version: '1.0.0' },
      'unauthenticated',
      {
        legacy: true,
      }
    );
    const { installations } = await check(host);
    expect(invoked).toEqual([]);
    expect(rechecks()).toBe(0);
    expect(installations[ID]?.state).toMatchObject({
      signIn: { status: 'signed-out', detail: 'Legacy: it is unauthenticated.' },
      needsSignIn: true,
    });
  });

  it('verifies the installation that runs by default with the legacy recheck', async () => {
    const { host, rechecks } = machine({ ...FROM_NPM, version: '1.0.0' }, 'unauthenticated', {
      legacy: true,
    });
    const { installations } = await check(host);
    const run = runContext([], noActivity);
    await installations[ID]!.actions.verify(run);
    expect(rechecks()).toBe(1);
    expect(run.findings).toEqual({
      signIn: { status: 'signed-in', detail: 'Legacy: it answered a test prompt.' },
      needsSignIn: false,
    });
  });
});
