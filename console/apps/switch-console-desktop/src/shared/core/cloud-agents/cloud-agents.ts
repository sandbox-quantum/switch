import { z } from 'zod';

const machineCapacitySchema = z
  .object({
    total_bytes: z.number().int().nonnegative(),
    available_bytes: z.number().int().nonnegative(),
  })
  .nullable();

/**
 * The owner's cloud machine. It runs the agents controller, and its agents are
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
  stop_reason: z.enum(['idle', 'owner']).nullable(),
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
});
export type CloudMachine = z.infer<typeof cloudMachineSchema>;
