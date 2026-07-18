import { Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useArrowKeyNavigation } from '@renderer/lib/hooks/use-arrow-key-navigation';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { ActionListItem } from '@renderer/lib/ui/action-list-item';

export const SessionListEmptyState = observer(function SessionListEmptyState({
  locationId,
  subagentName,
}: {
  locationId: string;
  subagentName?: string;
}) {
  const showSessionModal = useShowModal('sessionModal');

  const actions = [
    {
      label: 'New Session',
      description: subagentName
        ? `Spawn a claude session as ${subagentName}`
        : 'Spawn a claude session for this agent',
      icon: Plus,
      onActivate: () => showSessionModal({ locationId, subagentName }),
    },
  ];

  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(actions.length, (index) => {
    actions[index]?.onActivate();
  });

  return (
    <div className="flex h-full flex-col items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-sm flex-col gap-1">
        {actions.map((action, i) => (
          <ActionListItem
            key={action.label}
            label={action.label}
            description={action.description}
            icon={action.icon}
            isSelected={i === selectedIndex}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={action.onActivate}
          />
        ))}
      </div>
    </div>
  );
});
