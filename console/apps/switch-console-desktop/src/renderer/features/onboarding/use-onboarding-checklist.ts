import { useCallback, useEffect } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-switch-setup';
import { report } from '@renderer/lib/telemetry/report';
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
  /** Hide the checklist. Routed through here so both dismiss buttons agree. */
  dismiss: () => void;
};

/**
 * The checklist as the UI consumes it: the derived steps plus the action each
 * one runs. Every destination already exists in the app; the checklist is a
 * second, always-visible way in, not a new flow.
 */
export function useOnboardingChecklist(): OnboardingChecklist {
  const progress = useOnboardingProgress();
  const { value: onboarding } = useAppSettingsKey('onboarding');
  const showAddServerModal = useShowModal('addServerModal');
  const showAddAgentModal = useShowModal('addAgentModal');
  const showCreateRoomModal = useShowModal('createRoomModal');
  const { navigate } = useNavigate();

  const startStep = useCallback(
    (id: OnboardingStepId) => {
      report('onboarding_step_started', { step_id: id });
      switch (id) {
        case 'addServer':
          showAddServerModal({});
          return;
        case 'agentProviders':
          navigate('settings', { tab: 'clis-models' });
          return;
        case 'onboardAgents':
          showAddAgentModal({ entryPoint: 'onboarding' });
          return;
        case 'createRoom':
          showCreateRoomModal({});
          return;
      }
    },
    [showAddServerModal, showAddAgentModal, showCreateRoomModal, navigate]
  );

  const complete = isOnboardingComplete(progress);

  const dismiss = useCallback(() => {
    if (!onboarding) return;
    report('onboarding_checklist_dismissed', {});
    void rpc.appSettings.update('onboarding', { ...onboarding, showChecklist: false });
  }, [onboarding]);

  // Completion is a condition, not an event: it becomes true during a render and
  // is true again on every later launch. Asking more than once is harmless —
  // the main process keeps the record of whether it has already been reported,
  // because that record is our bookkeeping and not one of the user's settings.
  useEffect(() => {
    if (!complete) return;
    report('onboarding_completed', {});
  }, [complete]);

  return {
    steps: deriveOnboardingSteps(progress),
    complete,
    dismiss,
    startStep,
  };
}
