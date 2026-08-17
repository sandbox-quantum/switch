import { useCallback } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-switch-setup';
import {
  deriveOnboardingSteps,
  isOnboardingComplete,
  type OnboardingProgress,
  type OnboardingStep,
  type OnboardingStepId,
} from '@shared/core/onboarding/checklist';

/**
 * Live answer to "which setup steps are done", read from the things the steps
 * produce rather than from a record of what the user clicked.
 *
 * Callers must be MobX `observer`s: server, agent and room state are observable
 * stores, so a plain component would render once and then miss every change.
 *
 * Anything not yet loaded reads as *not done*. That direction is deliberate —
 * an unfinished step wrongly shown as pending costs a glance, while a finished
 * one wrongly shown as done sends someone looking for a thing they already have.
 */
export function useOnboardingProgress(): OnboardingProgress {
  const { data: agentTypes } = useAgentTypeAvailability();

  return {
    addServer: switchServersStore.servers.length > 0,
    agentProviders: (agentTypes ?? []).some((type) => type.available),
    onboardAgents: appState.locations.locations.size > 0,
    createRoom: switchRoomsStore.listedRoomsOnAllServers.length > 0,
  };
}

export type OnboardingChecklist = {
  steps: OnboardingStep[];
  complete: boolean;
  /** Opens whatever that step asks for — a dialog, or the settings tab. */
  startStep: (id: OnboardingStepId) => void;
};

/**
 * The checklist as the UI consumes it: the derived steps plus the action each
 * one runs. Every destination already exists in the app; the checklist is a
 * second, always-visible way in, not a new flow.
 */
export function useOnboardingChecklist(): OnboardingChecklist {
  const progress = useOnboardingProgress();
  const showAddServerModal = useShowModal('addServerModal');
  const showAddAgentModal = useShowModal('addAgentModal');
  const showCreateRoomModal = useShowModal('createRoomModal');
  const { navigate } = useNavigate();

  const startStep = useCallback(
    (id: OnboardingStepId) => {
      switch (id) {
        case 'addServer':
          showAddServerModal({});
          return;
        case 'agentProviders':
          navigate('settings', { tab: 'clis-models' });
          return;
        case 'onboardAgents':
          showAddAgentModal({});
          return;
        case 'createRoom':
          showCreateRoomModal({});
          return;
      }
    },
    [showAddServerModal, showAddAgentModal, showCreateRoomModal, navigate]
  );

  return {
    steps: deriveOnboardingSteps(progress),
    complete: isOnboardingComplete(progress),
    startStep,
  };
}
