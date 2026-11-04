/**
 * What the person is told before this computer becomes a machine of their
 * workspace (B38; the designer's words, 28 Oct). Shown only while it is not
 * one yet: nothing is added until they choose.
 */
export function ThisComputerAsk({
  sharedCloud,
  action,
}: {
  sharedCloud: boolean;
  /** What the button below says: Start (Meet switch-buddy) or "Add this computer" (setup). */
  action: 'start' | 'add';
}) {
  return (
    <p className="max-w-md text-center text-sm text-foreground-muted">
      switch-buddy runs on this computer, using this computer’s AI login.{' '}
      {action === 'start'
        ? 'Starting it adds this computer to your workspace as a machine that runs agents.'
        : 'Adding it puts this computer in your workspace as a machine that runs agents.'}{' '}
      Nothing is added until you choose.
      {sharedCloud && ' Your other agents stay in Switch cloud.'}
    </p>
  );
}

/** What the person is told when adding this computer failed: never carried on as if it worked. */
export function addFailedLine(reason: string): string {
  return `Couldn’t add this computer. ${reason} Try again, or choose Not now.`;
}

/** What the person is told when this computer's AI providers couldn't be checked (designer's words, 28 Oct). */
export const CHECK_FAILED_LINE =
  'Couldn’t check this computer’s AI providers. You can still choose Not now.';
