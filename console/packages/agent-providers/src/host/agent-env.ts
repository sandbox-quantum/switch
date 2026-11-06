import { PROVIDER_RUNTIMES } from '../providers/registry';
import { AGENT_ENV_VARS } from './agent-env-vars';

/**
 * What Windows itself, Node and the provider CLIs need there to find the
 * user's profile, the system and a temporary directory. None is set on macOS
 * or Linux.
 */
const WINDOWS_ENV = [
  'APPDATA',
  'COMSPEC',
  'COMMONPROGRAMFILES',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

/**
 * What a session host's `execution.inheritEnv` names: the provider variables
 * above, those each registered provider's runtime asks for, and the basics a
 * CLI needs to find itself, its home and its terminal. Matched without regard
 * to case on Windows, where `Path` and `PATH` are one variable.
 * Console and the headless agent controller both launch hosts with it.
 */
export const EXECUTION_INHERIT_ENV: readonly string[] = [
  ...new Set([...AGENT_ENV_VARS, ...PROVIDER_RUNTIMES.flatMap((runtime) => runtime.inheritEnv)]),
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'SSH_AUTH_SOCK',
  ...WINDOWS_ENV,
];

/** The basics a CLI needs to find itself and its home. */
const CODEX_KEYRING_READER_ENV = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  ...WINDOWS_ENV,
];

/**
 * How Codex on Linux reaches the Secret Service that holds a keyring login,
 * taken from the session host's own environment. Only the Codex that reads
 * the login is given these; sessions are not, so no provider starts using a
 * keyring it could not reach before. Untested on Linux so far.
 */
const KEYRING_BUS_ENV = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'];

/**
 * The environment of the Codex that reads a keyring login for a session
 * (`codex/keyring-login.ts`): what it needs from the session's, and the
 * keyring bus from the host's when the session's names none. None of the
 * credentials the session is given reach it. Matched without regard to case
 * on Windows.
 */
export function codexKeyringReaderEnvironment(
  sessionEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Record<string, string> {
  const pick = (env: Record<string, string | undefined>, names: readonly string[]) => {
    const wanted = new Set(platform === 'win32' ? names.map((name) => name.toUpperCase()) : names);
    const picked: Record<string, string> = {};
    for (const [name, value] of Object.entries(env))
      if (value && wanted.has(platform === 'win32' ? name.toUpperCase() : name))
        picked[name] = value;
    return picked;
  };
  return {
    ...pick(hostEnv, KEYRING_BUS_ENV),
    ...pick(sessionEnv, [...CODEX_KEYRING_READER_ENV, ...KEYRING_BUS_ENV]),
  };
}
