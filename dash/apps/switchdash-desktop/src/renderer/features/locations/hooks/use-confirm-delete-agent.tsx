import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

export function useConfirmDeleteAgent() {
  const showConfirmDeleteProject = useShowModal('confirmActionModal');

  return async ({
    locationId,
    projectLabel,
    onDeleted,
  }: {
    locationId: string;
    projectLabel: string;
    onDeleted?: () => void;
  }) => {
    showConfirmDeleteProject({
      title: 'Remove agent',
      description: `"${projectLabel}" will be removed from switchdash. The folder stays on the filesystem.`,
      confirmLabel: 'Remove',
      onSuccess: () => {
        void getLocationManagerStore().removeLocation(locationId);
        onDeleted?.();
      },
    });
  };
}
