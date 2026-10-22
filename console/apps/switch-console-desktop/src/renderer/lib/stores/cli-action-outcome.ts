/**
 * The install/update/uninstall RPCs resolve with a `Result` rather than
 * throwing, so a failure arrives as a successful call. Returns the error to
 * reject with when the result says the action failed, or null when it worked.
 */
export function cliActionFailure(result: unknown): Error | null {
  if (typeof result !== 'object' || result === null || !('success' in result)) {
    return new Error('Unexpected response from the provider action');
  }
  if (result.success === true) return null;
  const error = 'error' in result ? result.error : undefined;
  const type =
    typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
      ? error.type
      : 'unknown';
  return new Error(type === 'still-present' ? 'Still installed after uninstalling' : type);
}
