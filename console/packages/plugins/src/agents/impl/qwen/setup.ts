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

/** Qwen Code from npm, into the person's own prefix on Linux, or Homebrew where there is one. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'qwen');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const via = executable.provenance.kind;
    const update =
      via === 'npm'
        ? buildNpmGlobalCli('install', ['@qwen-code/qwen-code'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew upgrade qwen-code'
          : null;
    const uninstall =
      via === 'npm'
        ? buildNpmGlobalCli('uninstall', ['@qwen-code/qwen-code'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew uninstall qwen-code'
          : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { npm: 'npm', homebrew: 'homebrew' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'qwen', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, '@qwen-code/qwen-code'));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'qwen', executable);
            else await manualVerifyStep(run, executable, 'Qwen Code', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'qwen', executable, 'Qwen Code');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating Qwen Code',
                  description: [rich`Update Qwen Code to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Qwen Code',
                  description: [rich`Uninstall Qwen Code.`],
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
    description: rich`Install Qwen Code with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing Qwen Code with npm',
        description: [],
        command: buildNpmGlobalCli(
          'install',
          ['@qwen-code/qwen-code'],
          s.host.platform === 'linux' ? '"$HOME/.local"' : null
        ),
      });
    },
  });
  if (s.host.platform === 'macos' || s.host.platform === 'linux')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install Qwen Code with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Qwen Code with Homebrew',
          description: [],
          command: 'brew install qwen-code',
        });
      },
    });
}

export const qwenSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
