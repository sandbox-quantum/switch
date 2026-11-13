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
  signInStep,
} from '../../provider-runtime';

/** Whether `executable` is signed in, as `codex login status` says, as one activity in `log`. */
function loginStatus(runSetupCheck: RunSetupCheck, executable: Executable, log: ActivityLog) {
  return setupCheckSignIn(
    runSetupCheck,
    {
      provider: 'codex',
      check: 'login-status',
      input: {},
      executable,
      read: ({ loggedIn, message }) => ({
        signIn: { status: loggedIn ? 'signed-in' : 'signed-out', detail: message || null },
        needsSignIn: !loggedIn,
      }),
    },
    log
  );
}

/** Codex from npm or Homebrew, or on Windows from OpenAI's installer, the official way there. */
async function check(s: SetupContext): Promise<void> {
  const { executables, defaultExecutable } = await findExecutables(s, 'codex');
  // OpenAI's Windows installer puts it under one of these.
  const fromInstaller = (executable: Executable) => {
    const path = executable.realpath.replaceAll('\\', '/').toLowerCase();
    return (
      path.includes('/programs/openai/codex/') || path.includes('/.codex/packages/standalone/')
    );
  };
  s.setDefaultInstallation(defaultExecutable);
  const { runSetupCheck } = s.host;
  for (const executable of executables) {
    const via = executable.provenance.kind;
    const byInstaller = fromInstaller(executable);
    const update =
      via === 'npm'
        ? buildNpmGlobalCli('install', ['@openai/codex'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew upgrade --cask codex'
          : byInstaller
            ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
            : null;
    const uninstall =
      via === 'npm'
        ? buildNpmGlobalCli('uninstall', ['@openai/codex'], inferNpmPrefix(executable))
        : via === 'homebrew'
          ? 'brew uninstall --cask codex'
          : byInstaller
            ? // What the installer created, and nothing else: the rest of
              // `~/.codex` (config, auth, sessions) is the person's. Written
              // without `$` or `%`, which PowerShell or cmd.exe would expand
              // before `powershell -c` ran.
              'powershell -ExecutionPolicy ByPass -c "' +
              "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\\OpenAI\\Codex') -Recurse -Force -ErrorAction SilentlyContinue; " +
              "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\\packages\\standalone') -Recurse -Force -ErrorAction SilentlyContinue" +
              '"'
            : null;
    s.addInstallation(
      executable,
      {
        installedVia: fromInstaller(executable)
          ? 'installer'
          : installedVia(executable, { npm: 'npm', homebrew: 'homebrew' }),
      },
      async (i) => {
        const { signIn, needsSignIn } = runSetupCheck
          ? await loginStatus(runSetupCheck, executable, i.activity)
          : await legacyCheckSignIn(i, 'codex', executable, i.activity);
        i.state.signIn = signIn;
        i.state.needsSignIn = needsSignIn;
        i.setUpdateCheck((activity) => latestOnNpm({ activity }, '@openai/codex'));
        i.setActions({
          // Codex has nothing deeper to ask than its login status.
          verify: runSetupCheck
            ? async (run) => {
                const found = await loginStatus(runSetupCheck, executable, run.activity);
                run.findings.signIn = found.signIn;
                run.findings.needsSignIn = found.needsSignIn;
              }
            : async (run) => {
                // The legacy recheck is of the executable on PATH, which runs by default.
                if (executable === defaultExecutable)
                  await legacyRecheckSignIn(i, run, 'codex', executable);
                else
                  await manualVerifyStep(
                    run,
                    executable,
                    'Codex',
                    `${executable.path} exec "Reply with OK"`
                  );
              },
          signIn: async (run) => {
            await signInStep(i, run, 'codex', executable, 'Codex');
          },
          update: update
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'update',
                  title: 'Updating Codex',
                  description: [rich`Update Codex to the latest version.`],
                  command: update,
                });
              }
            : null,
          uninstall: uninstall
            ? async (run) => {
                await cliStep(s, run, {
                  id: 'uninstall',
                  title: 'Uninstalling Codex',
                  description: [rich`Uninstall Codex.`],
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
      id: 'installer',
      title: "OpenAI's installer",
      description: rich`Install Codex with OpenAI's installer.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: "Installing Codex with OpenAI's installer",
          description: [],
          command:
            'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
        });
      },
    });
  s.addInstallMethod({
    id: 'npm',
    title: 'npm',
    description: rich`Install Codex with npm.`,
    action: async (run) => {
      await cliStep(s, run, {
        id: 'install',
        title: 'Installing Codex with npm',
        description: [],
        command: buildNpmGlobalCli('install', ['@openai/codex'], null),
      });
    },
  });
  if (s.host.platform === 'macos' || s.host.platform === 'linux')
    s.addInstallMethod({
      id: 'homebrew',
      title: 'Homebrew',
      description: rich`Install Codex with Homebrew.`,
      action: async (run) => {
        await cliStep(s, run, {
          id: 'install',
          title: 'Installing Codex with Homebrew',
          description: [],
          command: 'brew install --cask codex',
        });
      },
    });
}

export const codexSetup: ProviderSetup = {
  check,
  // Legacy: Console saves, and names to the session host, an installation by its realpath.
  installationToRealpath,
  realpathToInstallation,
};
