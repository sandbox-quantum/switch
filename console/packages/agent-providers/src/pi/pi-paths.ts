import { homedir } from 'node:os';
import { join } from 'node:path';

/** The variable Pi reads its agent directory (settings, logins, sessions) from. */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** Where Switch's own Pi profile sits under the home directory. */
export const PI_AGENT_DIR_IN_HOME = ['.local', 'state', 'switch', 'pi', 'agent'] as const;

/**
 * The agent directory every Pi that Switch starts runs with: sessions, the
 * sign-in check and `PI_LOGIN` alike, so a login made there is the one an
 * agent uses, and the person's own `~/.pi/agent` is never read or written.
 * A `PI_CODING_AGENT_DIR` already in `env` is not followed: the profile is
 * always Switch's.
 */
export function piAgentDir(env: Record<string, string | undefined>): string {
  return join(env.HOME || homedir(), ...PI_AGENT_DIR_IN_HOME);
}
