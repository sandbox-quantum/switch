import { z } from 'zod';
import type { Command, HostEvent, ServerEvent, Snapshot } from './contract';

const id = z.string().min(1);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = counter;
const sequence = counter.min(1);
const timestamp = z.iso.datetime();
const surface = z.enum([
  'console',
  'switch-web',
  'slack',
  'mattermost',
  'discord',
  'teams',
  'telegram',
]);
const origin = z.strictObject({
  surface,
  actorId: id,
  roomId: id.nullable(),
  threadId: id.nullable(),
  messageId: id.nullable(),
});
const capabilities = z.strictObject({
  input: z.enum(['queue', 'steer']),
  approvals: z.boolean(),
  questions: z.boolean(),
  interrupt: z.boolean(),
  reset: z.boolean(),
  compact: z.boolean(),
  modelChange: z.boolean(),
  attachmentMimeTypes: z.array(z.string()),
});
const attachment = z.strictObject({
  attachmentId: id,
  name: z.string(),
  mimeType: z.string(),
  bytes: counter,
});
const item = z.strictObject({
  itemId: id,
  turnId: id,
  revision,
  kind: z.enum(['user-message', 'assistant-message', 'tool-activity']),
  status: z.enum(['in-progress', 'completed', 'failed', 'declined']),
  title: z.string(),
  text: z.string(),
  attachments: z.array(attachment),
  origin: origin.nullable(),
});
const option = z.strictObject({
  optionId: id,
  label: z.string(),
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
});
const question = z.strictObject({
  questionId: id,
  title: z.string(),
  prompt: z.string(),
  options: z.array(
    z.strictObject({ optionId: id, label: z.string(), description: z.string().nullable() })
  ),
  multiSelect: z.boolean(),
  allowCustomAnswer: z.boolean(),
});
const answer = z.strictObject({
  questionId: id,
  selectedOptionIds: z.array(id),
  customText: z.string().nullable(),
});
const result = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approval'), optionId: id }),
  z.strictObject({ kind: z.literal('questions'), answers: z.array(answer) }),
]);
const request = z.strictObject({
  requestId: id,
  turnId: id,
  revision,
  state: z.enum(['open', 'submitting', 'resolved', 'closed']),
  content: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('approval'),
      title: z.string(),
      detail: z.string().nullable(),
      options: z.array(option),
    }),
    z.strictObject({
      kind: z.literal('questions'),
      title: z.string(),
      questions: z.array(question),
    }),
  ]),
  expiresAt: timestamp.nullable(),
});
export const sessionSchema = z.strictObject({
  sessionId: id,
  agentId: id,
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'cursor']),
  hostId: id,
  epoch: id,
  status: z.enum(['starting', 'ready', 'running', 'stopped', 'error']),
  connectivity: z.enum(['online', 'offline']),
  capabilities,
  pendingRequestIds: z.array(id),
  models: z
    .array(
      z.strictObject({ id, label: z.string(), options: z.record(z.string(), z.array(z.string())) })
    )
    .optional(),
  model: z
    .strictObject({ id, options: z.record(z.string(), z.string()) })
    .nullable()
    .optional(),
});
const turn = z.strictObject({
  type: z.literal('turn.upsert'),
  turnId: id,
  status: z.enum(['queued', 'running', 'completed', 'interrupted', 'error']),
  commandId: id.nullable(),
});
const settlement = z.strictObject({
  type: z.literal('request.settled'),
  requestId: id,
  revision,
  outcome: z.enum(['answered', 'cancelled', 'expired', 'interrupted', 'provider-error']),
  commandId: id.nullable(),
  result: result.nullable(),
});
export const commandStatusSchema = z.strictObject({
  type: z.literal('command.status'),
  commandId: id,
  status: z.enum(['accepted', 'dispatched', 'applied', 'rejected', 'unknown']),
  code: z.string().nullable(),
  message: z.string().nullable(),
});
const hostBodies = [
  z.strictObject({ type: z.literal('session.upsert'), session: sessionSchema }),
  turn,
  z.strictObject({ type: z.literal('item.upsert'), item }),
  z.strictObject({ type: z.literal('request.opened'), request }),
  settlement,
  z.strictObject({
    type: z.literal('command.result'),
    commandId: id,
    status: z.enum(['applied', 'rejected', 'unknown']),
    code: z.string().nullable(),
    message: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    code: id,
    message: z.string(),
  }),
] as const;
const base = { contractVersion: z.literal(1), eventId: id, sessionId: id, occurredAt: timestamp };
export const hostEventSchema: z.ZodType<HostEvent> = z.strictObject({
  ...base,
  epoch: id,
  hostSequence: sequence,
  body: z.discriminatedUnion('type', hostBodies),
});
export const serverEventSchema: z.ZodType<ServerEvent> = z.strictObject({
  ...base,
  sequence,
  body: z.discriminatedUnion('type', [
    ...hostBodies,
    commandStatusSchema,
    z.strictObject({
      type: z.literal('request.submitting'),
      requestId: id,
      revision,
      commandId: id,
      actorId: id,
      surface,
    }),
    z.strictObject({
      type: z.literal('session.connectivity'),
      connectivity: z.enum(['online', 'offline']),
    }),
  ]),
});
export const snapshotSchema: z.ZodType<Snapshot> = z.strictObject({
  contractVersion: z.literal(1),
  throughSequence: counter,
  session: sessionSchema,
  turns: z.array(turn),
  items: z.array(item),
  requests: z.array(
    request.extend({
      result: settlement.nullable(),
      decidedBy: z.strictObject({ actorId: id, surface, commandId: id }).nullable(),
    })
  ),
  commandStatuses: z.array(commandStatusSchema),
  nextPageToken: id.nullable(),
});
export const commandSchema: z.ZodType<Command> = z.strictObject({
  contractVersion: z.literal(1),
  commandId: id,
  sessionId: id,
  epoch: id,
  origin,
  body: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('message.send'),
      text: z.string(),
      attachments: z.array(attachment),
      delivery: z.enum(['queue', 'steer']),
    }),
    z.strictObject({
      type: z.literal('request.answer'),
      requestId: id,
      expectedRevision: revision,
      answer: result,
    }),
    z.strictObject({ type: z.literal('turn.interrupt'), turnId: id }),
    z.strictObject({ type: z.literal('session.stop') }),
    z.strictObject({ type: z.literal('session.reset') }),
    z.strictObject({ type: z.literal('session.compact') }),
    z.strictObject({
      type: z.literal('session.model.set'),
      modelId: id,
      options: z.record(z.string(), z.string()),
    }),
  ]),
});

export function eventBytes(event: unknown): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}
export function parseHostEvent(input: unknown): HostEvent {
  if (eventBytes(input) > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE: event exceeds 64 KiB.');
  const event = hostEventSchema.parse(input);
  if (
    event.body.type === 'session.upsert' &&
    (event.body.session.sessionId !== event.sessionId || event.body.session.epoch !== event.epoch)
  )
    throw new Error('Session identity does not match event envelope.');
  return event;
}
