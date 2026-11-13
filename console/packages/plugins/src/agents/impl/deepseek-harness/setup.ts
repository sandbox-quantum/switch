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
 * DeepSeek Harness from npm, on macOS and Linux: it is not offered on Windows
 * until it is verified there.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'dsh');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const update = byNpm
      ? buildNpmGlobalCli('install', ['@deepseek-ai/dsh'], inferNpmPrefix(executable))
      : null;
    const uninstall = byNpm
      ? buildNpmGlobalCli('uninstall', ['@deepseek-ai/dsh'], inferNpmPrefix(executable))
      : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { npm: 'npm' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'deepseek-harness',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, '@deepseek-ai/dsh'));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'deepseek-harness', executable);
            else await manualVerifyStep(run, executable, 'DeepSeek Harness', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'deepseek-harness', executable, 'DeepSeek Harness');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating DeepSeek Harness',
                  description: [rich`Update DeepSeek Harness to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling DeepSeek Harness',
                  description: [rich`Uninstall DeepSeek Harness.`],
                  command: uninstall,
                });
              }
            : null,
        });
      }
    );
  }

  if (s.host.platform === 'macos' || s.host.platform === 'linux')
    s.addInstallMethod({
      id: 'npm',
      title: 'npm',
      description: rich`Install DeepSeek Harness with npm.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing DeepSeek Harness with npm',
          description: [],
          command: buildNpmGlobalCli('install', ['@deepseek-ai/dsh'], null),
        });
      },
    });
}

export const deepseekHarnessSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
