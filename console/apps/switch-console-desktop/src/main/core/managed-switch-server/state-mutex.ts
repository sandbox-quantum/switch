/**
 * Serialises the scripts that write a shared stack's state volume
 * (CHOO-2893), whose read-then-writes are only safe with nobody else's in the
 * middle. Each takes an exclusive `flock` on `/state/.mutex`; the containers
 * share one kernel, so it holds across them, and it drops however the script
 * exits. It is held for milliseconds, unlike the server lock (stack-lock.ts)
 * that a start holds for minutes.
 */

/** A Console id becomes a file name in the register and a lock-script
 * argument, so anything else is refused before it reaches a script. */
export const CONSOLE_ID_PATTERN = /^[0-9A-Fa-f-]{1,64}$/;

/** Held for the rest of the script. */
export const UNDER_STATE_MUTEX = [
  'exec 9>/state/.mutex',
  "flock 9 || { echo 'could not lock the state volume' >&2; exit 1; }",
].join('\n');

export const SERVER_LOCK_FILE = '/state/lock';
export const SERVER_LOCK_TOKEN_LINE = 2;

export const LOCK_LOST_MESSAGE =
  'This Console no longer holds the lock on this Switch server — another Console took it over ' +
  'after this one stopped answering — so it changed nothing more.';

/** Takes the state mutex, then exits 3 unless the server lock is still held
 * with the token in `$1`. The check and the write after it share the mutex, so
 * nobody can take the lock between them. */
export const WHILE_HOLDING_SERVER_LOCK = [
  UNDER_STATE_MUTEX,
  `if [ "$(sed -n ${SERVER_LOCK_TOKEN_LINE}p ${SERVER_LOCK_FILE} 2>/dev/null)" != "$1" ]; then`,
  `  echo '${LOCK_LOST_MESSAGE}' >&2`,
  '  exit 3',
  'fi',
].join('\n');
