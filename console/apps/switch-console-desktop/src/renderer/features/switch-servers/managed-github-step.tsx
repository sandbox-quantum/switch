import { CircleCheck, ExternalLink, GitBranch, GitPullRequest, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { GitHubConnection, GitHubFlow } from '@shared/core/switch-servers/github-connection';

export function ManagedGitHubStep({
  serverId,
  onBack,
  onSkip,
  onContinue,
}: {
  serverId: string;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<GitHubFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState<{ baseline: string; expiresAt: number } | null>(null);
  useCloseGuard(busy || flowId !== null);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setConnection(await rpc.switchServers.getGitHubConnection(serverId));
    } catch (cause) {
      setError(failureText(cause, 'Could not load GitHub access.'));
    } finally {
      setBusy(false);
    }
  }, [serverId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await rpc.switchServers.getGitHubFlow(serverId, flowId);
        if (!alive) return;
        setFlow(result);
        if (result.status === 'failed')
          setError('GitHub authorization failed. Cancel and try again.');
        else if (result.status !== 'ready') timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (alive) {
          setFlowId(null);
          setFlow(null);
          setError(failureText(cause, 'Could not check GitHub authorization.'));
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [serverId, flowId]);
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    let checking = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (checking || !alive) return;
      clearTimeout(timer);
      if (Date.now() >= watching.expiresAt) {
        setWatching(null);
        setError('Repository selection timed out. Choose repositories again to continue.');
        return;
      }
      checking = true;
      try {
        const result = await rpc.switchServers.getGitHubConnection(serverId);
        if (!alive) return;
        setConnection(result);
        if (JSON.stringify(result) !== watching.baseline) setWatching(null);
        else timer = setTimeout(() => void check(), 5000);
      } catch (cause) {
        if (alive) {
          setWatching(null);
          setError(
            failureText(
              cause,
              'Could not check repository access. Choose repositories to try again.'
            )
          );
        }
      } finally {
        checking = false;
      }
    };
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [serverId, watching]);
  const act = async (action: () => Promise<void>) => {
    setWatching(null);
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(failureText(cause, 'Could not update GitHub connection.'));
    } finally {
      setBusy(false);
    }
  };
  const connected = connection?.status === 'connected';
  return (
    <>
      <DialogHeader showCloseButton={!busy && !flowId}>
        <DialogTitle>{connected && !flowId ? 'GitHub connected' : 'Connect GitHub'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-5 pt-0">
        {flowId ? (
          <div className="space-y-3">
            {flow?.status === 'ready' ? (
              <>
                <p className="flex items-center gap-2 text-sm">
                  <CircleCheck className="size-5 text-foreground-success" />
                  Authorized as <strong>{flow.login}</strong>
                </p>
                <p className="text-sm text-foreground-muted">
                  Confirm this is the GitHub account you want to connect to Switch.
                </p>
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Complete authorization in your browser, then return here.
              </p>
            )}
          </div>
        ) : connected ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-5 text-foreground-success" />
              Connected as <strong>{connection.login}</strong>
            </p>
            {connection.installations.length ? (
              <div className="space-y-3">
                {connection.installations.map((installation) => (
                  <div key={installation.id} className="rounded-lg border p-3">
                    <h3 className="text-sm font-medium">{installation.account}</h3>
                    <p className="text-xs text-foreground-muted">
                      {installation.repositories.length} accessible{' '}
                      {installation.repositories.length === 1 ? 'repository' : 'repositories'}
                    </p>
                    <ul className="mt-2 max-h-40 overflow-auto text-sm">
                      {installation.repositories.map((repo) => (
                        <li key={repo.id}>{repo.name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">
                Choose repositories on GitHub to finish setup. Your organization may require an
                owner’s approval.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await rpc.switchServers.openGitHubInstallation(serverId);
                    setWatching({
                      baseline: JSON.stringify(connection),
                      expiresAt: Date.now() + 600_000,
                    });
                  })
                }
              >
                Choose repositories <ExternalLink className="size-4" />
              </Button>
            </div>
            {watching && (
              <p role="status" className="flex items-center gap-2 text-xs text-foreground-muted">
                <Spinner /> Choose repositories in GitHub. Access will update here automatically.
              </p>
            )}
            <p className="text-xs text-foreground-muted">
              Disconnecting removes credentials saved by Switch. You can also revoke authorization
              or uninstall the app in GitHub settings. No cloud agent has been started.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground-muted">
              Give your cloud agents access to the repositories you choose.
            </p>
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex gap-3">
                <GitBranch className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">Choose your repositories</h3>
                  <p className="text-xs text-foreground-muted">
                    Authorize your GitHub account, then install the Switch GitHub App on the
                    repositories you choose.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <GitPullRequest className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">Let agents work on your code</h3>
                  <p className="text-xs text-foreground-muted">
                    Repository contents and pull request access let agents clone code, push
                    branches, and open pull requests. Review the permissions on GitHub before
                    approving.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">Stay in control</h3>
                  <p className="text-xs text-foreground-muted">
                    No personal token to copy. Change repository access or uninstall the app from
                    GitHub at any time.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner /> Checking GitHub…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!connection && !busy && (
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        )}
      </DialogContentArea>
      <DialogFooter>
        {flowId ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await rpc.switchServers.cancelGitHubConnection(serverId, flowId);
                  setFlowId(null);
                  setFlow(null);
                })
              }
            >
              Cancel
            </Button>
            {flow?.status === 'ready' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await rpc.switchServers.confirmGitHubConnection(serverId, flowId);
                    setFlowId(null);
                    setFlow(null);
                    await load();
                  })
                }
              >
                Connect {flow.login}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            {connected && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await rpc.switchServers.disconnectGitHub(serverId);
                    await load();
                  })
                }
              >
                Disconnect
              </Button>
            )}
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              Set up later
            </Button>
            {connected && !error && (
              <Button
                onClick={onContinue}
                disabled={
                  busy ||
                  !connection.installations.some(
                    (installation) => installation.repositories.length > 0
                  )
                }
              >
                Continue to agent
              </Button>
            )}
            {(!connected || error) && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setFlow(null);
                    setFlowId(await rpc.switchServers.startGitHubConnection(serverId));
                  })
                }
              >
                Connect GitHub <ExternalLink className="size-4" />
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}
