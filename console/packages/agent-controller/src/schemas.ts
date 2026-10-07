import { z } from 'zod';

/**
 * The wire messages between this controller and Management, as v1 uses them.
 * Field names and types follow `docs/design/controller-contract-v1.md`; where
 * v1 deliberately differs (the definition's shape, the controller stream) it
 * follows `docs/design/agent-controllers-v1.md`.
 *
 * Received messages are parsed with `z.object`, which drops fields it does not
 * know: the contract has receivers ignore unknown fields. A value outside a
 * known enum is read as `unknown` rather than failing the whole message.
 */

export const PROTOCOL_VERSION = 1;

export const PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** The contract's reason codes, plus the ones v1 adds. */
export const REASON_CODES = [
  'protocol_unsupported',
  'token_expired',
  'controller_revoked',
  'not_assigned',
  'taken_over',
  'stale_generation',
  'unknown_connection',
  'already_claimed',
  'cancelled',
  'lease_expired',
  'provider_not_installed',
  'provider_version_unsupported',
  'provider_login_missing',
  'provider_login_expired',
  'connector_not_connected',
  'connector_revoked',
  'definition_invalid',
  'repo_clone_failed',
  'crash_loop',
  'out_of_memory',
  'disk_full',
  'capacity_exceeded',
  'controller_offline',
  'internal',
  'forbidden',
  'invalid_credential',
  'enrollment_code_invalid',
  'operation_unsupported',
  'not_found',
  'validation_error',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** An enum as a receiver reads it: a value it does not know is `unknown`, not an error. */
function receivedEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((value): T[number] | 'unknown' =>
      (values as readonly string[]).includes(value) ? (value as T[number]) : 'unknown'
    );
}

const id = z.string().min(1);
const time = z.string().min(1);
const revision = z.number().int().nonnegative();

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    retry_after_s: z.number().nonnegative().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const platformSchema = z.object({
  os: z.string().min(1),
  arch: z.string().min(1),
  os_version: z.string(),
});
export type Platform = z.infer<typeof platformSchema>;

// §1 Enrollment and authentication

export const enrollRequestSchema = z.object({
  proof: z.object({ kind: z.literal('enrollment_code'), code: z.string().min(1) }),
  controller: z.object({
    kind: z.literal('daemon'),
    name: z.string().min(1),
    /** What the machine is for, shown to its owner and their agents. */
    description: z.string().max(500).optional(),
    platform: platformSchema,
    version: z.string().min(1),
  }),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export const enrollResponseSchema = z.object({ controller_id: id, credential: id });
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const tokenRequestSchema = z.object({ credential: id });

export const tokenResponseSchema = z.object({ access_token: id, expires_at: time });
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const credentialRotateResponseSchema = z.object({ credential: id });

// §2 Assignment (v1 definition)

export const repositoryRefSchema = z.object({
  installation_id: z.number().int().positive(),
  repository_id: z.number().int().positive(),
});
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const repositoryCredentialSchema = z.object({ repository: z.string().min(1) });

export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().nullish(),
  icon_url: z.string().nullish(),
  /** Kept as a string so one agent with a provider this build does not know fails alone. */
  provider: z.string().min(1),
  model: z.string().nullable(),
  /**
   * The provider's advanced configuration, keyed by its field keys as Console
   * names them; unset fields are absent. Kept open here, so a field this build
   * does not know fails its own agent (`definitionProblem`) rather than the
   * whole assignment.
   */
  advanced_config: z.record(
    z.string().min(1),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  ),
  instructions: z.string(),
  auto_approve: z.boolean(),
  directory: z.string().nullable(),
  /** `shared`: the agent host runs in this controller's process; `isolated`: in a process of its own. */
  isolation: receivedEnum(['shared', 'isolated']),
  /**
   * The connection skills the provider is given (GitHub's for an agent that
   * works in a repository), installed by an isolated agent's unit. Checked
   * only as loosely here, so a bad set fails its own agent
   * (`definitionProblem`); absent from a Core that sends none.
   */
  skills: z
    .array(z.object({ slug: z.string(), files: z.record(z.string(), z.string()) }))
    .default([]),
  /**
   * The GitHub repository the agent works in, by id; present only for a
   * definition that names one. An isolated agent's unit clones it, by the
   * name Core answers for it (`ControllerClient.repositoryName`).
   */
  repository: repositoryRefSchema.optional(),
});
export type Isolation = 'shared' | 'isolated';
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const agentAssignmentSchema = z.object({
  agent_id: id,
  revision,
  desired_state: receivedEnum(['running', 'stopped']),
  definition: agentDefinitionSchema,
});
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>;

export const assignmentSchema = z.object({
  revision,
  agents: z.array(agentAssignmentSchema),
});
export type Assignment = z.infer<typeof assignmentSchema>;

// §3 Status

export const PROCESS_STATES = [
  'pending',
  'starting',
  'running',
  'stopping',
  'stopped',
  'crashed',
  'failed',
] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

const reasonCode = z.enum(REASON_CODES);

