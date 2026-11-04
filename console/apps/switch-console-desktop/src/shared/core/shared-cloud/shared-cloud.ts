import { z } from 'zod';
import { STOP_REASON_CODES } from '@shared/core/stop-reasons/stop-reasons';

/**
 * Agents on Switch's shared cloud machines (hosted agents v3). A person sees
 * agents, never a machine: each is working, idle or resting, and a resting
 * agent comes back within seconds of a message.
 *
 * The server scopes all of this to the signed-in user and leaves out message
 * text, prompts, keys and anything about the machines underneath.
 */
export const sharedCloudAgentStateSchema = z.enum([
  'working',
  'idle',
  'resting',
  'waking',
  'unavailable',
]);
export type SharedCloudAgentState = z.infer<typeof sharedCloudAgentStateSchema>;

export const sharedCloudAgentSchema = z.object({
  agent_id: z.string(),
  state: sharedCloudAgentStateSchema,
  /** The room it is replying in, only while working. */
  room_name: z.string().nullable().optional(),
  last_reply_at: z.string().nullable().optional(),
  last_resume_ms: z.number().int().nonnegative().nullable().optional(),
  /**
   * Only with `unavailable`: its host stopped after failing to start several
   * times, so waiting won't help and its owner has to restart it.
   */
  needs_restart: z.boolean().optional(),
  /**
   * Only with `unavailable`: its host isn't running for another reason its
   * machine reported, so its owner should open it and see why.
   */
  needs_check: z.boolean().optional(),
  /** Only with `unavailable`: the box's memory guard stopped this agent; it starts on the next message. */
  memory_stopped: z.boolean().optional(),
  /** Only with `waking`: a new conversation is waiting for room in a full box. */
  waiting_for_room: z.boolean().optional(),
  /** With `resting`: the whole box is stopped after a quiet spell, and starts on the next message. */
  box_stopped: z.boolean().optional(),
  /** With `waking`: the box itself is starting after an idle stop. */
  box_starting: z.boolean().optional(),
  /** With `unavailable`: Switch has paused hosted agents for this person (visibility V2). */
  paused: z.boolean().optional(),
  /** With `unavailable`: a workspace admin has turned hosted agents off for this person (visibility V2). */
  turned_off: z.boolean().optional(),
  /** With `unavailable`: the server's reason (visibility V2), which picks the card's second line. */
  stop_reason: z.enum(STOP_REASON_CODES).optional(),
  /** With a daily cap or budget reason: when it resets. */
  reset_at: z.string().nullable().optional(),
  /** With `login_needed` (V3b): the box was repaired and no Console has acted on the re-seal yet.
   * Console sets it itself; the server never sends it. */
  repair_finishing: z.boolean().optional(),
});
export type SharedCloudAgent = z.infer<typeof sharedCloudAgentSchema>;

export const sharedCloudAgentsResponseSchema = z.object({
  available: z.boolean(),
  agents: z.array(sharedCloudAgentSchema).optional(),
});

const isolationResultSchema = z.enum(['pass', 'fail', 'unknown']);
export type IsolationResult = z.infer<typeof isolationResultSchema>;

/** How much room is left, rounded, for a workspace admin. */
const roomBandSchema = z.enum(['plenty', 'limited', 'full', 'unknown']);
export type RoomBand = z.infer<typeof roomBandSchema>;

const machineSchema = z.object({
  name: z.string(),
  instance_type: z.string(),
  kind: z.enum(['shared', 'burst']),
  memory_total_bytes: z.number().nonnegative(),
  memory_working_bytes: z.number().nonnegative(),
  memory_resting_bytes: z.number().nonnegative(),
  memory_system_bytes: z.number().nonnegative(),
  people: z.number().int().nonnegative(),
  room_for_people: z.number().int().nonnegative().nullable(),
});
export type SharedCloudMachine = z.infer<typeof machineSchema>;

/**
 * The admin's view of the shared cloud.
 *
 * Machines are shared with other workspaces, so a workspace admin gets only
 * their own people and a rounded room band: a machine-wide total would let
 * them subtract their own people and see how busy everyone else is. The
 * `nodes` block, with each machine's figures, comes only to a Switch operator,
 * and the server decides who that is.
 *
 * A figure the server can't read is null, and is shown as unknown, never 0.
 */
export const sharedCloudOverviewSchema = z.object({
  viewer: z.enum(['workspace_admin', 'operator']),
  people: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      agents: z.object({
        working: z.number().int().nonnegative(),
        idle: z.number().int().nonnegative(),
        resting: z.number().int().nonnegative(),
        unavailable: z.number().int().nonnegative(),
      }),
      memory_bytes: z.number().nonnegative().nullable(),
      cost_month_usd: z.number().nonnegative().nullable(),
      kept_apart: isolationResultSchema,
    })
  ),
  room: roomBandSchema,
  cost: z.object({
    per_person_month_usd: z.number().nonnegative().nullable(),
    target_low_usd: z.number().nonnegative(),
    target_high_usd: z.number().nonnegative(),
    estimate: z.boolean(),
  }),
  isolation: z.object({
    result: isolationResultSchema,
    blocked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    checked_at: z.string().nullable(),
    /** The checklist: each attempt, and its result in each direction tested. */
    attempts: z.array(
      z.object({
        label: z.string(),
        results: z.array(z.object({ direction: z.string(), result: isolationResultSchema })),
      })
    ),
  }),
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['warning', 'critical']),
      title: z.string(),
      detail: z.string(),
      raised_at: z.string(),
      cleared_at: z.string().nullable(),
    })
  ),
  /** Operators only. */
  nodes: z
    .object({ machines: z.array(machineSchema) })
    .nullable()
    .optional(),
});
export type SharedCloudOverview = z.infer<typeof sharedCloudOverviewSchema>;
