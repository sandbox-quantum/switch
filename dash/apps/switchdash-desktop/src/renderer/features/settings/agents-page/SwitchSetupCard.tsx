import { Loader2 } from 'lucide-react';
import { useSwitchSetup } from '@renderer/lib/stores/use-switch-setup';
import { Button } from '@renderer/lib/ui/button';
import { Field } from '@renderer/lib/ui/field';
import { Label } from '@renderer/lib/ui/label';
import { updateCheckUnavailable } from '@shared/core/switch-setup/update-check';
import {
  InstalledBadge,
  InstallingBadge,
  UninstalledBadge,
  UpdateAvailableBadge,
  UpdatingBadge,
} from './agent-status-badge';
import { LocalGhAuthRow, useLocalGhAuth } from './LocalGhAuthRow';

/**
 * Surfaces the Switch connector plugin status for an agent type and exposes
 * Install / Update / Uninstall actions plus a manual "Check for updates".
 * Renders nothing for agent types that declare no Switch setup.
 */
export function SwitchSetupCard({ agentId }: { agentId: string }) {
  const {
    status,
    isLoading,
    checkForUpdates,
    isChecking,
    install,
    isInstalling,
    update,
    isUpdating,
    uninstall,
    isUninstalling,
  } = useSwitchSetup(agentId);

  const { data: ghAuth } = useLocalGhAuth();

  // Hide until we know the agent supports Switch setup.
  if (isLoading || !status?.supported) return null;

  const busy = isInstalling || isUpdating || isUninstalling || isChecking;
  // Distinct from "no update available": there is nothing to compare against.
  const currencyUnknown = updateCheckUnavailable(status);
  // Until the probe answers, do not disable Install — a slow check should not
  // look like a blocked one.
  const ghReady = !ghAuth || (ghAuth.ghInstalled && ghAuth.authenticated && ghAuth.canReadPackages);

  const badge = isInstalling ? (
    <InstallingBadge />
  ) : isUpdating ? (
    <UpdatingBadge />
  ) : !status.installed ? (
    <UninstalledBadge />
  ) : status.updateAvailable ? (
    <UpdateAvailableBadge />
  ) : (
    <InstalledBadge />
  );

  const versionText =
    status.installed && status.updateAvailable && status.latestVersion
      ? `v${status.installedVersion} → v${status.latestVersion}`
      : status.installed && status.installedVersion
        ? `v${status.installedVersion}`
        : null;

  return (
    <Field>
      <Label>Switch setup</Label>
      <div className="space-y-2 rounded-lg border p-3">
        <LocalGhAuthRow />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">switch-connector</span>
            {badge}
            {versionText && <span className="text-xs text-foreground-muted">{versionText}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {!status.installed ? (
              <Button size="xs" disabled={busy || !ghReady} onClick={() => install()}>
                {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Install'}
              </Button>
            ) : (
              <>
                {status.updateAvailable ? (
                  <Button size="xs" disabled={busy} onClick={() => update()}>
                    {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Update'}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => checkForUpdates()}
                  >
                    {isChecking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      'Check for updates'
                    )}
                  </Button>
                )}
                {/* `updateAvailable` can never go true here, so without this the
                    plugin could only be refreshed by uninstalling first. */}
                {currencyUnknown && !status.updateAvailable && (
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => update()}>
                    {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Reinstall'}
                  </Button>
                )}
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => uninstall()}>
                  {isUninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Uninstall'}
                </Button>
              </>
            )}
          </div>
        </div>
        {status.refreshError && (
          <p className="text-destructive text-xs">
            Couldn't refresh the plugin marketplace — showing cached status. {status.refreshError}
          </p>
        )}
        {currencyUnknown && !status.refreshError && (
          <p className="text-xs text-foreground-warning">
            This agent type doesn't report plugin versions here, so Switch Console can't tell
            whether an update exists. Reinstall to be sure you are on the latest.
          </p>
        )}
        {!status.installed && !ghReady && (
          <p className="text-xs text-foreground-muted">
            The plugin is published to a private GitHub repository. Authenticate above to install
            it.
          </p>
        )}
        <p className="text-xs text-foreground-muted">
          Connects this agent to a Switch instance. Credentials are managed when you add the agent
          to a Switch server.
        </p>
      </div>
    </Field>
  );
}
