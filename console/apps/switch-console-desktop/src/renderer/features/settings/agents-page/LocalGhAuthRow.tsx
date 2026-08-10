import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { LocalGhAuthPanel } from './LocalGhAuthPanel';

export const localGhAuthQueryKey = ['switchSetup', 'localGhAuth'] as const;

export function useLocalGhAuth() {
  return useQuery({
    queryKey: localGhAuthQueryKey,
    queryFn: () => rpc.switchSetup.getLocalGhAuth(),
    staleTime: 30_000,
  });
}

/**
 * GitHub access for the Switch plugin, on this machine.
 *
 * Remote hosts have had this row since the scope became a requirement; locally
 * there was nothing, so the same misconfiguration produced a plugin that would
 * not install and sessions that came up silently without their Switch tools.
 */
export function LocalGhAuthRow() {
  const { data, isLoading, refetch } = useLocalGhAuth();
  const [authenticating, setAuthenticating] = useState(false);
  const queryClient = useQueryClient();

  if (isLoading || !data) return null;

  const ready = data.ghInstalled && data.authenticated && data.canReadPackages;

  const problem = !data.ghInstalled
    ? 'GitHub CLI not installed'
    : !data.authenticated
      ? 'Not authenticated'
      : !data.canReadPackages
        ? 'Missing read:packages — re-run Authenticate'
        : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">GitHub</span>
          {ready ? (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <Check className="h-3.5 w-3.5" />
              {data.account ? `Authenticated as ${data.account}` : 'Authenticated'}
            </span>
          ) : (
            <span className="text-destructive flex items-center gap-1 text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              {problem}
            </span>
          )}
        </div>
        {/* Also offered when the login is fine but lacks the scope — the fix is
            the same flow, and `gh auth refresh` adds it without a fresh login. */}
        {!ready && data.ghInstalled && !authenticating && (
          <Button size="xs" onClick={() => setAuthenticating(true)}>
            Authenticate
          </Button>
        )}
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      {!data.ghInstalled && (
        <p className="text-xs text-foreground-muted">
          The Switch plugin and its MCP runtime are published privately on GitHub. Install the
          GitHub CLI from <span className="font-mono">cli.github.com</span>, then authenticate here.
        </p>
      )}

      {/* Re-authenticating cannot fix this one, so it says something different. */}
      {data.envShadowed && (
        <p className="text-xs text-amber-500">
          A <span className="font-mono">GH_TOKEN</span> /{' '}
          <span className="font-mono">GITHUB_TOKEN</span> environment variable is overriding your gh
          login, and it is what sessions will use. Authenticating again will not change that — unset
          it in your shell, or give that token the <span className="font-mono">read:packages</span>{' '}
          scope.
        </p>
      )}

      {authenticating && (
        <LocalGhAuthPanel
          onDone={() => {
            setAuthenticating(false);
            void refetch();
            // The plugin may now install where it could not before.
            void queryClient.invalidateQueries({ queryKey: ['switchSetup'] });
          }}
        />
      )}
    </div>
  );
}
