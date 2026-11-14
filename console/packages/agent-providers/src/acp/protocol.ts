import type { ModelChoice } from '@switch-console/shared/session-v1';

/**
 * The slice of the Agent Client Protocol (https://agentclientprotocol.com) the
 * generic adapter reads. Agents send more; anything not named here is ignored
 * unless a provider's hooks pick it up.
 */

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: { resume?: unknown };
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: Array<{ id?: string; name?: string }>;
}

export interface AcpConfigChoice {
  value: string;
  name: string;
}

export interface AcpConfigOption {
  id: string;
  type: string;
  /** What the option controls; `thought_level` is the model's reasoning effort. */
  category?: string;
  currentValue?: string;
  options?: Array<AcpConfigChoice | { options: AcpConfigChoice[] }>;
}

export interface AcpSessionModels {
  availableModels: Array<{ modelId: string; name: string }>;
  currentModelId?: string;
}

export interface AcpSessionModes {
  availableModes: Array<{ id: string; name?: string }>;
  currentModeId?: string;
}

/** What `session/new`, `session/load` and `session/resume` answer. */
export interface AcpSessionResult {
  sessionId?: string;
  models?: AcpSessionModels;
  modes?: AcpSessionModes;
  configOptions?: AcpConfigOption[];
}

/** Token counts for one turn, as `session/prompt` answers them. */
export interface AcpPromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpToolCallContent {
  type: string;
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string;
  newText?: string;
}

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: AcpToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface AcpSessionUpdate extends Omit<AcpToolCall, 'content' | 'toolCallId'> {
  sessionUpdate: string;
  toolCallId?: string;
  content?: AcpToolCallContent[] | { type: string; text?: string };
  configOptions?: AcpConfigOption[];
  /** The message a chunk belongs to, where the agent says. */
  messageId?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export const ACP_CANCELLED = { outcome: { outcome: 'cancelled' } } as const;

function choicesOf(option: AcpConfigOption): AcpConfigChoice[] {
  return (option.options ?? []).flatMap((choice) =>
    'value' in choice ? [choice] : choice.options
  );
}

/**
 * Models offered through a `model` select in the session's config options.
 * The reasoning effort a `thought_level` select offers is the current model's
 * alone, so only that model offers it, under the option's id; the session
 * announces another model's levels once it is selected.
 */
export function modelsFromConfig(options: AcpConfigOption[]): ModelChoice[] {
  const model = modelConfigOption(options);
  const effort = effortConfigOption(options);
  return (model ? choicesOf(model) : []).map((option) => ({
    id: option.value,
    label: option.name,
    options:
      effort && option.value === model?.currentValue
        ? { [effort.id]: choicesOf(effort).map((choice) => choice.value) }
        : {},
    imageInput: true,
  }));
}

/** The session's reasoning-effort select, if it has one. */
export function effortConfigOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.category === 'thought_level' && option.type === 'select');
}

export function modelConfigOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.id === 'model' && option.type === 'select');
}

/** Models offered through the session's `models` list. */
export function modelsFromList(models: AcpSessionModels | undefined): ModelChoice[] {
  return (models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    label: model.name,
    options: {},
  }));
}
