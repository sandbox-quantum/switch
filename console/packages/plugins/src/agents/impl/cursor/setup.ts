import {
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
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
 * The Cursor CLI from its installer, on macOS and Linux; it went by
 * `cursor-agent` before `agent`. Nothing tells its latest version, so
 * updating, always offered, runs the installer again.
 */
async function check(s: SetupContext): Promise<void> {
  let found = await findExecutables(s, 'agent');
  if (found.executables.length === 0) found = await findExecutables(s, 'cursor-agent');
  const { executables, defaultExecutable } = found;
  const installCommand = 'curl https://cursor.com/install -fsS | bash';
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'cursor',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'cursor', executable);
            else await manualVerifyStep(run, executable, 'the Cursor CLI', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'cursor', executable, 'the Cursor CLI');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating the Cursor CLI',
              description: [rich`Update the Cursor CLI by running its installer again.`],
              command: installCommand,
            });
          },
          uninstall: null,
        });
      }
    );
  }

  if (s.host.platform === 'macos' || s.host.platform === 'linux')
    s.addInstallMethod({
      id: 'installer',
      title: "Cursor's installer",
      description: rich`Install the Cursor CLI with its installer.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing the Cursor CLI with its installer',
          description: [],
          command: installCommand,
        });
      },
    });
}

export const cursorSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
