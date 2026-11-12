import { z } from 'zod';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS, type CommandId } from '@shared/commands';
import { ADD_SERVER_CHOICES, ADD_SERVER_STEPS } from '@shared/core/switch-servers/add-server-steps';
import { VIEW_IDS } from '@shared/core/views/view-ids';
import type { TelemetryEventMap, TelemetryEventName } from './events';
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
 * command was run, where someone stopped in the first run — and there is no way
 * to observe them from the other side.
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
  add_server_step: z.object({
    step: z.enum(ADD_SERVER_STEPS),
    choice: z.enum(ADD_SERVER_CHOICES),
    first_run: z.boolean(),
  }),
  onboarding_page: z.object({
    page: z.enum([
      'welcome',
      'how_to_run',
      'local_setup',
      'server_address',
      'sign_in',
      'choose_workspace',
      'create_workspace',
      'meet_buddy',
      'provider_setup',
    ]),
    path: z.enum(['none', 'cloud', 'local', 'external']),
  }),
  buddy_step: z.object({
    action: z.enum([
      'start',
      'skip',
      'setup_opened',
      'install',
      'sign_in',
      'check_again',
      'create_failed',
      'opened_existing',
      'intro_opened',
      'intro_dismissed',
    ]),
    provider: z.enum([
      'claude',
      'codex',
      'opencode',
      'cursor',
      'antigravity',
      'deepseek-harness',
      'pi',
      'copilot',
      'kiro',
      'mistral-vibe',
      'goose',
      'qwen',
      'droid',
      'cline',
      'junie',
      'grok',
      'none',
    ]),
  }),
  renderer_crashed: z.object({}),
} as const satisfies {
  [K in RendererTelemetryEvent]: z.ZodType<TelemetryEventMap[K]>;
};

/**
 * What this gate lets through is exactly what the catalogue declares.
 *
 * Comparing `RendererTelemetryEvents` to `TelemetryEventMap` would prove
 * nothing — the catalogue *defines* those events as the shared shapes
 * (see `./events`), so the two sides are the same type by construction and any
 * such assertion is a tautology. The pair that can genuinely disagree is the
 * schema and the shape: a schema is hand-written, and one that forgets a
 * property parses a payload without it, strips it, and reports an event missing
 * a dimension.
 *
 * So the check is on the schemas' *output*. The `satisfies` above already
 * refuses a schema that omits a required property; this refuses the other
 * direction, a schema that admits one the catalogue does not declare.
 *
 * Written as `[X] extends [never]` rather than indexing the map by the union:
 * an indexed access distributes and then collapses, so `true | never` is `true`
 * and only an *every* event mismatch would fail. That is how the assertion this
 * replaces passed while being wrong.
 *
 * Read off `shape` rather than `z.infer`, which widens the two property-less
 * schemas to a `keyof` of `string` — a check whose failure mode is "every event
 * looks wrong" is no more use than one that never fails.
 */
type SchemaExtra = {
  [K in RendererTelemetryEvent]: Exclude<
    keyof (typeof RENDERER_TELEMETRY_SCHEMAS)[K]['shape'],
    keyof TelemetryEventMap[K]
  >;
}[RendererTelemetryEvent];

const _schemasAddNothing: [SchemaExtra] extends [never] ? true : never = true;
void _schemasAddNothing;

/** Every event the interface may report is one the catalogue knows about. */
const _rendererEventsAreCatalogued: [Exclude<RendererTelemetryEvent, TelemetryEventName>] extends [
  never,
]
  ? true
  : never = true;
void _rendererEventsAreCatalogued;

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
  | 'add_server_step'
  | 'onboarding_page'
  | 'buddy_step'
  | 'renderer_crashed';

export type RendererTelemetryRequest = {
  name: RendererTelemetryEvent;
  properties: Record<string, unknown>;
};

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

  trackEvent(request.name, parsed.data as TelemetryEventMap[RendererTelemetryEvent]);
}
