import { failureText } from '@renderer/lib/errors/describe-failure';

/** The toast for a host removal that did not happen: why, and the way out. */
export function removeHostFailureToast(
  name: string,
  error: unknown
): { title: string; description: string; variant: 'destructive' } {
  return {
    title: `${name} was not removed`,
    description: failureText(error, 'Check that the host is reachable, then try again.'),
    variant: 'destructive',
  };
}
