import type { ModelSelection, ProviderCapabilities, RuntimeMode } from '../adapter';
import type { SharedHostConfig } from './shared-config';

export type SharedHostProvider = SharedHostConfig['start']['provider'];

export interface BuildSharedHostConfigInput {
  session: {
    sessionId: string;
    agentId: string;
    provider: SharedHostProvider;
    nativeSessionId?: string;
  };
  launch: {
    cwd: string;
    runtimeMode: RuntimeMode;
    env: Readonly<Record<string, string>>;
    model?: ModelSelection;
  };
  capabilities: Pick<ProviderCapabilities, 'approvals' | 'userInput'>;
  roomConnection: {
    rooms: readonly string[];
    startCursor?: number;
  };
  execution: {
    credentialsPath: string;
    inheritEnv: readonly string[];
    shellSetup?: string;
    binaryPath?: string;
    mcpRuntime: string;
    codexConfig: string;
    skill: string;
    context: string;
    agentDefinition?: { name: string; path: string };
  };
  ids: {
    hostId: string;
    epoch: string;
    connectionId: string;
  };
}

/** Build the shared SDK host contract from values already resolved by its caller. */
export function buildSharedHostConfig(input: BuildSharedHostConfigInput): SharedHostConfig {
  const model = input.launch.model
    ? {
        ...input.launch.model,
        ...(input.launch.model.options ? { options: { ...input.launch.model.options } } : {}),
      }
    : undefined;
  return {
    session: {
      sessionId: input.session.sessionId,
      agentId: input.session.agentId,
      hostId: input.ids.hostId,
      epoch: input.ids.epoch,
      provider: input.session.provider,
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: input.capabilities.approvals,
        questions: input.capabilities.userInput,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: input.session.provider,
      input: {
        sessionId: input.session.sessionId,
        cwd: input.launch.cwd,
        runtimeMode: input.launch.runtimeMode,
        env: { ...input.launch.env },
        mcpServers: {},
        ...(input.session.nativeSessionId
          ? { resume: { nativeSessionId: input.session.nativeSessionId } }
          : {}),
        ...(model ? { model } : {}),
      },
    },
    roomConnection: {
      connectionId: input.ids.connectionId,
      rooms: [...input.roomConnection.rooms],
      startCursor: input.roomConnection.startCursor,
    },
    execution: {
      credentialsPath: input.execution.credentialsPath,
      inheritEnv: [...input.execution.inheritEnv],
      mcpRuntime: input.execution.mcpRuntime,
      codexConfig: input.execution.codexConfig,
      skill: input.execution.skill,
      context: input.execution.context,
      ...(input.execution.binaryPath ? { binaryPath: input.execution.binaryPath } : {}),
      ...(input.execution.shellSetup ? { shellSetup: input.execution.shellSetup } : {}),
      ...(input.execution.agentDefinition
        ? { agentDefinition: { ...input.execution.agentDefinition } }
        : {}),
    },
  };
}
