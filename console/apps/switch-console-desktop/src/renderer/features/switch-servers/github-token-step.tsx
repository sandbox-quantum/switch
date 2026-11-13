import { useState } from 'react';
import { pasteReady, safetyLine } from '@renderer/features/connectors/connect-flow';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type {
  ConnectionCatalogEntry,
  ServicePasteMethod,
} from '@shared/core/switch-servers/connection-catalog';
import type { ServiceCalls } from './service-calls';
import { ServiceKeyFields } from './service-key-step';

/**
 * Connecting GitHub with a personal access token the person made, in place of
 * the Switch GitHub App. Switch checks it with GitHub, refuses one with no
 * expiration date, and keeps it encrypted; what was typed is dropped once it
 * is sent. Agents it is turned on for act as the person, reaching whatever
 * the token reaches.
 */
export function GitHubTokenStep({
  calls,
  connection,
  method,
  onBack,
  onConnected,
}: {
  calls: ServiceCalls;
  connection: ConnectionCatalogEntry;
  method: ServicePasteMethod;
  onBack: () => void;
  /** Runs once Switch keeps the token, with the warning it gave. */
  onConnected: (warning: string | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(busy);
  const ready = pasteReady(method, values, {});
  const connect = async () => {
    if (ready === null) return;
    setBusy(true);
    setError(null);
    // What was pasted is never kept here once it is sent.
    setValues({});
    try {
      const result = await calls.connectWithPaste('github', ready);
      onConnected(result.warning);
    } catch (cause) {
      setError(failureText(cause, 'Could not connect GitHub.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Connect GitHub with a token</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        <p className="text-sm text-foreground-muted">
          Paste a personal access token you made in GitHub. Switch checks it with GitHub, stores it
          encrypted, and never shows it again. Give it an expiration date: Switch does not hand
          agents a token that never expires.
        </p>
        <ServiceKeyFields
          service="github"
          name="GitHub"
          label={`GitHub ${method.label}`}
          fields={method.fields}
          values={values}
          busy={busy}
          helpUrl={method.help_url}
          helpText="How to make a token in GitHub"
          onChange={(field, next) => setValues((current) => ({ ...current, [field]: next }))}
        />
        <p className="text-xs text-foreground-muted">
          Agents you turn GitHub on for act as you, in every repository the token reaches, not only
          ones you choose here. Pushes and pull requests show your name, not the Switch GitHub
          App&apos;s.
        </p>
        <p className="text-xs text-foreground-muted">{safetyLine(connection, method)}</p>
        {busy && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner /> Checking the token with GitHub…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button disabled={busy || !connection.connectable || ready === null} onClick={connect}>
          Connect GitHub
        </Button>
      </DialogFooter>
    </>
  );
}
