import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import type { ClaudeCredentialKind } from '@shared/core/switch-servers/claude-credential';

export function ManagedClaudeStep({
  onBack,
  onSave,
}: {
  onBack: () => void;
  onSave: (kind: ClaudeCredentialKind, credential: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ClaudeCredentialKind>('api-key');
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscription = kind === 'setup-token';
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(kind, credential.trim());
      setCredential('');
    } catch (cause) {
      setError(failureText(cause, 'Could not save your Claude credential. Try again.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect Claude Code</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-5 pt-0">
        <p className="text-sm text-foreground-muted">
          Choose how your Claude Code agent will authenticate.
        </p>
        <RadioGroup
          aria-label="Claude Code authentication"
          value={kind}
          disabled={saving}
          onValueChange={(value) => {
            if (value !== 'api-key' && value !== 'setup-token') return;
            setKind(value);
            setCredential('');
            setError(null);
          }}
          className="grid grid-cols-2 gap-3"
        >
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem value="api-key" />
            <span className="text-sm">
              <strong>API key</strong>
              <span className="mt-1 block text-xs text-foreground-muted">
                Pay for API usage separately.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem value="setup-token" />
            <span className="text-sm">
              <strong>Subscription</strong>
              <span className="mt-1 block text-xs text-foreground-muted">
                Use your Claude plan.
              </span>
            </span>
          </label>
        </RadioGroup>
        <div className="space-y-3 rounded-lg border border-border bg-background-tertiary-2 p-4 text-sm">
          <h3 className="font-medium">{subscription ? 'Get a setup token' : 'Get an API key'}</h3>
          {subscription ? (
            <>
              <ol className="list-decimal space-y-2 pl-5">
                <li>Install Claude Code on your computer if you have not already.</li>
                <li>
                  Run{' '}
                  <code className="rounded border px-1 py-0.5 select-all">claude setup-token</code>{' '}
                  in your terminal.
                </li>
                <li>Sign in with your Claude subscription in the browser and approve access.</li>
                <li>Copy the token printed in your terminal and paste it below.</li>
              </ol>
              <p className="text-xs text-foreground-muted">
                Requires a Pro, Max, Team, or Enterprise plan with Claude Code access. Your plan’s
                usage limits apply.
              </p>
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() =>
                  void openExternalUrl(
                    'https://code.claude.com/docs/en/setup',
                    'Could not open Claude Code installation instructions.'
                  )
                }
              >
                Install Claude Code
              </Button>
              <Button
                variant="link"
                className="ml-4 h-auto p-0"
                onClick={() =>
                  void openExternalUrl(
                    'https://code.claude.com/docs/en/authentication#generate-a-long-lived-token',
                    'Could not open setup token instructions.'
                  )
                }
              >
                Token instructions
              </Button>
            </>
          ) : (
            <>
              <ol className="list-decimal space-y-2 pl-5">
                <li>Sign in to the Claude Console and set up API billing.</li>
                <li>Open Settings → API keys and choose Create key.</li>
                <li>Copy your new API key and paste it below.</li>
              </ol>
              <p className="text-xs text-foreground-muted">
                API usage is billed separately from a Claude subscription.
              </p>
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() =>
                  void openExternalUrl(
                    'https://platform.claude.com/settings/keys',
                    'Could not open Claude Console.'
                  )
                }
              >
                Open Claude Console
              </Button>
            </>
          )}
        </div>
        <Field>
          <FieldLabel htmlFor="managed-claude-credential">
            {subscription ? 'Setup token' : 'API key'}
          </FieldLabel>
          <Input
            id="managed-claude-credential"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={credential}
            disabled={saving}
            placeholder={subscription ? 'Paste your setup token' : 'Paste your API key'}
            onChange={(event) => setCredential(event.target.value)}
          />
        </Field>
        <p className="text-xs text-foreground-muted">
          Saved encrypted on this computer. It is not sent to the managed service or verified with
          Claude yet.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button onClick={() => void save()} disabled={saving || !credential.trim()}>
          {saving ? 'Saving…' : 'Save credential'}
        </Button>
      </DialogFooter>
    </>
  );
}
