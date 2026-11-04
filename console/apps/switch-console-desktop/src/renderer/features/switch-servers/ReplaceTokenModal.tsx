import { KeyRound } from 'lucide-react';
import { useCallback, useState } from 'react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import type {
  BridgeConfigField,
  UpdateBridgeResult,
} from '@shared/core/switch-servers/switch-servers';
import { isMissingRequired } from './connect-form-fields';

type ReplaceTokenModalArgs = {
  workspaceId: string;
  bridgeId: string;
  bridgeDisplayName: string;
  bridgeType: string;
  /** The platform's secret fields, from {@link tokenFields}. */
  fields: BridgeConfigField[];
};

type Props = BaseModalProps<void> & ReplaceTokenModalArgs;

/**
 * Put a new token on a messaging app connection, after the old one was rotated
 * or leaked. Disconnecting and connecting again would do it too, at the cost
 * of every room on the connection; this edits the connection in place, and the
 * server restarts it with the new token.
 *
 * Every secret field is asked for, none prefilled: the server never sends a
 * stored credential back, and a token left as it was is not one replaced.
 */
export function ReplaceTokenModal({
  workspaceId,
  bridgeId,
  bridgeDisplayName,
  bridgeType,
  fields,
  onSuccess,
  onClose,
}: Props) {
  const platform = bridgePlatformLabel(bridgeType);
  const noun = fields.length === 1 ? 'token' : 'tokens';
  const [values, setValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !isSaving && !fields.some((field) => isMissingRequired(field, values));

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    const tokens: Record<string, string> = {};
    for (const field of fields) tokens[field.key] = (values[field.key] ?? '').trim();
    try {
      // The server checks a Slack bot token when it is saved, but not the
      // app-level token, which only fails later when Socket Mode cannot
      // connect. The same check the connect form runs covers both.
      if (bridgeType === 'slack') {
        try {
          await rpc.workspaces.checkSlackTokens({
            workspaceId,
            botToken: tokens.bot_token ?? '',
            appToken: tokens.app_token ?? '',
          });
        } catch (cause) {
          setError(failureText(cause, 'Could not check the tokens with Slack.'));
          return;
        }
      }
      const result = await rpc.workspaces.replaceBridgeTokens({ workspaceId, bridgeId, tokens });
      if (result.kind !== 'updated') {
        setError(messageFor(result));
        return;
      }
      toast({
        title: `${platform} ${noun} replaced`,
        description: `${bridgeDisplayName} restarted with the new ${noun}.`,
      });
      onSuccess();
    } catch (cause) {
      setError(failureText(cause, `Could not replace the ${noun}.`));
    } finally {
      setIsSaving(false);
    }
  }, [
    canSubmit,
    fields,
    values,
    bridgeType,
    workspaceId,
    bridgeId,
    platform,
    noun,
    bridgeDisplayName,
    onSuccess,
  ]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-foreground-muted" />
          <DialogTitle>
            Replace {platform} {noun}
          </DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          {bridgeDisplayName} reconnects with the new {noun}. Your rooms and conversations stay as
          they are.
        </p>

        <FieldGroup>
          {fields.map((field, index) => (
            <Field key={field.key}>
              <FieldLabel>{field.label}</FieldLabel>
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={values[field.key] ?? ''}
                onChange={(e) => {
                  const { value } = e.target;
                  setValues((prev) => ({ ...prev, [field.key]: value }));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) void handleSubmit();
                }}
                autoFocus={index === 0}
              />
              {field.description && (
                <p className="mt-1 text-xs text-foreground-muted">{field.description}</p>
              )}
            </Field>
          ))}
        </FieldGroup>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {isSaving ? 'Replacing…' : `Replace ${noun}`}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}

/** Turn a refused replacement into something the user can act on. The server
 * writes its refusals for the person who typed the token, so they are shown
 * as they are. */
function messageFor(result: Exclude<UpdateBridgeResult, { kind: 'updated' }>): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'forbidden':
      return 'Replacing a token requires an owner or admin of this workspace.';
    case 'invalid':
    case 'error':
      return result.message;
  }
}
