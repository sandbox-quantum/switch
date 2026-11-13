import {
  buildNpmGlobalCli,
  findExecutables,
  realpathToInstallation,
  installationToRealpath,
  installedVia,
  inferNpmPrefix,
  latestOnGitHub,
  cliStep,
  type Executable,
  type RunSetupCheck,
  type ProviderSetup,
  type SetupContext,
} from '@switch-console/core/agents/provider-setup';
import { rich, type ActivityLog } from '@switch-console/shared';
import {
  legacyCheckSignIn,
  legacyRecheckSignIn,
  manualVerifyStep,
  setupCheckSignIn,
  setupCheckStep,
  signInStep,
} from '../../provider-runtime';

/** Whether `executable` is signed in, as `claude auth status` says, as one activity in `log`. */
function authStatus(runSetupCheck: RunSetupCheck, executable: Executable, log: ActivityLog) {
  return setupCheckSignIn(
    runSetupCheck,
    {
      provider: 'claude',
      check: 'auth-status',
      input: {},
      executable,
      read: ({ loggedIn, authMethod, apiProvider }) =>
        loggedIn
          ? {
              signIn: {
                status: 'signed-in',
                detail: `Signed in${authMethod ? ` with ${authMethod}` : ''}${apiProvider ? `, calling ${apiProvider}` : ''}.`,
              },
              needsSignIn: false,
            }
          : { signIn: { status: 'signed-out', detail: 'Not signed in.' }, needsSignIn: true },
    },
    log
  );
}

/** Claude Code from Anthropic's installer, or Homebrew; it updates and uninstalls itself. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'claude');
  s.setDefaultInstallation(defaultExecutable);
  const { runSetupCheck } = s.host;
  for (const executable of executables) {
    const via = executable.provenance.kind;
    // npm is how Claude Code was once installed, still found on some machines.
    s.addInstallation(
      executable,
      { installedVia: installedVia(executable, { curl: 'installer', homebrew: 'homebrew' }) },
      async (i) => {
        const { signIn, needsSignIn } = runSetupCheck
          ? await authStatus(runSetupCheck, executable, i.activity)
          : await legacyCheckSignIn(i, 'claude', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnGitHub({ activity }, 'anthropics/claude-code'));
        i.setActions({
          verify: runSetupCheck
            ? async (run) => {
                const found = await authStatus(runSetupCheck, executable, run.activity);
                run.findings.signIn = found.signIn;
                run.findings.needsSignIn = found.needsSignIn;
                if (found.signIn.status !== 'signed-in') return;
                // `claude auth status` only says a login is there; a test prompt
                // says whether it works.
                const reply = await setupCheckStep(run, runSetupCheck, {
                  provider: 'claude',
                  check: 'test-prompt',
                  input: {},
                  executable,
                  title: 'Sending a test prompt',
                  describe: (said) => ({
                    outcome:
                      said.status === 'authenticated' ? rich`answered` : rich`did not answer`,
                    description: rich`${said.message}`,
                  }),
                });
                // One that could not tell (too old a Claude Code, no answer in
                // time) says nothing more of the login.
                if (reply?.status === 'authenticated')
                  run.findings.signIn = { status: 'signed-in', detail: reply.message };
                else if (reply?.status === 'unauthenticated') {
                  run.findings.signIn = { status: 'signed-out', detail: reply.message };
                  run.findings.needsSignIn = true;
                }
              }
            : async (run) => {
                // The legacy recheck is of the executable on PATH, which runs by default.
                if (executable === defaultExecutable)
                  await legacyRecheckSignIn(i, run, 'claude', executable);
                else
                  await manualVerifyStep(
                    run,
                    executable,
                    'Claude Code',
                    `${executable.path} -p "Reply with OK"`
                  );
              },
          signIn: async (run) => {
            await signInStep(i, run, 'claude', executable, 'Claude Code');
          },
          update: async (run) => {
            await cliStep(s, run, {
              id: 'update',
              title: 'Updating Claude Code',
              description: [rich`Update Claude Code to the latest version.`],
              command:
                via === 'homebrew'
                  ? 'brew upgrade --cask claude-code'
                  : via === 'npm'
                    ? buildNpmGlobalCli(
                        'install',
                        ['@anthropic-ai/claude-code'],
                        inferNpmPrefix(executable)
                      )
                    : { command: executable.path, args: ['install', 'latest'] },
            });
          },
          uninstall: async (run) => {
            await cliStep(s, run, {
              id: 'uninstall',
              title: 'Uninstalling Claude Code',
              description: [rich`Uninstall Claude Code.`],
              command:
                via === 'homebrew'
                  ? 'brew uninstall --cask claude-code'
                  : via === 'npm'
                    ? buildNpmGlobalCli(
                        'uninstall',
                        ['@anthropic-ai/claude-code'],
                        inferNpmPrefix(executable)
                      )
                    : { command: executable.path, args: ['uninstall'] },
            });
          },
        });
      }
    );
  }

  let installer: string;
  switch (s.host.platform) {
    case 'windows':
      // Wrapped in `powershell -c` so it runs from cmd.exe, Windows
      // PowerShell 5.1 or Git Bash alike; free of `$` and `%`, which
      // either shell would expand first.
      installer = 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"';
      break;
    case 'macos':
    case 'linux':
      installer = 'curl -fsSL https://claude.ai/install.sh | bash';
      break;
  }
  s.addInstallMethod({
    id: 'installer',
    title: "Anthropic's installer",
    description: rich`Install Claude Code with Anthropic's installer.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: "Installing Claude Code with Anthropic's installer",
        description: [],
        command: installer,
      });
    },
  });
  if (s.host.platform === 'macos')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install Claude Code with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Claude Code with Homebrew',
          description: [],
          command: 'brew install --cask claude-code',
        });
      },
    });
}

export const claudeSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
