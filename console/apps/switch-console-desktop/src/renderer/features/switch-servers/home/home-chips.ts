import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';

export type HomeChipId = Exclude<RendererTelemetryEvents['home_action']['chip'], 'none'>;

/** Each suggestion, as it reads on its chip and as the message sent to switch-buddy. */
export const HOME_CHIP_TEXT: Record<HomeChipId, string> = {
  connect_chat_app: "Connect your team's chat app",
  first_agent: 'Create my first agent',
  team_room: 'Create a room for my team',
  new_room: 'Create a new room',
  new_agent: 'Create a new agent',
  room_instructions: 'Edit room instructions',
};

/** The most chips Home shows. */
const MAX_CHIPS = 3;

/** A default left out when the suggestion that says the same thing for a first time is shown. */
const SAME_AS: Partial<Record<HomeChipId, HomeChipId>> = {
  new_agent: 'first_agent',
  new_room: 'team_room',
};

/**
 * The suggestions under the switch-buddy box: the ones the workspace calls
 * for first, then the defaults, at most three and none saying the same thing
 * twice.
 */
export function homeChips(inputs: {
  /** Whether a messaging app is connected to the workspace. */
  hasMessagingApp: boolean;
  /** Whether the account may manage the workspace, and so connect one. */
  isAdmin: boolean;
  /** Agents other than switch-buddy. */
  otherAgentCount: number;
  /** Rooms other than switch-buddy's chat. */
  otherRoomCount: number;
}): HomeChipId[] {
  const conditional: HomeChipId[] = [
    ...(!inputs.hasMessagingApp && inputs.isAdmin ? (['connect_chat_app'] as const) : []),
    ...(inputs.otherAgentCount === 0 ? (['first_agent'] as const) : []),
    ...(inputs.otherRoomCount === 0 ? (['team_room'] as const) : []),
  ];
  const defaults: HomeChipId[] = ['new_room', 'new_agent', 'room_instructions'];
  const shown = defaults.filter((chip) => {
    const same = SAME_AS[chip];
    return same === undefined || !conditional.includes(same);
  });
  return [...conditional, ...shown].slice(0, MAX_CHIPS);
}
