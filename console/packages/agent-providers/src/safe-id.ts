const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Whether an id that arrived from outside (a server, a control message, a file
 * an agent can write) may become one segment of a path: letters, digits, `.`,
 * `_` and `-`, starting with a letter or digit, with no separator and no `..`.
 */
export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value) && !value.includes('..');
}

/** `value`, when it may be a path segment; otherwise an error naming `what` it is. */
export function safeId(value: string, what: string): string {
  if (!isSafeId(value)) throw new Error(`The ${what} '${value}' cannot be used in a file name.`);
  return value;
}
