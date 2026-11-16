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

/** The Copilot CLI from npm, or Homebrew, or winget on Windows. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'copilot');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const via = executable.provenance.kind;
    const update =
      via === 'npm'
        ? buildNpmGlobalCli('install', ['@github/copilot'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew upgrade --cask copilot-cli'
          : via === 'winget'
            ? 'winget upgrade GitHub.Copilot'
            : null;
    const uninstall =
      via === 'npm'
        ? buildNpmGlobalCli('uninstall', ['@github/copilot'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew uninstall --cask copilot-cli'
          : via === 'winget'
            ? 'winget uninstall GitHub.Copilot'
            : null;
    s.addInstallation(
      executable,
      {
        installedVia: installedVia(executable, {
          npm: 'npm',
          winget: 'winget',
          homebrew: 'homebrew',
        }),
      },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'copilot',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, '@github/copilot'));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'copilot', executable);
            else await manualVerifyStep(run, executable, 'the Copilot CLI', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'copilot', executable, 'the Copilot CLI');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating the Copilot CLI',
                  description: [rich`Update the Copilot CLI to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling the Copilot CLI',
                  description: [rich`Uninstall the Copilot CLI.`],
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
    description: rich`Install the Copilot CLI with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing the Copilot CLI with npm',
        description: [],
        command: buildNpmGlobalCli('install', ['@github/copilot'], null),
      });
    },
  });
  if (s.host.platform === 'windows')
    s.addInstallMethod({
      id: 'winget',
      title: 'winget',
      description: rich`Install the Copilot CLI with winget.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing the Copilot CLI with winget',
          description: [],
          command: 'winget install GitHub.Copilot',
        });
      },
    });
  if (s.host.platform === 'macos' || s.host.platform === 'linux')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install the Copilot CLI with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing the Copilot CLI with Homebrew',
          description: [],
          command: 'brew install --cask copilot-cli',
        });
      },
    });
}

export const copilotSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
