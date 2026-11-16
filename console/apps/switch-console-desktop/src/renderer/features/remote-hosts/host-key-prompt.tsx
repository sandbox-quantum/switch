import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { log } from '@renderer/utils/logger';
import { keyTypeLabel, type HostKeyProblem } from '@shared/core/ssh/host-keys';
import { hostKeyPromptStore } from './host-key-store';

/** Where a host's own public key usually lives, for checking it there. */
function hostKeyFileHint(keyType: string): string {
  const name =
    keyType === 'ssh-ed25519'
      ? 'ed25519'
      : keyType.startsWith('ecdsa-')
        ? 'ecdsa'
        : keyType === 'ssh-rsa'
          ? 'rsa'
          : '*';
  return `ssh-keygen -lf /etc/ssh/ssh_host_${name}_key.pub`;
}

function Fingerprint({
  label,
  keyType,
  fingerprint,
  source,
}: {
  label: string;
  keyType: string;
  fingerprint: string;
  source?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background-1 px-3 py-2">
      <span className="text-xs text-foreground-muted">
        {label} · {keyTypeLabel(keyType)}
      </span>
      <code className="font-mono text-xs break-all text-foreground select-text">{fingerprint}</code>
      {source && <span className="text-[11px] break-all text-foreground-passive">{source}</span>}
    </div>
  );
}

function HostKeyDialog({ problem }: { problem: HostKeyProblem }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const changed = problem.kind === 'changed';
  const refusal = problem.trustRefusal;
  const canTrust = refusal === null && (!changed || confirmed) && !busy;

  const dismiss = () => {
    if (busy) return;
    void hostKeyPromptStore.dismiss(problem).catch((reason: unknown) => {
      log.error('Failed to dismiss SSH host key', { sshHost: problem.sshHost, reason });
    });
  };

  const trust = () => {
    setBusy(true);
    setError(null);
    hostKeyPromptStore
      .trust(problem)
      .catch((reason: unknown) => {
        log.error('Failed to trust SSH host key', { sshHost: problem.sshHost, reason });
        setError(reason);
      })
      .finally(() => setBusy(false));
  };

  const title =
    problem.kind === 'revoked'
      ? 'SSH host key revoked'
      : changed
        ? 'SSH host key changed'
        : refusal
          ? 'Unknown SSH host'
          : 'Trust this SSH host?';

  return (
    // Escape and outside clicks count as "don't connect", never as trust.
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader showCloseButton={false}>
          <DialogTitle className="flex items-center gap-2">
            {changed || problem.kind === 'revoked' ? (
              <ShieldAlert className="size-4 text-foreground-destructive" />
            ) : (
              <ShieldQuestion className="size-4 text-amber-500" />
            )}
            {title}
          </DialogTitle>
        </DialogHeader>
        <DialogContentArea className="gap-3 pt-0 text-sm">
          {problem.kind === 'unknown' && (
            <p>
              Switch Console has not connected to{' '}
              <span className="font-medium">{problem.sshHost}</span> before, and its key is not in
              your known_hosts. Connect only if this fingerprint is the host&rsquo;s: ask whoever
              runs it, or run{' '}
              <code className="font-mono text-xs">{hostKeyFileHint(problem.keyType)}</code> on the
              host.
            </p>
          )}
          {changed && (
            <p>
              The key <span className="font-medium">{problem.sshHost}</span> presented is not the
              one on record, so Switch Console did not connect. Someone may be intercepting the
              connection, or the host may have been reinstalled or had its keys regenerated.
            </p>
          )}
          {problem.kind === 'revoked' && (
            <p>
              The key <span className="font-medium">{problem.sshHost}</span> presented is marked as
              revoked, so Switch Console did not connect.
            </p>
          )}

          <Fingerprint
            label={changed ? 'Presented now' : 'Host key'}
            keyType={problem.keyType}
            fingerprint={problem.fingerprint}
            source={`Recorded as ${problem.hostKeyName}`}
          />
          {problem.known.map((known) => (
            <Fingerprint
              key={`${known.source}:${known.fingerprint}`}
              label={problem.kind === 'revoked' ? 'Revoked in' : 'On record'}
              keyType={known.keyType}
              fingerprint={known.fingerprint}
              source={known.source}
            />
          ))}

          {refusal && <p className="text-foreground-muted">{refusal}</p>}

          {changed && refusal === null && (
            <>
              <p className="text-xs text-foreground-muted">
                Replacing the key changes Switch Console&rsquo;s own record only. If the old key is
                in your known_hosts, <code className="font-mono">ssh</code> keeps warning until you
                remove it (<code className="font-mono">ssh-keygen -R {problem.hostKeyName}</code>).
              </p>
              <label className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={confirmed}
                  disabled={busy}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  I have checked the new fingerprint with whoever runs this host.
                </span>
              </label>
            </>
          )}

          {error !== null && (
            <p className="text-xs text-destructive">
              {failureText(error, 'Could not trust the host key.')}
            </p>
          )}
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss} disabled={busy}>
            {refusal ? 'Close' : 'Don’t connect'}
          </Button>
          {refusal === null && (
            <Button
              variant={changed ? 'destructive' : 'default'}
              onClick={trust}
              disabled={!canTrust}
            >
              {busy && <Spinner />}
              {changed ? 'Replace the key and connect' : 'Trust and connect'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks about SSH host keys Switch Console refused, one at a time, over
 * whatever else is open — the refusal may come from a background connection,
 * or from under the Add host dialog, which has to stay put. Mounted once at
 * the root rather than through the modal registry, which shows one modal at a
 * time and would replace that dialog.
 */
export const HostKeyPromptGate = observer(function HostKeyPromptGate() {
  useEffect(() => {
    void hostKeyPromptStore.hydrate().catch((reason: unknown) => {
      log.error('Failed to load refused SSH host keys', { reason });
    });
  }, []);

  const problem = hostKeyPromptStore.current;
  if (!problem) return null;
  return <HostKeyDialog key={`${problem.sshHost}\n${problem.fingerprint}`} problem={problem} />;
});
