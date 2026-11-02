import { z } from 'zod';

const machineCapacitySchema = z
  .object({
    total_bytes: z.number().int().nonnegative(),
    available_bytes: z.number().int().nonnegative(),
  })
  .nullable();

/**
 * The owner's cloud machine. It runs the agent controller, and its agents are
 * managed agents placed on `controller_id` (null until it has enrolled).
 * `sleeping` is Core's reading of desired `stopped` for `idle`; `disk` and
 * `memory` come from the machine's last heartbeat.
 */
export const cloudMachineSchema = z.object({
  machine_id: z.string(),
  state: z.enum([
    'queued',
    'provisioning',
    'ready',
    'stopping',
    'stopped',
    'error',
    'retained',
    'deleting',
    'deleted',
  ]),
  desired_state: z.enum(['running', 'stopped', 'retained', 'deleted']),
  // `paused` and `turned_off` arrive with visibility V3 (an operator's pause, an admin's switch).
  // One this Console doesn't know reads as null rather than failing the whole machine list.
  stop_reason: z.enum(['idle', 'owner', 'paused', 'turned_off']).nullable().catch(null),
  sleeping: z.boolean(),
  revision: z.number().int().positive(),
  instance_type: z.string().nullable(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  retain_until: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  disk: machineCapacitySchema,
  memory: machineCapacitySchema,
  agents: z.array(z.string()),
  controller_id: z.string().nullable(),
  // V3b: after the owner repaired the box, the providers whose AI login this
  // Console is asked to seal again (names only). Absent from an older server;
  // a value out of shape reads as absent rather than failing the machine list.
  reseal_providers: z.array(z.string().min(1).max(64)).max(16).optional().catch(undefined),
  // V3b: whether the owner can press Repair my cloud now (Core sees the box
  // failing to sign in). Absent from an older server, which reads as no.
  repair_available: z.boolean().optional().catch(undefined),
  // Your cloud (visibility L1), from this workspace's controller's last report;
  // null when it doesn't carry them, and from an older server. A value out of
  // shape also reads as null, so one bad field never fails the whole machine
  // list and the cloud card with it.
  room: z
    .object({ used_bytes: z.number().nonnegative(), total_bytes: z.number().positive() })
    .nullable()
    .default(null)
    .catch(null),
  awake: z
    .object({ running: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
    .nullable()
    .default(null)
    .catch(null),
  ai_calls_today: z
    .object({
      used: z.number().int().nonnegative(),
      cap: z.number().int().positive(),
      capped: z.boolean(),
      // A real time, or the block reads as null: never "resets at Invalid Date".
      resets_at: z.iso.datetime({ offset: true }),
    })
    .nullable()
    .default(null)
    .catch(null),
});
export type CloudMachine = z.infer<typeof cloudMachineSchema>;
