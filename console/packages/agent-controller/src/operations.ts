import {
  type BrowserSignInProvider,
  isBrowserSignInProvider,
} from '@switch-console/plugins/browser-sign-in';
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
  /**
   * Takes up the login Switch gave the machine for the provider now, as a
   * recheck does, and says why it is not used when it is not.
   */
  takeUpLogin: (
    provider: Provider
  ) => Promise<{ status: ProviderStatus; problem: { code: string; message: string } | null }>;
  /**
   * Signs the provider in through a browser for someone elsewhere, keeps the
   * login it ends with as one given to the machine and takes it up
   * (`signInWithBrowser`); resolves with the operation's result.
   */
  signInWithBrowser: (
    operationId: string,
    provider: BrowserSignInProvider
  ) => Promise<OperationResult>;
  /**
   * Arranges for this controller to end, once the running operations are
   * reported, for whatever runs it to start it again; resolves with why it
   * cannot (nothing would start it again), or null.
   */
  restartController: () => { reason: string; detail: string } | null;
  log: Logger;
};

function failed(code: string, message: string): OperationResult {
  return { outcome: 'failed', error: { code, message } };
}

/**
 * Runs one claimed operation: `agent.restart`, `controller.restart`,
 * `provider.recheck`, and `provider.login` with `method: "sealed"` or
 * `"browser"`; anything else is refused.
 */
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
    case 'controller.restart': {
      const failure = deps.restartController();
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
    case 'provider.login': {
      const { provider, method } = operation.params;
      if (typeof provider !== 'string' || !isProvider(provider))
        return failed(
          'validation_error',
          `provider.login needs params.provider set to a provider this controller runs; got ${JSON.stringify(provider)}.`
        );
      if (method === 'browser') {
        if (!isBrowserSignInProvider(provider))
          return failed(
            'operation_unsupported',
            `This controller signs only Claude Code, Codex, Cursor, Antigravity and OpenCode in through a browser, not ${provider}.`
          );
        return deps.signInWithBrowser(operation.id, provider);
      }
      if (method !== 'sealed')
        return failed(
          'operation_unsupported',
          `This controller takes up only logins sealed to it (method "sealed") or signs in through a browser (method "browser"), not ${JSON.stringify(method)}.`
        );
      const { status, problem } = await deps.takeUpLogin(provider);
      if (status.auth === 'ok') return { outcome: 'succeeded', output: { provider: status } };
      return failed(
        problem?.code ?? status.reason ?? 'provider_login_missing',
        problem?.message ?? `The ${provider} login given to this machine is not used.`
      );
    }
    default:
      return failed(
        'operation_unsupported',
        `This controller does not run '${operation.kind}' operations.`
      );
  }
}

/** A browser sign-in, which waits minutes on a person rather than on this machine. */
function isBrowserLogin(operation: Operation): boolean {
  return operation.kind === 'provider.login' && operation.params.method === 'browser';
}

async function runAndReport(operation: Operation, deps: OperationDeps): Promise<void> {
  let result: OperationResult;
  try {
    result = await executeOperation(operation, deps);
  } catch (error) {
    if (isRevoked(error)) throw error;
    deps.log.error('Operation failed', { operationId: operation.id, error: errorMessage(error) });
    result = failed('internal', errorMessage(error));
  }
  await deps.client.operationResult(operation.id, result);
  deps.log.info('Operation finished', {
    operationId: operation.id,
    kind: operation.kind,
    outcome: result.outcome,
    ...(result.outcome === 'failed' ? { code: result.error.code } : {}),
  });
}

/**
 * Lists the pending operations, then claims, runs and reports each in turn. An
 * operation another controller instance claimed first, or that was cancelled,
 * is skipped. A browser sign-in runs beside the others rather than before
 * them, as it waits on a person for minutes. Returns how many this call ran
 * or started.
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
    ran++;
    if (isBrowserLogin(operation)) {
      void runAndReport(operation, deps).catch((error: unknown) =>
        deps.log.warn('A browser sign-in ended without its result reaching Switch', {
          operationId: operation.id,
          error: errorMessage(error),
        })
      );
      continue;
    }
    await runAndReport(operation, deps);
  }
  return ran;
}
