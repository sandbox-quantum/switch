import {
  buildNpmGlobalCli,
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
  inferNpmPrefix,
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
 * Junie from JetBrains' installer, Homebrew or npm. `junie update` downloads
 * the next version, applied at its next start; nothing tells its latest
 * version, so updating is always offered.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'junie');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const via = executable.provenance.kind;
    const uninstall =
      via === 'npm'
        ? buildNpmGlobalCli('uninstall', ['@jetbrains/junie'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew uninstall junie'
          : null;
    s.addInstallation(
      executable,
      {
        installedVia: installedVia(executable, {
          curl: 'installer',
          homebrew: 'homebrew',
          npm: 'npm',
        }),
      },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'junie', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'junie', executable);
            else await manualVerifyStep(run, executable, 'Junie', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'junie', executable, 'Junie');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating Junie',
              description: [rich`Update Junie.`],
              command:
                via === 'npm'
                  ? buildNpmGlobalCli('install', ['@jetbrains/junie'], inferNpmPrefix(executable))
                  : via === 'homebrew'
                    ? 'brew upgrade junie'
                    : { command: executable.path, args: ['update'] },
            });
          },
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Junie',
                  description: [rich`Uninstall Junie.`],
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
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"';
      break;
    case 'macos':
    case 'linux':
      installer = 'curl -fsSL https://junie.jetbrains.com/install.sh | bash';
      break;
  }
  s.addInstallMethod({
    id: 'installer',
    title: "JetBrains' installer",
    description: rich`Install Junie with JetBrains' installer.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: "Installing Junie with JetBrains' installer",
        description: [],
        command: installer,
      });
    },
  });
  if (s.host.platform === 'macos')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install Junie with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Junie with Homebrew',
          description: [],
          command: 'brew tap jetbrains-junie/junie && brew install junie',
        });
      },
    });
  s.addInstallMethod({
    id: 'npm',
    title: 'npm',
    description: rich`Install Junie with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing Junie with npm',
        description: [],
        command: buildNpmGlobalCli('install', ['@jetbrains/junie'], null),
      });
    },
  });
}

export const junieSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
