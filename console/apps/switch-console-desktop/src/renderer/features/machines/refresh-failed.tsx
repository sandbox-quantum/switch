import { failureText } from '@renderer/lib/errors/describe-failure';

/**
 * Shown above devices already on screen when refreshing them fails, so the
 * page keeps what the server last sent instead of going blank, and says so.
 * A frozen workspace's banner already says why the server cannot answer.
 */
export function RefreshFailed({ error, frozen }: { error: unknown; frozen: boolean }) {
  if (frozen) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {failureText(error, 'Could not refresh your devices.')} Showing what the server last sent.
    </p>
  );
}
