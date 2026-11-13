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
 * Mistral Vibe from its installer, on macOS and Linux. Nothing tells its
 * latest version, so updating, always offered, runs the installer again.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'vibe-acp');
  const installCommand = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash';
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'mistral-vibe',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'mistral-vibe', executable);
            else await manualVerifyStep(run, executable, 'Mistral Vibe', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'mistral-vibe', executable, 'Mistral Vibe');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating Mistral Vibe',
              description: [rich`Update Mistral Vibe by running its installer again.`],
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
      title: "Mistral's installer",
      description: rich`Install Mistral Vibe with its installer.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Mistral Vibe with its installer',
          description: [],
          command: installCommand,
        });
      },
    });
}

export const mistralVibeSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
