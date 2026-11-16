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

/** Cline from npm. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'cline');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const update = byNpm
      ? buildNpmGlobalCli('install', ['cline'], inferNpmPrefix(executable))
      : null;
    const uninstall = byNpm
      ? buildNpmGlobalCli('uninstall', ['cline'], inferNpmPrefix(executable))
      : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { npm: 'npm' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'cline', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, 'cline'));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'cline', executable);
            else await manualVerifyStep(run, executable, 'Cline', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'cline', executable, 'Cline');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating Cline',
                  description: [rich`Update Cline to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Cline',
                  description: [rich`Uninstall Cline.`],
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
    description: rich`Install Cline with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing Cline with npm',
        description: [],
        command: buildNpmGlobalCli('install', ['cline'], null),
      });
    },
  });
}

export const clineSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
