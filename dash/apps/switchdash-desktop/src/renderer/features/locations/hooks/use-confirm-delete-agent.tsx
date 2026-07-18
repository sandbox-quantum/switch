import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

export function useConfirmDeleteAgent() {
  const showConfirmDeleteLocation = useShowModal('confirmActionModal');

  return async ({
    locationId,
    locationLabel,
    onDeleted,
  }: {
    locationId: string;
    locationLabel: string;
    onDeleted?: () => void;
  }) => {
    showConfirmDeleteLocation({
      title: 'Remove agent',
      description: `"${locationLabel}" will be removed from switchdash. The folder stays on the filesystem.`,
      confirmLabel: 'Remove',
      onSuccess: () => {
        void getLocationManagerStore().removeLocation(locationId);
        onDeleted?.();
      },
    });
  };
}
