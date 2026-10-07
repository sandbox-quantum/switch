import { z } from 'zod';
import type { AddressingPolicy } from './switch-servers';

/** A grant giving an agent access to its owner's connection to a service. */
export const serviceGrantSchema = z.object({
  service: z.string(),
  name: z.string(),
  access: z.enum(['read', 'write']),
  resources: z.record(z.string(), z.unknown()),
  /** What the grant lets the agent do, in a sentence. */
  summary: z.string(),
});
export type ServiceGrant = z.infer<typeof serviceGrantSchema>;

/** A grant the agent works without (a cloud agent's repository), with the one that restores it. */
export const missingServiceGrantSchema = z.object({
  service: z.string(),
  reason: z.string(),
  access: z.enum(['read', 'write']),
  resources: z.record(z.string(), z.unknown()),
});
export type MissingServiceGrant = z.infer<typeof missingServiceGrantSchema>;

export const serviceGrantsSchema = z.object({
  grants: z.array(serviceGrantSchema),
  missing: z.array(missingServiceGrantSchema),
  /** Whether anyone can address the agent, and so use its grants. */
  addressing_open: z.boolean(),
});
export type ServiceGrants = z.infer<typeof serviceGrantsSchema>;

/** What a grant change can leave behind: access already handed out, usable for a while. */
export const serviceGrantWarningSchema = z.object({ warning: z.string().nullable() });

/**
 * Owner-only addressing: the owner, and agents the owner runs. What the grant
 * screens offer when anyone can address an agent with grants.
 */
export const OWNER_ONLY_POLICY: AddressingPolicy = {
  rules: [
    {
      rooms: '*',
      room_groups: '*',
      users: [],
      agents: [],
      owner: true,
      owner_agents: true,
    },
  ],
};
