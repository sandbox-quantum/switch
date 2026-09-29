/**
 * Serialising the scripts that write a shared stack's state volume
 * (CHOO-2893). Several Consoles, under several accounts, write the same
 * volume through the same daemon, and a script's read-then-write — a temp file
 * renamed into place, a log trimmed back — is only safe when nobody else's
 * runs in the middle of it.
 *
 * Every writing script opens `/state/.mutex` and takes an exclusive `flock` on
 * it before touching anything. The throwaway containers all mount one volume
 * on one kernel, so the lock holds across them; the kernel drops it when the
 * script exits, however it exits, so a killed script leaves nothing to clear.
 * It is held for milliseconds, which is why it is separate from the server
 * lock (see stack-lock.ts) that a start holds for minutes.
 *
 * A leaf module: stack-state.ts, stack-lock.ts and console-register.ts all
 * build their scripts from it when they load.
 */

/** Held for the rest of the script. */
export const UNDER_STATE_MUTEX = ['exec 9>/state/.mutex', 'flock 9'].join('\n');

/** Where the server lock lives, and the line of it that names its holder's token. */
export const SERVER_LOCK_FILE = '/state/lock';
export const SERVER_LOCK_TOKEN_LINE = 2;

/** What a fenced write says when it finds the server lock is no longer its. */
export const LOCK_LOST_MESSAGE =
  'This Console no longer holds the lock on this Switch server — another Console took it over ' +
  'after this one stopped answering — so it changed nothing more.';

/**
 * Held for the rest of the script, and then only while the server lock is
 * still held with the token in `$1`: exits 3, saying why, when another Console
 * has taken it over. That check and the write after it happen under the one
 * mutex, so nobody can take the lock between them. For the writes that decide
 * which credentials a stack has.
 */
export const WHILE_HOLDING_SERVER_LOCK = [
  UNDER_STATE_MUTEX,
  `if [ "$(sed -n ${SERVER_LOCK_TOKEN_LINE}p ${SERVER_LOCK_FILE} 2>/dev/null)" != "$1" ]; then`,
  `  echo '${LOCK_LOST_MESSAGE}' >&2`,
  '  exit 3',
  'fi',
].join('\n');
