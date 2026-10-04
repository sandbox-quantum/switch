import { ControllerApiError, type ControllerClient, isRevoked } from './api';
import { errorMessage, type Logger } from './log';
import {
  type AgentAssignment,
  type Assignment,
  isProvider,
  type Operation,
  type OperationResult,
  type Provider,
  type ProviderStatus,
} from './schemas';

export type OperationDeps = {
  client: Pick<ControllerClient, 'pendingOperations' | 'claimOperation' | 'operationResult'>;
  /** The assignment as last pulled. */
  assignment: () => Assignment | null;
  /** Restarts the agent at its assigned revision; resolves with why it could not, or null. */
  restartAgent: (entry: AgentAssignment) => Promise<{ reason: string; detail: string } | null>;
  /** Checks the provider now and sends a status report carrying the result. */
  recheckProvider: (provider: Provider) => Promise<ProviderStatus>;
  log: Logger;
};

function failed(code: string, message: string): OperationResult {
  return { outcome: 'failed', error: { code, message } };
}

/** Runs one claimed operation. v1 runs `agent.restart` and `provider.recheck`; anything else is refused. */
export async function executeOperation(
  operation: Operation,
  deps: OperationDeps
): Promise<OperationResult> {
  switch (operation.kind) {
    case 'agent.restart': {
      if (!operation.agent_id) return failed('validation_error', 'agent.restart names no agent.');
      const entry = deps
        .assignment()
        ?.agents.find((agent) => agent.agent_id === operation.agent_id);
      if (!entry)
        return failed(
          'not_assigned',
          `Agent ${operation.agent_id} is not assigned to this controller.`
        );
      if (entry.desired_state !== 'running')
        return failed(
          'validation_error',
          `Agent ${operation.agent_id} is assigned as ${entry.desired_state}; only a running agent is restarted.`
        );
      const failure = await deps.restartAgent(entry);
      if (failure) return failed(failure.reason, failure.detail);
      return { outcome: 'succeeded' };
    }
    case 'provider.recheck': {
      const provider = operation.params.provider;
      if (typeof provider !== 'string' || !isProvider(provider))
        return failed(
          'validation_error',
          `provider.recheck needs params.provider set to a provider this controller runs; got ${JSON.stringify(provider)}.`
        );
      const status = await deps.recheckProvider(provider);
      return { outcome: 'succeeded', output: { provider: status } };
    }
    default:
      return failed(
        'operation_unsupported',
        `This controller does not run '${operation.kind}' operations.`
      );
  }
}

/**
 * Lists the pending operations, then claims, runs and reports each in turn. An
 * operation another controller instance claimed first, or that was cancelled,
 * is skipped. Returns how many this call ran.
 */
export async function processPendingOperations(deps: OperationDeps): Promise<number> {
  const pending = await deps.client.pendingOperations();
  let ran = 0;
  for (const listed of pending) {
    let operation: Operation;
    try {
      operation = await deps.client.claimOperation(listed.id);
    } catch (error) {
      if (
        error instanceof ControllerApiError &&
        ['already_claimed', 'cancelled', 'lease_expired', 'not_found'].includes(error.code)
      ) {
        deps.log.debug('Skipping an operation that is no longer this controller’s', {
          operationId: listed.id,
          code: error.code,
        });
        continue;
      }
      throw error;
    }
    let result: OperationResult;
    try {
      result = await executeOperation(operation, deps);
    } catch (error) {
      if (isRevoked(error)) throw error;
      deps.log.error('Operation failed', { operationId: operation.id, error: errorMessage(error) });
      result = failed('internal', errorMessage(error));
    }
    await deps.client.operationResult(operation.id, result);
    ran++;
    deps.log.info('Operation finished', {
      operationId: operation.id,
      kind: operation.kind,
      outcome: result.outcome,
      ...(result.outcome === 'failed' ? { code: result.error.code } : {}),
    });
  }
  return ran;
}
