import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { serverCompatibility } from '@renderer/features/switch-servers/gateway-compatibility-banner';
import { ManagedServerPage } from '@renderer/features/switch-servers/managed-server-view';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { UpdateCard } from '../components/UpdateCard';
import { SectionLabel } from './settings-server';

/**
 * The Switch your agents and rooms run on, and this Console's own version.
 *
 * A Switch this Console runs is operated here — start, stop, update, logs —
 * since no one else can. Anyone else's server is only reported on: whoever
 * runs it looks after it.
 */
export const SystemStatusSettingsPage = observer(function SystemStatusSettingsPage() {
  const server = switchServersStore.activeServer;
  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        sticky
        title="System status"
        description="The Switch your agents and rooms run on, and this Console."
      />
      {server?.managed ? (
        <ManagedServerPage server={server} embedded />
      ) : server ? (
        <ServiceStatus server={server} />
      ) : null}
      <section className="space-y-3">
        <SectionLabel>Switch Console</SectionLabel>
        <UpdateCard />
      </section>
    </div>
  );
});

const ServiceStatus = observer(function ServiceStatus({ server }: { server: SwitchServer }) {
  const store = switchServersStore;
  useEffect(() => {
    void store.refreshStatus(server.id);
  }, [server.id, store]);
  const status = store.statusFor(server.id);
  const unreachable = store.isUnreachable(server.id);
  const version = status?.user?.server?.version ?? null;
  const compatibility = serverCompatibility(server);
  const state = unreachable
    ? { tone: 'bg-red-500', label: 'Cannot reach the server' }
    : status?.connected
      ? { tone: 'bg-green-500', label: 'Connected' }
      : { tone: 'bg-[var(--fg-passive)]', label: 'Not signed in' };
  return (
    <section className="space-y-3">
      <SectionLabel>Service</SectionLabel>
      <div className="space-y-1 rounded-lg border border-border p-4">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <span aria-hidden className={`inline-block size-2 rounded-full ${state.tone}`} />
          {state.label}
        </p>
        <p className="text-sm text-foreground">{server.name}</p>
        <p className="font-mono text-xs text-foreground-muted">{server.url}</p>
        {version && <p className="text-sm text-foreground-muted">Version {version}</p>}
        {compatibility && compatibility.kind !== 'compatible' && (
          <p role="alert" className="text-sm text-foreground">
            {compatibility.message}
          </p>
        )}
      </div>
    </section>
  );
});
