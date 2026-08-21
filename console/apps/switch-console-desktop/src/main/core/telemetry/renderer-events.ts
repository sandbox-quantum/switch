import { z } from 'zod';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS, type CommandId } from '@shared/commands';
import { ONBOARDING_STEP_IDS } from '@shared/core/onboarding/checklist';
import { ADD_SERVER_CHOICES, ADD_SERVER_STEPS } from '@shared/core/switch-servers/add-server-steps';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';
import { VIEW_IDS } from '@shared/core/views/view-ids';
import type { TelemetryEventMap } from './events';
import { trackEvent } from './telemetry-service';

/**
 * The command ids that exist, as a set to check a received value against.
 *
 * Derived from the definitions rather than listed again: the ids are already
 * written down once, and a second copy is a second thing to forget.
 */
const COMMAND_IDS = new Set<string>(ALL_COMMAND_DEFS.map((c) => c.id));

const commandId = z.custom<CommandId>(
  (value) => typeof value === 'string' && COMMAND_IDS.has(value)
);

/**
 * The events the user interface may ask for, and the only values it may supply.
 *
 * Most of what the app reports happens in the main process, where a call site is
 * type-checked against the catalogue and reviewed. These are the exceptions:
 * moments that exist only in the interface — which screen was opened, which
 * command was run, where someone stopped in a checklist — and there is no way to
 * observe them from the other side.
 *
 * This is a gate, not a second emitter. Nothing here builds or sends a payload:
 * a validated call goes to the same `trackEvent`, the same consent check and the
 * same property filter as every other event. What it adds is the one thing the
 * main process cannot take on trust — that a value which crossed a process
 * boundary is still one of the values the catalogue allows. A type does not
 * survive that crossing; these schemas are what replaces it.
 *
 * Adding an event here is therefore a wider decision than adding one in the main
 * process, and the list is meant to stay short. If a moment can be observed from
 * the main process, observe it there.
 */
const RENDERER_TELEMETRY_SCHEMAS = {
  view_opened: z.object({ view_id: z.enum(VIEW_IDS) }),
  command_executed: z.object({
    command_id: commandId,
    invoked_by: z.enum(['palette', 'shortcut']),
  }),
  deeplink_opened: z.object({ resolved: z.boolean(), cold_start: z.boolean() }),
  onboarding_step_started: z.object({ step_id: z.enum(ONBOARDING_STEP_IDS) }),
  onboarding_checklist_dismissed: z.object({}),
  onboarding_completed: z.object({}),
  add_server_step: z.object({
    step: z.enum(ADD_SERVER_STEPS),
    choice: z.enum(ADD_SERVER_CHOICES),
  }),
  renderer_crashed: z.object({}),
} as const satisfies {
  [K in RendererTelemetryEvent]: z.ZodType<TelemetryEventMap[K]>;
};

/**
 * The shapes the renderer is compiled against are the shapes this validates to.
 *
 * The two processes share no types, so the renderer states these events again in
 * `@shared`. This asserts the restatement still matches the catalogue: a
 * property added on one side without the other stops the build rather than
 * producing a call site whose value is silently dropped here.
 */
type RendererShapesMatchCatalogue = {
  [K in RendererTelemetryEvent]: RendererTelemetryEvents[K] extends TelemetryEventMap[K]
    ? TelemetryEventMap[K] extends RendererTelemetryEvents[K]
      ? true
      : never
    : never;
};
const _rendererShapesMatch: RendererShapesMatchCatalogue[RendererTelemetryEvent] = true;
void _rendererShapesMatch;

/**
 * The events the interface is allowed to report.
 *
 * Named as a union rather than derived from the schema map, so that widening the
 * map is a deliberate edit in two places rather than a side effect of adding a
 * schema.
 */
export type RendererTelemetryEvent =
  | 'view_opened'
  | 'command_executed'
  | 'deeplink_opened'
  | 'onboarding_step_started'
  | 'onboarding_completed'
  | 'onboarding_checklist_dismissed'
  | 'add_server_step'
  | 'renderer_crashed';

export type RendererTelemetryRequest = {
  name: RendererTelemetryEvent;
  properties: Record<string, unknown>;
};

/**
 * Events that describe a state rather than a moment, and so are reported once
 * for the life of an install.
 *
 * Finishing onboarding is the case this exists for: it is derived from a server
 * and a room existing, so it is true from the instant it becomes true and true
 * again on every later launch. Without this it would be counted once per
 * start-up forever, and "people who finished setting up" would grow without
 * anyone finishing anything.
 *
 * The record lives here, beside the emitter, rather than in the user's settings:
 * it is our bookkeeping, and writing it as a setting would report a setting the
 * user never changed.
 */
const ONCE_PER_INSTALL = new Set<RendererTelemetryEvent>(['onboarding_completed']);

const reportedOnce = new KV<Record<string, boolean>>('telemetry:reported');

/**
 * Whether this once-only event has already been sent, claiming it if not.
 *
 * The in-memory guard matters as much as the stored one: the renderer can ask
 * several times in the same tick — a condition becoming true re-renders
 * everything watching it — and the database write does not land in time to stop
 * the second caller.
 */
const claimedThisRun = new Set<RendererTelemetryEvent>();

async function claimOnce(name: RendererTelemetryEvent): Promise<boolean> {
  if (claimedThisRun.has(name)) return false;
  claimedThisRun.add(name);
  if ((await reportedOnce.get(name)) === true) return false;
  await reportedOnce.set(name, true);
  return true;
}

/**
 * Report an event the interface observed, if it is one it may report.
 *
 * A request naming an event that is not on the list, or carrying a value that is
 * not one the catalogue allows, is dropped rather than sent — and said out loud,
 * because it means a call site and this list disagree, which is a bug in the app
 * and not something a user should be transmitting on behalf of.
 */
export function trackFromRenderer(request: RendererTelemetryRequest): void {
  const schema = RENDERER_TELEMETRY_SCHEMAS[request.name];
  if (!schema) {
    log.warn('telemetry: renderer asked for an event it may not send', {
      event: 'telemetry_renderer_rejected',
      telemetryEvent: request.name,
      reason: 'not_permitted',
    });
    return;
  }

  const parsed = schema.safeParse(request.properties);
  if (!parsed.success) {
    // The values are deliberately not logged: a value that failed this check is
    // exactly the kind of thing that must not be written down either.
    log.warn('telemetry: renderer sent a value the catalogue does not allow', {
      event: 'telemetry_renderer_rejected',
      telemetryEvent: request.name,
      reason: 'invalid_properties',
    });
    return;
  }

  const properties = parsed.data as TelemetryEventMap[RendererTelemetryEvent];
  if (!ONCE_PER_INSTALL.has(request.name)) {
    trackEvent(request.name, properties);
    return;
  }

  void claimOnce(request.name)
    .then((first) => {
      if (first) trackEvent(request.name, properties);
    })
    .catch(() => {
      // A record we cannot read is not a reason to report a second time: the
      // duplicate is the failure mode this exists to prevent.
    });
}
