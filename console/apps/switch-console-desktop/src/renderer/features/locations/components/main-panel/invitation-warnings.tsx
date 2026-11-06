/** The gateway supplies these notices only to the agent owner. */
export function InvitationWarnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="my-2 space-y-2" aria-label="Invitation warnings">
      {warnings.map((warning, index) => (
        <p
          key={`${index}:${warning}`}
          role="status"
          className="rounded-md border border-border-warning bg-background-warning px-3 py-2 text-sm text-foreground-warning"
        >
          {warning}
        </p>
      ))}
    </div>
  );
}
