import {
  buildNpmGlobalCli,
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
  inferNpmPrefix,
  latestOnNpm,
  cliStep,
  isBehind,
  runCommand,
  step,
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
  OPENCODE_1_PACKAGE,
  OPENCODE_2,
  OPENCODE_2_SUMMARY,
  OPENCODE_PACKAGE,
  OPENCODE_WINDOWS_INSTALL,
  OPENCODE_WINDOWS_PRECHECK,
  OPENCODE_WINDOWS_UNINSTALL,
  opencodeWindowsInstall,
} from './index';

/**
 * OpenCode, from its `@opencode/cli` package: from npm, into the person's own
 * prefix on Linux; on Windows, which has no npm out of the box, also from
 * OpenCode's release, unpacked into `~\.opencode\bin`.
 *
 * OpenCode 2 replaced OpenCode 1's `opencode-ai` package, which owns the same
 * `opencode` command, so npm will not install it over 1.x: upgrading 1.x
 * removes it first, and puts the same version back if OpenCode 2 does not
 * install. Uninstalling removes either package.
 */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'opencode');
  // Where OpenCode's release is unpacked.
  const fromRelease = (executable: Executable) =>
    executable.realpath.replaceAll('\\', '/').toLowerCase().includes('/.opencode/bin/');
  const windows = s.host.platform === 'windows';
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const byNpm = executable.provenance.kind === 'npm';
    const byRelease = windows && fromRelease(executable);
    const prefix = inferNpmPrefix(executable);
    const { version } = executable;
    // Through `cmd /c` on Windows, where the install shell may be Windows
    // PowerShell 5.1, which does not parse `&&`.
    const chain = (...commands: string[]) =>
      windows ? `cmd /c "${commands.join(' && ')}"` : commands.join(' && ');
    // How it is installed again, removed, and, for 1.x, put back as it was.
    const reinstall = byRelease
      ? OPENCODE_WINDOWS_INSTALL
      : byNpm
        ? buildNpmGlobalCli('install', [OPENCODE_PACKAGE], prefix)
        : null;
    const uninstall = byRelease
      ? OPENCODE_WINDOWS_UNINSTALL
      : byNpm
        ? buildNpmGlobalCli('uninstall', [OPENCODE_PACKAGE, OPENCODE_1_PACKAGE], prefix)
        : null;
    const removeOpenCode1 = byRelease
      ? OPENCODE_WINDOWS_UNINSTALL
      : buildNpmGlobalCli('uninstall', [OPENCODE_1_PACKAGE], prefix);
    const restoreOpenCode1 = byRelease
      ? opencodeWindowsInstall(`'${version}'`)
      : chain(
          buildNpmGlobalCli('uninstall', [OPENCODE_PACKAGE], prefix),
          buildNpmGlobalCli('install', [`${OPENCODE_1_PACKAGE}@${version}`], prefix)
        );
    const openCode1 = !!version && isBehind(version, OPENCODE_2);
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
        // A release install follows the npm package's latest version too.
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, OPENCODE_PACKAGE));
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
          update: !reinstall
            ? null
            : openCode1
              ? async (run) => {
                  await step(
                    run,
                    {
                      id: 'upgrade',
                      title: 'Upgrading to OpenCode 2',
                      description: [
                        { kind: 'paragraph', text: rich`${OPENCODE_2_SUMMARY}` },
                        { kind: 'cli', command: removeOpenCode1 },
                        { kind: 'cli', command: reinstall },
                      ],
                    },
                    async () => {
                      // Windows will not remove a running program, so nothing
                      // is changed while any OpenCode is open.
                      if (windows)
                        try {
                          await runCommand(s, OPENCODE_WINDOWS_PRECHECK.command);
                        } catch {
                          throw new Error(OPENCODE_WINDOWS_PRECHECK.blockedMessage);
                        }
                      await runCommand(s, removeOpenCode1);
                      try {
                        await runCommand(s, reinstall);
                      } catch (error) {
                        await runCommand(s, restoreOpenCode1);
                        throw error;
                      }
                    }
                  );
                }
              : async (run) => {
                  await cliStep(s, run, {
                    id: 'update',
                    title: 'Updating OpenCode',
                    description: [rich`Update OpenCode to the latest version.`],
                    command: reinstall,
                  });
                },
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
