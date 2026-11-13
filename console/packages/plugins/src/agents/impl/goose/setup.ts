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
 * Goose from its installer, on macOS and Linux. Nothing tells its latest
 * version, so updating, always offered, runs the installer again.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'goose');
  // CONFIGURE=false keeps the installer from starting `goose configure`, which
  // asks questions on the terminal.
  const installCommand =
    'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash';
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'goose', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'goose', executable);
            else await manualVerifyStep(run, executable, 'Goose', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'goose', executable, 'Goose');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating Goose',
              description: [rich`Update Goose by running its installer again.`],
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
      title: "Block's installer",
      description: rich`Install Goose with its installer.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Goose with its installer',
          description: [],
          command: installCommand,
        });
      },
    });
}

export const gooseSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
