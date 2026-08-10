import { useCallback, useRef, useState } from 'react';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { getDraggedFilePaths, hasDraggedFiles } from '@renderer/lib/drag-files';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import { basenameFromAnyPath } from '@shared/path-name';

export function useSidebarDrop() {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const { navigate } = useNavigate();
  const { toast } = useToast();

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const filePaths = getDraggedFilePaths(e.dataTransfer);
      if (filePaths.length === 0) return;

      const locationManager = getLocationManagerStore();

      void Promise.allSettled(
        filePaths.map(async (filePath) => {
          try {
            const status = await rpc.locations.inspectLocationPath({ path: filePath });
            if (!status.isDirectory) {
              toast({
                title: 'Cannot add agent',
                description: 'Drop a folder to add it as a Switch agent.',
                variant: 'destructive',
              });
              return null;
            }
            if (!status.switchAgent) {
              toast({
                title: 'Cannot add agent',
                description: `${basenameFromAnyPath(filePath)} has no Switch agent configured.`,
                variant: 'destructive',
              });
              return null;
            }

            // A dropped agent has no server-selection UI, so it is added against
            // the active server (verified server-side). If it isn't that agent's
            // server, use Add Agent to pick the right one.
            const serverId = switchServersStore.activeServerId;
            if (!serverId) {
              toast({
                title: 'Cannot add agent',
                description: 'No active Switch server. Use “Add Agent” to choose its server.',
                variant: 'destructive',
              });
              return null;
            }

            const name = basenameFromAnyPath(filePath);
            return await locationManager.createAgent({
              mode: 'pick',
              name,
              path: filePath,
              serverId,
              // Quick-add has no agent-type picker; a dropped Switch agent is
              // detected from its .claude config, so it is a Claude Code agent.
              providerId: 'claude',
            });
          } catch (err) {
            log.error('Failed to add dropped location:', err);
            toast({
              title: 'Cannot add location',
              description: `Failed to add ${basenameFromAnyPath(filePath)} as a location.`,
              variant: 'destructive',
            });
            return null;
          }
        })
      ).then((results) => {
        const locationIds = results.flatMap((r) =>
          r.status === 'fulfilled' && r.value != null ? [r.value] : []
        );
        const firstLocationId = locationIds[0];

        if (firstLocationId) {
          navigate('location', { locationId: firstLocationId });
        }

        if (locationIds.length > 1) {
          toast({
            title: 'Locations added',
            description: `${locationIds.length} locations added.`,
          });
        }
      });
    },
    [navigate, toast]
  );

  return { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop };
}