export const providerStatusSchema = z.object({
  provider: z.enum(PROVIDERS),
  installed: z.boolean(),
  version: z.string().nullable(),
  auth: z.enum(['ok', 'expired', 'missing', 'unknown']),
  auth_source: z.enum(['local', 'sealed']).nullable(),
  checked_at: time,
  reason: reasonCode.optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const toolStatusSchema = z.object({
  tool: z.string().min(1),
  state: z.enum(['ok', 'missing', 'unauthenticated', 'unknown']),
  reason: reasonCode.optional(),
});

export const agentStatusSchema = z
  .object({
    agent_id: id,
    applied_revision: revision.nullable(),
    process: z.enum(PROCESS_STATES),
    attached: z.boolean(),
    sessions: z.object({ active: z.number().int().nonnegative(), ids: z.array(z.string()) }),
    restarts_10m: z.number().int().nonnegative(),
    oom_kills: z.number().int().nonnegative(),
    /** The absolute working directory the agent runs in, or null before one was resolved. */
    directory: z.string().min(1).nullable(),
    since: time,
    reason: reasonCode.optional(),
    detail: z.string().optional(),
  })
  .refine(
    (status) => !['crashed', 'failed'].includes(status.process) || status.reason !== undefined,
    { message: 'A crashed or failed agent needs a reason.' }
  );
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Whether an agent has work in hand, for the server to decide when its machine may sleep. */
export const agentActivitySchema = z.object({
  agent_id: id,
  busy: z.boolean(),
  sessions: z.number().int().nonnegative(),
  last_activity_at: time.nullable(),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

export const statusReportSchema = z.object({
  seq: z.number().int().positive(),
  observed_at: time,
  controller: z.object({
    version: z.string().min(1),
    protocol: z.literal(PROTOCOL_VERSION),
    assignment_revision: revision,
  }),
  machine: z.object({
    platform: platformSchema,
    disk_free_bytes: z.number().nonnegative(),
    disk_total_bytes: z.number().nonnegative(),
    mem_free_bytes: z.number().nonnegative(),
    mem_total_bytes: z.number().nonnegative(),
    sessions_running: z.number().int().nonnegative(),
    sessions_max: z.number().int().nonnegative(),
    /** The absolute directory agents' workspaces are made in when nothing else names one. */
    workspaces_dir: z.string().min(1),
  }),
  providers: z.array(providerStatusSchema),
  tools: z.array(toolStatusSchema),
  agents: z.array(agentStatusSchema),
  activity: z.array(agentActivitySchema).optional(),
});
export type StatusReport = z.infer<typeof statusReportSchema>;

export const statusResponseSchema = z.object({
  assignment_revision: revision,
  report_within_s: z.number().int().positive(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// §4 Operations

export const operationSchema = z.object({
  id,
  /** A string, not an enum: a kind this build does not run is answered `operation_unsupported`. */
  kind: z.string().min(1),
  agent_id: z.string().min(1).nullable(),
  params: z.record(z.string(), z.unknown()),
  created_at: time,
  lease_expires_at: time.nullish(),
});
export type Operation = z.infer<typeof operationSchema>;

export const operationListSchema = z.object({ operations: z.array(operationSchema) });

export const operationProgressSchema = z.object({ message: z.string() });

export const operationResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('succeeded'),
    output: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    outcome: z.literal('failed'),
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
]);
export type OperationResult = z.infer<typeof operationResultSchema>;

// §6 The controller stream (step 10, option B): one stream per controller,
// carrying every bound agent's events beside the management nudges.

const sequence = z.number().int().nonnegative();
const rooms = z.array(z.string().min(1));

/** Where to resume one agent: after this sequence, or from Core's head. */
export const agentCursorSchema = z.union([sequence, z.literal('head')]);
export type AgentCursor = z.infer<typeof agentCursorSchema>;

/**
 * For each bound agent with at least one session working in a room here, those
 * rooms. The whole current map every time: Core replaces what it held.
 */
export const controllerConnectionRequestSchema = z.object({
  client: z.string().min(1),
  client_version: z.string().min(1),
  cursors: z.record(z.string().min(1), agentCursorSchema),
});
export type ControllerConnectionRequest = z.infer<typeof controllerConnectionRequestSchema>;

export const controllerConnectionResponseSchema = z.object({
  connection_id: id,
  generation: z.number().int(),
  heartbeat_interval_s: z.number().positive(),
  /** The agents bound to this controller; each is attached on the stream with `agent.attached`. */
  agents: z.array(id),
});
export type ControllerConnection = z.infer<typeof controllerConnectionResponseSchema>;

export const controllerBeatRequestSchema = z.object({
  connection_id: id,
  generation: z.number().int(),
  cursors: z.record(z.string().min(1), sequence),
});
export type ControllerBeatRequest = z.infer<typeof controllerBeatRequestSchema>;

export const controllerBeatResponseSchema = z.object({ agents: z.array(id) });

/** The stream's first frame. */
export const connectionStateSchema = z.object({
  controller_id: id,
  assignment_revision: revision,
  report_within_s: z.number().int().positive(),
  connection_id: id,
  generation: z.number().int(),
  heartbeat_interval_s: z.number().positive(),
});
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/** The stream ends; `taken_over` is terminal, anything else is recovered by opening again. */
export const evictedSchema = z.object({ code: z.string().min(1), reason: z.string() });
export type Evicted = z.infer<typeof evictedSchema>;

/**
 * The agent-protocol payloads (`event`, `command`, `outcome`) are relayed to
 * the agent's own watcher as they came, so fields this build does not know
 * are kept (`looseObject`) rather than dropped: the watcher is their
 * receiver, not the controller.
 */
export const agentEventFrameSchema = z.object({
  agent_id: id,
  seq: sequence.positive(),
  event: z.looseObject({
    type: z.string().min(1),
    room_id: id,
    payload: z.record(z.string(), z.unknown()),
  }),
});
export type AgentEventFrame = z.infer<typeof agentEventFrameSchema>;

export const agentGapFrameSchema = z.looseObject({
  agent_id: id,
  from_sequence: sequence,
  resumed_at: sequence.optional(),
  rooms: rooms.optional(),
  all_rooms: z.boolean().optional(),
  reason: z.string(),
});
export type AgentGapFrame = z.infer<typeof agentGapFrameSchema>;

/**
 * A room control (`!reset`, `!compact`, `!interrupt`, a Stop press) for
 * whichever session works in `room_id`. Core no longer knows the session
 * (`command.sessionId` is null); the controller does, from the placements
 * its watcher states.
 */
export const agentSessionCommandFrameSchema = z.object({
  agent_id: id,
  room_id: id.nullable(),
  command: z.looseObject({ commandId: z.string().min(1) }),
});
export type AgentSessionCommandFrame = z.infer<typeof agentSessionCommandFrameSchema>;

export const agentApprovalOutcomeFrameSchema = z.object({
  agent_id: id,
  outcome: z.looseObject({
    session_id: id,
    request_id: id,
    state: z.enum(['answered', 'expired']),
  }),
});
export type AgentApprovalOutcomeFrame = z.infer<typeof agentApprovalOutcomeFrameSchema>;

export const agentAttachedFrameSchema = z.object({ agent_id: id, from_seq: sequence, rooms });
export type AgentAttachedFrame = z.infer<typeof agentAttachedFrameSchema>;

export const agentDetachedFrameSchema = z.object({
  agent_id: id,
  reason: receivedEnum(['unassigned', 'deleted']),
});
export type AgentDetachedFrame = z.infer<typeof agentDetachedFrameSchema>;

export const agentRoomsFrameSchema = z.object({ agent_id: id, rooms });
export type AgentRoomsFrame = z.infer<typeof agentRoomsFrameSchema>;

export const assignmentChangedSchema = z.object({ revision });

export const operationPendingSchema = z.object({
  operation_id: id,
  kind: z.string().min(1),
  agent_id: z.string().min(1).nullable(),
});
export type OperationPending = z.infer<typeof operationPendingSchema>;

export const credentialRevokedSchema = z.object({});

/** A login Switch seals for this controller was sealed again or revoked: fetch it again. */
export const providerCredentialChangedSchema = z.object({
  provider: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type ProviderCredentialChanged = z.infer<typeof providerCredentialChangedSchema>;

// Console control relayed through Switch: one request answered by an agent's
// host, and the live views it pushes.

/**
 * A control message for one agent's host, answered by
 * `POST …/control/{relay_id}` before `deadline_ms` (Unix epoch ms). The
 * message is kept unparsed here so a malformed one is answered as refused
 * rather than dropped with the frame.
 */
export const agentControlFrameSchema = z.object({
  relay_id: id,
  agent_id: id,
  message: z.unknown(),
  deadline_ms: z.number().int().nonnegative(),
});
export type AgentControlFrame = z.infer<typeof agentControlFrameSchema>;

/** Switch gave up on the relay; one not yet sent to the agent's host is abandoned. */
export const agentControlCancelFrameSchema = z.object({ relay_id: id });
export type AgentControlCancelFrame = z.infer<typeof agentControlCancelFrameSchema>;

export const controlReplySchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
]);
export type ControlReply = z.infer<typeof controlReplySchema>;

/**
 * One live update of a subscription: a session's event, its host's failure
 * (null once it is up again), or the watcher's health. `seq` counts per
 * agent and subscription from 1 for the controller's lifetime; a skipped
 * number means updates were lost.
 */
export const controlPushEventSchema = z.union([
  z.object({ seq: z.number().int().positive(), event: z.unknown() }),
  z.object({ seq: z.number().int().positive(), failure: z.string().nullable() }),
  z.object({ seq: z.number().int().positive(), health: z.unknown() }),
]);
export type ControlPushEvent = z.infer<typeof controlPushEventSchema>;

/** `subscription` is a session id, or `health` for the watcher's health. */
export const controlPushSchema = z.object({
  agent_id: id,
  subscription: id,
  events: z.array(controlPushEventSchema).min(1),
});
export type ControlPushBody = z.infer<typeof controlPushSchema>;

/** `unsubscribe`: Switch holds no view of the subscription; the controller drops it. */
export const controlPushAnswerSchema = z.object({ unsubscribe: z.boolean().default(false) });
