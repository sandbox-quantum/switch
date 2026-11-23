import {
  buildNpmGlobalCli,
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
  inferNpmPrefix,
  latestOnNpm,
  cliStep,
  type Executable,
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
import {
  OPENCODE_PACKAGE,
  OPENCODE_WINDOWS_INSTALL,
  OPENCODE_WINDOWS_RELEASE,
  OPENCODE_WINDOWS_UNINSTALL,
} from './index';

/**
 * OpenCode 1, from its `opencode-ai` package: OpenCode 2 (`@opencode/cli`)
 * serves an API Switch does not speak yet. From npm, into the person's own
 * prefix on Linux; on Windows, which has no npm out of the box, also from
 * OpenCode's release, unpacked into `~\.opencode\bin`. Uninstalling also
 * removes `@opencode/cli`, which Switch Console installed for a while.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'opencode');
  // Where OpenCode's release is unpacked.
  const fromRelease = (executable: Executable) =>
    executable.realpath.replaceAll('\\', '/').toLowerCase().includes('/.opencode/bin/');
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const byRelease = s.host.platform === 'windows' && fromRelease(executable);
    const update = byRelease
      ? OPENCODE_WINDOWS_INSTALL
      : byNpm
        ? buildNpmGlobalCli('install', [OPENCODE_PACKAGE], inferNpmPrefix(executable))
        : null;
    const uninstall = byRelease
      ? OPENCODE_WINDOWS_UNINSTALL
      : byNpm
        ? buildNpmGlobalCli(
            'uninstall',
            [OPENCODE_PACKAGE, '@opencode/cli'],
            inferNpmPrefix(executable)
          )
        : null;
    s.addInstallation(
      executable,
      { installedVia: byRelease ? 'release' : installedVia(executable, { npm: 'npm' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'opencode',
          executable,
          i.activity
        );
        i.setState({ signIn, needsSignIn });
        // A release install updates to the release Switch pins, so that is its latest.
        if (byRelease) i.setUpdateCheck(() => Promise.resolve(OPENCODE_WINDOWS_RELEASE.slice(1)));
        else i.setUpdateCheck((activity) => latestOnNpm({ activity }, OPENCODE_PACKAGE));
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'opencode', executable);
            else await manualVerifyStep(run, executable, 'OpenCode', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'opencode', executable, 'OpenCode');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating OpenCode',
                  description: [rich`Update OpenCode to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling OpenCode',
                  description: [rich`Uninstall OpenCode.`],
                  command: uninstall,
                });
              }
            : null,
        });
      }
    );
  }

  if (s.host.platform === 'windows')
    s.addInstallMethod({
      id: 'release',
      title: 'OpenCode release',
      description: rich`Install OpenCode from its release, without npm.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing OpenCode from its release',
          description: [],
          command: OPENCODE_WINDOWS_INSTALL,
        });
      },
    });
  s.addInstallMethod({
    id: 'npm',
    title: 'npm',
    description: rich`Install OpenCode with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing OpenCode with npm',
        description: [],
        command: buildNpmGlobalCli(
          'install',
          [OPENCODE_PACKAGE],
          s.host.platform === 'linux' ? '"$HOME/.local"' : null
        ),
      });
    },
  });
}

export const opencodeSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
