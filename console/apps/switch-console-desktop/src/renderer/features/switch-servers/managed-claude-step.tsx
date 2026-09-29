import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import {
  CommandRow,
  CommandActionButton,
} from '@renderer/features/settings/agents-page/install-command-row';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  Field,
  FieldLabel,
  FieldContent,
  FieldTitle,
  FieldDescription,
} from '@renderer/lib/ui/field';
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
  useCloseGuard(saving);
  const subscription = kind === 'setup-token';
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(kind, credential.trim());
      setCredential('');
    } catch (cause) {
      setError(failureText(cause, 'Could not connect Claude Code. Try again.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader showCloseButton={!saving}>
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
          <FieldLabel>
            <Field orientation="horizontal">
              <RadioGroupItem value="api-key" />
              <FieldContent>
                <FieldTitle>API key</FieldTitle>
                <FieldDescription>Pay for API usage.</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
          <FieldLabel>
            <Field orientation="horizontal">
              <RadioGroupItem value="setup-token" />
              <FieldContent>
                <FieldTitle>Subscription</FieldTitle>
                <FieldDescription>Use your Claude plan.</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        </RadioGroup>
        <section
          aria-label={subscription ? 'Get a setup token' : 'Get an API key'}
          className="space-y-4"
        >
          <div className="space-y-1">
            <h3 className="text-sm font-medium">
              {subscription ? 'Get a setup token' : 'Get an API key'}
            </h3>
            <p className="text-xs text-foreground-muted">
              {subscription
                ? 'Use a Pro, Max, Team, or Enterprise plan with Claude Code access.'
                : 'API billing is separate from your Claude subscription.'}
            </p>
          </div>
          {subscription ? (
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-foreground-muted"
                >
                  1
                </span>
                <div className="space-y-2">
                  <p>Install Claude Code on your computer.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void openExternalUrl(
                        'https://code.claude.com/docs/en/setup',
                        'Could not open Claude Code installation instructions.'
                      )
                    }
                  >
                    Installation guide <ExternalLink className="size-3.5" />
                  </Button>
                </div>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-foreground-muted"
                >
                  2
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <p>Run this command in your terminal.</p>
                  <CommandRow
                    command="claude setup-token"
                    action={
                      <CommandActionButton
                        aria-label="Open setup token documentation"
                        onClick={() =>
                          void openExternalUrl(
                            'https://code.claude.com/docs/en/authentication#generate-a-long-lived-token',
                            'Could not open setup token instructions.'
                          )
                        }
                      >
                        Help <ExternalLink className="size-3.5" />
                      </CommandActionButton>
                    }
                  />
                </div>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-foreground-muted"
                >
                  3
                </span>
                <div className="space-y-1">
                  <p>Approve access in your browser.</p>
                  <p className="text-xs leading-relaxed text-foreground-muted">
                    Sign in with your Claude subscription, then paste the token printed in your
                    terminal below. Your plan’s usage limits apply.
                  </p>
                </div>
              </li>
            </ol>
          ) : (
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-foreground-muted"
                >
                  1
                </span>
                <div className="space-y-2">
                  <p>Sign in and set up API billing.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void openExternalUrl(
                        'https://platform.claude.com/settings/keys',
                        'Could not open Claude Console.'
                      )
                    }
                  >
                    Open Claude Console <ExternalLink className="size-3.5" />
                  </Button>
                </div>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-foreground-muted"
                >
                  2
                </span>
                <div className="space-y-1">
                  <p>Create an API key.</p>
                  <p className="text-xs leading-relaxed text-foreground-muted">
                    Go to{' '}
                    <span className="font-medium text-foreground">
                      Settings → API keys → Create key
                    </span>
                    , then copy the new key and paste it below.
                  </p>
                </div>
              </li>
            </ol>
          )}
        </section>
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
          Your credential is sent securely to Switch and stored encrypted after verification. The
          check makes one small Claude request and uses your API credit or subscription allowance.
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
          {saving ? 'Verifying with Claude…' : 'Verify and connect'}
        </Button>
      </DialogFooter>
    </>
  );
}
