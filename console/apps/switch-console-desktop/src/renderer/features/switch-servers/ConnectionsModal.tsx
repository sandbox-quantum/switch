import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DialogFooter } from '@renderer/lib/ui/dialog';
import { ConnectionsGrid, useConnectionCatalog } from './connections-step';
import { ManagedGitHubStep } from './managed-github-step';
import { ServiceConnectStep } from './service-connect-step';
import { ServiceKeyStep } from './service-key-step';

/** A server's connection catalog, opened from its Your Agents page. */
export function ConnectionsModal({ serverId, onClose }: { serverId: string } & BaseModalProps) {
  const queryClient = useQueryClient();
  const catalog = useConnectionCatalog(serverId);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const back = () => {
    setOpen(null);
    void catalog.reload();
    // Agents' service access reads the connections by workspace.
    void queryClient.invalidateQueries({ queryKey: ['workspace-github'] });
    void queryClient.invalidateQueries({ queryKey: ['workspace-service-connections'] });
  };

  if (open === 'github') return <ManagedGitHubStep serverId={serverId} onBack={back} />;
  const opened = catalog.connections?.find((connection) => connection.slug === open);
  if (opened?.key)
    return (
      <ServiceKeyStep serverId={serverId} connection={opened} form={opened.key} onBack={back} />
    );
  if (opened) return <ServiceConnectStep serverId={serverId} connection={opened} onBack={back} />;

  return (
    <>
      <ConnectionsGrid catalog={catalog} query={query} onQueryChange={setQuery} onOpen={setOpen} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
