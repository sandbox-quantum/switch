import type { CommandId } from '@shared/commands';
import type { OnboardingStepId } from '@shared/core/onboarding/checklist';
import type {
  AddServerChoiceName,
  AddServerStepName,
} from '@shared/core/switch-servers/add-server-steps';
import type { ViewIdName } from '@shared/core/views/view-ids';

/**
 * What the interface may report, as the call sites see it.
 *
 * The catalogue in the main process is still the definition of these events;
 * this is the same shape stated where the renderer can reach it, since the two
 * processes share no types. The main process asserts that they agree, so the
 * pair cannot drift — a property added on one side without the other fails the
 * build.
 *
 * Every value is a closed literal. A `string` here would defeat the check on the
 * other side, which is the only thing standing between a value that crossed a
 * process boundary and a payload.
 */
export type RendererTelemetryEvents = {
  /** A screen was opened. */
  view_opened: { view_id: ViewIdName };
  /**
   * A command was run, and how it was reached.
   *
   * No `menu` here: the application menu talks to the interface over its own
   * channels and never reaches a command, so a menu value would be one that can
   * never occur — a gap in a dashboard that looks like a finding.
   */
  command_executed: {
    command_id: CommandId;
    invoked_by: 'palette' | 'shortcut';
  };
  /**
   * A `switch://` link was opened. `resolved` says whether this install actually
   * had the session or room the link named, which is the question worth asking;
   * `cold_start` distinguishes a link that launched the app from one handed to a
   * running window, because they fail differently.
   */
  deeplink_opened: { resolved: boolean; cold_start: boolean };
  /** Someone began a step of the first-run checklist. */
  onboarding_step_started: { step_id: OnboardingStepId };
  /** The checklist was dismissed without finishing it. */
  onboarding_checklist_dismissed: Record<never, never>;
  /** Every step of the checklist is done. */
  onboarding_completed: Record<never, never>;
  /** The add-server wizard reached a step. Where people stop is the question. */
  add_server_step: { step: AddServerStepName; choice: AddServerChoiceName };
  /** A screen failed and the error boundary caught it. */
  renderer_crashed: Record<never, never>;
};

export type RendererTelemetryEventName = keyof RendererTelemetryEvents;
