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
 * The Antigravity CLI, `agy`, from Google's installer. It updates itself;
 * nothing tells its latest version, so updating is always offered.
 */
async function check(s: SetupContext): Promise<void> {
  // `antigravity-acp` is the launcher Switch Console installed before
  // Google's CLI served ACP, only ever on macOS and Linux.
  let found = await findExecutables(s, 'agy');
  if (found.executables.length === 0) found = await findExecutables(s, 'antigravity-acp');
  const { executables, defaultExecutable } = found;
  const installUnix = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  s.setDefaultInstallation(defaultExecutable);
  for (const executable of executables) {
    const name = executable.path.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const legacy = name.toLowerCase().startsWith('antigravity-acp');
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer' }) },
      async (i) => {
        const { signIn, needsSignIn } = await legacyCheckSignIn(
          i,
          'antigravity',
          executable,
          i.activity
        );
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setActions({
          verify: async (run) => {
            // The legacy recheck is of the executable on PATH, which runs by default.
            if (executable === defaultExecutable)
              await legacyRecheckSignIn(i, run, 'antigravity', executable);
            else await manualVerifyStep(run, executable, 'the Antigravity CLI', null);
          },
          signIn: async (run) => {
            await signInStep(i, run, 'antigravity', executable, 'the Antigravity CLI');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating the Antigravity CLI',
              description: [
                legacy
                  ? rich`Replace antigravity-acp with the Antigravity CLI.`
                  : rich`Update the Antigravity CLI.`,
              ],
              command: legacy
                ? { command: 'bash', args: ['-c', installUnix] }
                : { command: executable.path, args: ['update'] },
            });
          },
          uninstall: null,
        });
      }
    );
  }

  if (s.host.platform === 'windows') {
    // Written without `$` or `%`: the shell commands run in may be
    // PowerShell or cmd.exe, and each would expand one of them before
    // `powershell -c` ran.
    s.addInstallMethod({
      id: 'powershell',
      title: 'PowerShell',
      description: rich`Install the Antigravity CLI with Google's installer, in PowerShell.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: "Installing the Antigravity CLI with Google's installer, in PowerShell",
          description: [],
          command:
            'powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex"',
        });
      },
    });
    s.addInstallMethod({
      id: 'command-prompt',
      title: 'Command Prompt',
      description: rich`Install the Antigravity CLI with Google's installer, in Command Prompt.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: "Installing the Antigravity CLI with Google's installer, in Command Prompt",
          description: [],
          command:
            'curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd',
        });
      },
    });
  }
  if (s.host.platform === 'macos' || s.host.platform === 'linux') {
    s.addInstallMethod({
      id: 'installer',
      title: "Google's installer",
      description: rich`Install the Antigravity CLI with Google's installer.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: "Installing the Antigravity CLI with Google's installer",
          description: [],
          command: installUnix,
        });
      },
    });
  }
}

export const antigravitySetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
