/**
 * The slice of the `codex app-server` JSON-RPC protocol this adapter speaks,
 * hand-written from `codex app-server generate-ts` for codex-cli 0.153.2. Only
 * the methods, notifications and fields the adapter actually reads are here;
 * everything else stays untyped on the wire.
 */

export const CODEX_CLIENT_METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const CODEX_CLIENT_NOTIFICATIONS = {
  initialized: 'initialized',
} as const;

export const CODEX_SERVER_NOTIFICATIONS = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  error: 'error',
} as const;

export const CODEX_SERVER_REQUESTS = {
  commandExecutionApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  toolRequestUserInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
} as const;

export type CodexAskForApproval = 'untrusted' | 'on-request' | 'never';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type CodexItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted';

export interface CodexInitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean };
}

export interface CodexThreadConfigParams {
  cwd: string;
  approvalPolicy: CodexAskForApproval;
  sandbox: CodexSandboxMode;
  approvalsReviewer: CodexApprovalsReviewer;
  model?: string;
  developerInstructions?: string;
}

export type CodexThreadStartParams = CodexThreadConfigParams;

export interface CodexThreadResumeParams extends CodexThreadConfigParams {
  threadId: string;
  excludeTurns: boolean;
}

export interface CodexThreadOpenResponse {
  thread: { id: string };
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
  | { type: 'mention'; name: string; path: string };

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  model?: string;
}

export interface CodexTurnSteerParams {
  threadId: string;
  input: CodexUserInput[];
  expectedTurnId: string;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexTurn {
  id: string;
  status: CodexTurnStatus;
  error: { message: string } | null;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTurnSteerResponse {
  turnId: string;
}

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export interface CodexThreadStartedNotification {
  thread: { id: string };
}

export interface CodexThreadStatusChangedNotification {
  threadId: string;
  status: CodexThreadStatus;
}

export interface CodexTurnNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexItemNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message: string };
}

export interface CodexUnknownItem {
  type: string;
  id: string;
}

export type CodexThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: CodexItemStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      status: CodexItemStatus;
      changes: Array<{ path: string; kind: string; diff: string }>;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: CodexItemStatus;
      error: { message?: string } | null;
    }
  | { type: 'dynamicToolCall'; id: string; tool: string; status: CodexItemStatus }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: string;
      status: CodexItemStatus;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
    }
  | {
      type: 'subAgentActivity';
      id: string;
      kind: string;
      agentThreadId: string;
      agentPath: string;
    }
  | { type: 'webSearch'; id: string; query: string | null }
  | { type: 'contextCompaction'; id: string };

export type CodexCommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: unknown }
  | { applyNetworkPolicyAmendment: unknown };

export interface CodexCommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  availableDecisions: CodexCommandApprovalDecision[] | null;
}

export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  grantRoot: string | null;
}

export interface CodexPermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: CodexRequestedPermissionProfile;
}

export interface CodexRequestedPermissionProfile {
  network: { enabled: boolean | null } | null;
  fileSystem: { read: string[] | null; write: string[] | null } | null;
}

export interface CodexToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
}

export interface CodexMcpElicitationParams {
  threadId: string;
  turnId: string | null;
  serverName: string;
  message: string;
}
