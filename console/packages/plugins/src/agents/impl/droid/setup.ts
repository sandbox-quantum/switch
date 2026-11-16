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
 * Factory's Droid, from its installer or Homebrew. It updates itself;
 * nothing tells its latest version, so updating is always offered.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'droid');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byHomebrew = executable.provenance.kind === 'homebrew';
    const uninstall = byHomebrew ? 'brew uninstall --cask droid' : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer', homebrew: 'homebrew' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'droid', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'droid', executable);
            else await manualVerifyStep(run, executable, 'Droid', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'droid', executable, 'Droid');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating Droid',
              description: [rich`Update Droid.`],
              command: byHomebrew
                ? 'brew upgrade --cask droid'
                : { command: executable.path, args: ['update'] },
            });
          },
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Droid',
                  description: [rich`Uninstall Droid.`],
                  command: uninstall,
                });
              }
            : null,
        });
      }
    );
  }

  let installer: string;
  switch (s.host.platform) {
    case 'windows':
      installer =
        'powershell -ExecutionPolicy ByPass -c "irm https://app.factory.ai/cli.ps1 | iex"';
      break;
    case 'macos':
    case 'linux':
      installer = 'curl -fsSL https://app.factory.ai/cli | sh';
      break;
  }
  s.addInstallMethod({
    id: 'installer',
    title: "Factory's installer",
    description: rich`Install Droid with Factory's installer.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: "Installing Droid with Factory's installer",
        description: [],
        command: installer,
      });
    },
  });
  if (s.host.platform === 'macos')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install Droid with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Droid with Homebrew',
          description: [],
          command: 'brew install --cask droid',
        });
      },
    });
}

export const droidSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
