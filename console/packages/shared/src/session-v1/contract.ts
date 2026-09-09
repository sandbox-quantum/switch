/** Session interaction wire contract, version 1. */
export type Id = string;
export type Surface =
  | 'console'
  | 'switch-web'
  | 'slack'
  | 'mattermost'
  | 'discord'
  | 'teams'
  | 'telegram';
export type Provider = 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor';
export type Origin = {
  surface: Surface;
  actorId: Id;
  roomId: Id | null;
  threadId: Id | null;
  messageId: Id | null;
};
export type Capability = {
  input: 'queue' | 'steer';
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  reset: boolean;
  compact: boolean;
  modelChange: boolean;
  attachmentMimeTypes: string[];
};
export type Attachment = {
  attachmentId: Id;
  name: string;
  mimeType: string;
  bytes: number;
};
export type Item = {
  itemId: Id;
  turnId: Id;
  revision: number;
  kind: 'user-message' | 'assistant-message' | 'tool-activity';
  status: 'in-progress' | 'completed' | 'failed' | 'declined';
  title: string;
  text: string;
  attachments: Attachment[];
  origin: Origin | null;
};
export type ApprovalOption = {
  optionId: Id;
  label: string;
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
};
export type Question = {
  questionId: Id;
  title: string;
  prompt: string;
  options: { optionId: Id; label: string; description: string | null }[];
  multiSelect: boolean;
  allowCustomAnswer: boolean;
};
export type Answer = { questionId: Id; selectedOptionIds: Id[]; customText: string | null };
export type RequestContent =
  | { kind: 'approval'; title: string; detail: string | null; options: ApprovalOption[] }
  | { kind: 'questions'; title: string; questions: Question[] };
export type Request = {
  requestId: Id;
  turnId: Id;
  revision: number;
  state: 'open' | 'submitting' | 'resolved' | 'closed';
  content: RequestContent;
  expiresAt: string | null;
};
export type Session = {
  sessionId: Id;
  agentId: Id;
  provider: Provider;
  hostId: Id;
  epoch: Id;
  status: 'starting' | 'ready' | 'running' | 'stopped' | 'error';
  connectivity: 'online' | 'offline';
  capabilities: Capability;
  pendingRequestIds: Id[];
};
export type HostBody =
  | { type: 'session.upsert'; session: Session }
  | {
      type: 'turn.upsert';
      turnId: Id;
      status: 'queued' | 'running' | 'completed' | 'interrupted' | 'error';
      commandId: Id | null;
    }
  | { type: 'item.upsert'; item: Item }
  | { type: 'request.opened'; request: Request }
  | {
      type: 'request.settled';
      requestId: Id;
      revision: number;
      outcome: 'answered' | 'cancelled' | 'expired' | 'interrupted' | 'provider-error';
      commandId: Id | null;
      result: { kind: 'approval'; optionId: Id } | { kind: 'questions'; answers: Answer[] } | null;
    }
  | {
      type: 'command.result';
      commandId: Id;
      status: 'applied' | 'rejected';
      code: string | null;
      message: string | null;
    }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; code: string; message: string };
export type HostEvent = {
  contractVersion: 1;
  eventId: Id;
  sessionId: Id;
  epoch: Id;
  hostSequence: number;
  occurredAt: string;
  body: HostBody;
};
export type CommandBody =
  | {
      type: 'message.send';
      text: string;
      attachments: Attachment[];
      delivery: 'queue' | 'steer';
    }
  | {
      type: 'request.answer';
      requestId: Id;
      expectedRevision: number;
      answer: { kind: 'approval'; optionId: Id } | { kind: 'questions'; answers: Answer[] };
    }
  | { type: 'turn.interrupt'; turnId: Id }
  | { type: 'session.stop' }
  | { type: 'session.reset' }
  | { type: 'session.compact' }
  | { type: 'session.model.set'; modelId: string; options: Record<string, string> };
/** The server sets origin from a verified identity. Do not trust origin from a client. */
export type Command = {
  contractVersion: 1;
  commandId: Id;
  sessionId: Id;
  epoch: Id;
  origin: Origin;
  body: CommandBody;
};
export type ServerBody =
  | HostBody
  | {
      type: 'command.status';
      commandId: Id;
      status: 'accepted' | 'dispatched' | 'applied' | 'rejected' | 'unknown';
      code: string | null;
      message: string | null;
    }
  | {
      type: 'request.submitting';
      requestId: Id;
      revision: number;
      commandId: Id;
      actorId: Id;
      surface: Surface;
    }
  | { type: 'session.connectivity'; connectivity: 'online' | 'offline' };
export type ServerEvent = {
  contractVersion: 1;
  eventId: Id;
  sessionId: Id;
  sequence: number;
  occurredAt: string;
  body: ServerBody;
};
export type Snapshot = {
  contractVersion: 1;
  throughSequence: number;
  session: Session;
  turns: Extract<HostBody, { type: 'turn.upsert' }>[];
  items: Item[];
  requests: (Request & {
    result: Extract<HostBody, { type: 'request.settled' }> | null;
    decidedBy: { actorId: Id; surface: Surface; commandId: Id } | null;
  })[];
  commandStatuses: Extract<ServerBody, { type: 'command.status' }>[];
  nextPageToken: string | null;
};
