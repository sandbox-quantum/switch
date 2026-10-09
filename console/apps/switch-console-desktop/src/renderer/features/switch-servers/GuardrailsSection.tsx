import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';
import type {
  ClearTrustSettingsResult,
  FetchTrustSettingsResult,
  TrustSettings,
  UpdateTrustSettingsResult,
} from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

type FormState = {
  endpoint: string;
  policyId: string;
  apiKey: string;
};

function formFor(settings: TrustSettings): FormState {
  return { endpoint: settings.endpoint, policyId: settings.policyId ?? '', apiKey: '' };
}

/** The three recoverable failure kinds every Switch Trust call can produce,
 * worded for someone filling in the form rather than for a log line. */
function recoverableResultText(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Your session has expired. Sign in again.';
    case 'forbidden':
      return 'Only a deployment administrator can view or change Switch Trust settings.';
    case 'invalid':
    case 'error':
      return result.message ?? 'Could not reach the Switch Trust settings.';
    default:
      return 'Could not reach the Switch Trust settings.';
  }
}

/**
 * Switch Trust's one server-global guardrails settings, inline on the
 * server's Home page between Messaging apps and the admin interface link.
 *
 * Admin-only (a deployment operator, not a workspace admin) — one policy
 * covers the whole deployment, not a workspace, so `switchServersStore`'s
 * reported `user.role` is checked directly rather than through
 * `administersWorkspaceInScope()`. Renders nothing for anyone else: there is
 * no read-only view of this to offer, since the gateway itself refuses a
 * non-operator's read.
 */
export const GuardrailsSection = observer(function GuardrailsSection({
  serverId,
  className,
}: {
  serverId: string;
  className?: string;
}) {
  const isOperator = switchServersStore.statusFor(serverId)?.user?.role === 'admin';

  const [settings, setSettings] = useState<TrustSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isOperator) return;
    let cancelled = false;
    setSettings(null);
    setForm(null);
    setLoadError(null);
    setConfirmingOff(false);
    rpc.switchServers.getTrustSettings(serverId).then(
      (result: FetchTrustSettingsResult) => {
        if (cancelled) return;
        if (result.kind === 'loaded') {
          setSettings(result.settings);
          setForm(formFor(result.settings));
          setOpen(result.settings.enabled);
        } else {
          setLoadError(recoverableResultText(result));
        }
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(failureText(error, 'Could not load Switch Trust settings.'));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, isOperator]);

  if (!isOperator) return null;

  const applyResult = (result: UpdateTrustSettingsResult | ClearTrustSettingsResult): void => {
    if (result.kind === 'saved' || result.kind === 'cleared') {
      setSettings(result.settings);
      setForm(formFor(result.settings));
      setActionError(null);
    } else {
      setActionError(recoverableResultText(result));
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setActionError(null);
    try {
      applyResult(
        await rpc.switchServers.updateTrustSettings({
          serverId,
          endpoint: form.endpoint.trim(),
          policyId: form.policyId.trim() === '' ? null : form.policyId.trim(),
          ...(form.apiKey.trim() === '' ? {} : { apiKey: form.apiKey.trim() }),
        })
      );
    } catch (cause) {
      setActionError(failureText(cause, 'Could not save Switch Trust settings.'));
    } finally {
      setSaving(false);
    }
  };

  const turnOff = async () => {
    setClearing(true);
    setActionError(null);
    try {
      applyResult(await rpc.switchServers.clearTrustSettings(serverId));
      setConfirmingOff(false);
      setOpen(false);
    } catch (cause) {
      setActionError(failureText(cause, 'Could not turn off Switch Trust.'));
    } finally {
      setClearing(false);
    }
  };

  const formValid = form !== null && form.endpoint.trim() !== '';

  return (
    <div className={className}>
      {loadError && <p className="text-xs text-destructive">{loadError}</p>}

      {form && settings && (
        <>
          <label className="group/field flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={settings.enabled}
              onCheckedChange={() => {
                if (settings.enabled) {
                  setConfirmingOff(true);
                } else {
                  setOpen((v) => !v);
                }
              }}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                Switch Trust Integration enabled
              </span>
              <span className="text-xs text-foreground-muted">
                {settings.enabled
                  ? 'Every message this server sends is checked before it goes out.'
                  : 'Set a Switch Trust endpoint and an API key to turn it on.'}
              </span>
            </span>
          </label>

          <div className={cn('flex flex-col gap-3 pt-3', !open && 'hidden')}>
            <FieldGroup>
              <Field>
                <FieldLabel>Switch Trust Endpoint</FieldLabel>
                <Input
                  value={form.endpoint}
                  onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel>
                  Guardrails Policy ID
                  <span className="ml-1 font-normal text-foreground-muted">(optional)</span>
                </FieldLabel>
                <Input
                  value={form.policyId}
                  onChange={(e) => setForm({ ...form, policyId: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel>
                  Switch Trust API key
                  {settings.hasApiKey && (
                    <span className="ml-1 font-normal text-foreground-muted">
                      (configured, ending •••{settings.apiKeyLast4})
                    </span>
                  )}
                </FieldLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={settings.hasApiKey ? 'Leave blank to keep the current key' : ''}
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </Field>
            </FieldGroup>
            {actionError && <p className="text-xs text-destructive">{actionError}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!formValid || saving || clearing}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {confirmingOff && (
                <>
                  <span className="text-xs text-foreground-muted">Turn off Switch Trust?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={clearing}
                    onClick={() => void turnOff()}
                  >
                    {clearing ? 'Turning off…' : 'Turn off'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clearing}
                    onClick={() => setConfirmingOff(false)}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
