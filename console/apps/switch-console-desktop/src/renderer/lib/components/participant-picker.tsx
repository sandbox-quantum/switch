import {
  type ParticipantMarks,
  ParticipantPicker as SharedParticipantPicker,
} from '@switch-console/chat-ui/components/participant-picker';
import type { ComponentProps } from 'react';
import { useAgentAccent } from '@renderer/lib/components/agent-accent';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';

/** Agents as Switch Console draws them. */
export const CONSOLE_PARTICIPANT_MARKS: ParticipantMarks = { AgentAvatar, useAgentAccent };

/** The shared picker, drawing agents as Switch Console does. */
export function ParticipantPicker(
  props: Omit<ComponentProps<typeof SharedParticipantPicker>, 'marks'>
) {
  return <SharedParticipantPicker {...props} marks={CONSOLE_PARTICIPANT_MARKS} />;
}
