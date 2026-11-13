import {
  buildNpmGlobalCli,
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
  inferNpmPrefix,
  latestOnNpm,
  cliStep,
  type ProviderSetup,
  type SetupContext,
} from '@switch-console/core/agents/provider-setup';
import { rich } from '@switch-console/shared';
import {
  legacyCheckSignIn,
  legacyRecheckSignIn,
  manualVerifyStep,
  signInStep,
} from '../../provider-runtime';

/**
 * OpenCode from npm, into the person's own prefix on Linux. Uninstalling also
 * removes `opencode-ai`, the name Switch Console once installed it under.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'opencode');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const update = byNpm
      ? buildNpmGlobalCli('install', ['@opencode/cli'], inferNpmPrefix(executable))
      : null;
    const uninstall = byNpm
      ? buildNpmGlobalCli('uninstall', ['@opencode/cli', 'opencode-ai'], inferNpmPrefix(executable))
      : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { npm: 'npm' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'opencode',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, '@opencode/cli'));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'opencode', executable);
            else await manualVerifyStep(run, executable, 'OpenCode', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'opencode', executable, 'OpenCode');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating OpenCode',
                  description: [rich`Update OpenCode to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling OpenCode',
                  description: [rich`Uninstall OpenCode.`],
                  command: uninstall,
                });
              }
            : null,
        });
      }
    );
  }

  s.addInstallMethod({
    id: 'npm',
    title: 'npm',
    description: rich`Install OpenCode with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing OpenCode with npm',
        description: [],
        command: buildNpmGlobalCli(
          'install',
          ['@opencode/cli'],
          s.host.platform === 'linux' ? '"$HOME/.local"' : null
        ),
      });
    },
  });
}

export const opencodeSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
