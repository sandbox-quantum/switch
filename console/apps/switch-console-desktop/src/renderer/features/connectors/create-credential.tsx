import { ExternalLink } from 'lucide-react';
import { prefilledAccess } from '@renderer/features/connectors/connect-flow';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import type { ServicePasteMethod } from '@shared/core/switch-servers/connection-catalog';

/**
 * The first of a paste step's two steps, where the vendor has a form for a new
 * credential already filled in for Switch: what it asks for, and a button that
 * opens it. Null where the vendor has none, so the step is just the paste.
 */
export function CreateCredential({
  name,
  method,
  busy,
}: {
  name: string;
  method: Pick<ServicePasteMethod, 'method' | 'create_url' | 'help_url'>;
  busy: boolean;
}) {
  const createUrl = method.create_url;
  if (!createUrl) return null;
  const what = method.method === 'token' ? 'token' : 'key';
  return (
    <>
      <section aria-label={`Create a ${what} in ${name}`} className="space-y-2">
        <h3 className="text-sm font-medium">
          1. Create a {what} in {name}
        </h3>
        <p className="text-xs text-foreground-muted">
          {name}’s form opens filled in with what agents need. Choose what it can reach, then
          generate it and copy it.
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label="What the form asks for">
          {prefilledAccess(createUrl).map((access) => (
            <li key={access} className="rounded-full border px-2 py-0.5 text-xs">
              {access}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void openExternalUrl(createUrl, `Could not open ${name}`)}
          >
            Create a {what} in {name} <ExternalLink className="size-4" />
          </Button>
          {method.help_url && (
            <button
              type="button"
              className="text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                void openExternalUrl(method.help_url!, `Could not open ${name}'s help`)
              }
            >
              How {what}s work
            </button>
          )}
        </div>
      </section>
      <h3 className="text-sm font-medium">2. Paste it here</h3>
    </>
  );
}
