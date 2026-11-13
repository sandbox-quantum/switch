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

/** Pi from npm, into the person's own prefix on Linux. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'pi');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const update = byNpm
      ? buildNpmGlobalCli(
          'install',
          ['@earendil-works/pi-coding-agent'],
          inferNpmPrefix(executable)
        )
      : null;
    const uninstall = byNpm
      ? buildNpmGlobalCli(
          'uninstall',
          ['@earendil-works/pi-coding-agent'],
          inferNpmPrefix(executable)
        )
      : null;
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { npm: 'npm' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(i, 'pi', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) =>
          latestOnNpm({ activity }, '@earendil-works/pi-coding-agent')
        );
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'pi', executable);
            else await manualVerifyStep(run, executable, 'Pi', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'pi', executable, 'Pi');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating Pi',
                  description: [rich`Update Pi to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Pi',
                  description: [rich`Uninstall Pi.`],
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
    description: rich`Install Pi with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing Pi with npm',
        description: [],
        command: buildNpmGlobalCli(
          'install',
          ['@earendil-works/pi-coding-agent'],
          s.host.platform === 'linux' ? '"$HOME/.local"' : null
        ),
      });
    },
  });
}

export const piSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
