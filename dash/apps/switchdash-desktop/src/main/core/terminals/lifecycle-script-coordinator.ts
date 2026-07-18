import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { LocationRuntime } from '@main/core/locations/location-runtime';
import { events } from '@main/lib/events';
import { redactDiagnosticLog } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import {
  lifecycleScriptStatusChannel,
  type LifecycleScriptOrigin,
  type LifecycleScriptType,
} from '@shared/core/sessions/sessionEvents';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import type { LifecycleScriptExecutionResult } from '../locations/lifecycle-service';

export type LifecycleScriptPolicy = {
  exit?: boolean;
  waitForExit?: boolean;
  respawnAfterExit?: boolean;
  timeoutMs?: number;
  logFailure: boolean;
  surfaceFailure: boolean;
  continueOnFailure: boolean;
};

export type LifecycleScriptCoordinatorResult =
  | { kind: 'succeeded'; result: LifecycleScriptExecutionResult }
  | { kind: 'failed'; message: string; result?: LifecycleScriptExecutionResult }
  | { kind: 'stopped' }
  | { kind: 'already-running' };

const activeSessions = new Set<string>();
const stoppedSessions = new Set<string>();

class LifecycleScriptTimeout extends Error {
  constructor(readonly ms: number) {
    super(`Lifecycle script timed out after ${ms}ms`);
  }
}

function withLifecycleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LifecycleScriptTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lifecycleScriptSessionId({
  locationId,
  type,
}: {
  locationId: string;
  type: LifecycleScriptType;
}): string {
  return makePtySessionId(locationId, locationId, createLifecycleScriptTerminalId(type));
}

export function stopLifecycleScriptSession({
  locationId,
  sessionId,
  type,
  origin,
}: {
  locationId: string;
  sessionId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
}): boolean {
  const ptySessionId = lifecycleScriptSessionId({ locationId, type });
  const pty = ptySessionRegistry.get(ptySessionId);
  if (!pty) return false;
  if (!activeSessions.has(ptySessionId)) return false;
  if (stoppedSessions.has(ptySessionId)) return false;

  stoppedSessions.add(ptySessionId);
  pty.kill();
  events.emit(lifecycleScriptStatusChannel, {
    locationId,
    sessionId,
    type,
    origin,
    status: 'stopped',
  });
  return true;
}

function labelFor(type: LifecycleScriptType): string {
  return type[0].toUpperCase() + type.slice(1);
}

function isSuccessfulResult(result: LifecycleScriptExecutionResult): boolean {
  if (result.kind === 'started' || result.kind === 'already-running') return true;
  return result.signal === undefined && (result.exitCode === 0 || result.exitCode === undefined);
}

function failureMessage(type: LifecycleScriptType, result: LifecycleScriptExecutionResult): string {
  const label = labelFor(type);
  if (result.kind === 'started') return `${label} script did not report an exit status.`;
  if (result.kind === 'already-running') return `${label} script is already running.`;
  if (result.signal !== undefined) return `${label} script exited with signal ${result.signal}.`;
  return `${label} script exited with code ${result.exitCode ?? 'unknown'}.`;
}

export async function runLifecycleScriptWithPolicy({
  runtime,
  locationId,
  sessionId,
  type,
  script,
  shellSetup,
  origin,
  policy,
  logPrefix,
}: {
  runtime: LocationRuntime;
  locationId: string;
  sessionId: string;
  type: LifecycleScriptType;
  script: string;
  shellSetup?: string;
  origin: LifecycleScriptOrigin;
  policy: LifecycleScriptPolicy;
  logPrefix: string;
}): Promise<LifecycleScriptCoordinatorResult> {
  const ptySessionId = lifecycleScriptSessionId({ locationId, type });
  if (activeSessions.has(ptySessionId)) {
    return { kind: 'already-running' };
  }

  activeSessions.add(ptySessionId);
  events.emit(lifecycleScriptStatusChannel, {
    locationId,
    sessionId,
    type,
    origin,
    status: 'running',
  });

  let result: LifecycleScriptExecutionResult | undefined;
  try {
    const execution = runtime.lifecycleService.runLifecycleScript(
      { type, script, shellSetup },
      {
        exit: policy.exit ?? true,
        waitForExit: policy.waitForExit ?? true,
        respawnAfterExit: policy.respawnAfterExit ?? false,
      }
    );
    result =
      policy.timeoutMs === undefined
        ? await execution
        : await withLifecycleTimeout(execution, policy.timeoutMs);

    if (result.kind === 'already-running') {
      return { kind: 'already-running' };
    }

    if (stoppedSessions.delete(ptySessionId)) {
      return { kind: 'stopped' };
    }

    if (isSuccessfulResult(result)) {
      events.emit(lifecycleScriptStatusChannel, {
        locationId,
        sessionId,
        type,
        origin,
        status: 'succeeded',
        ...(result.kind === 'exited' ? { exitCode: result.exitCode } : {}),
      });
      return { kind: 'succeeded', result };
    }

    return handleFailure({
      locationId,
      sessionId,
      type,
      origin,
      policy,
      logPrefix,
      message: failureMessage(type, result),
      result,
    });
  } catch (error: unknown) {
    if (stoppedSessions.delete(ptySessionId)) {
      return { kind: 'stopped' };
    }

    const message =
      error instanceof LifecycleScriptTimeout
        ? `${labelFor(type)} script timed out after ${policy.timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : `${labelFor(type)} script failed to run.`;

    return handleFailure({
      locationId,
      sessionId,
      type,
      origin,
      policy,
      logPrefix,
      message,
      result,
      error,
    });
  } finally {
    activeSessions.delete(ptySessionId);
    stoppedSessions.delete(ptySessionId);
  }
}

function handleFailure({
  locationId,
  sessionId,
  type,
  origin,
  policy,
  logPrefix,
  message,
  result,
  error,
}: {
  locationId: string;
  sessionId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
  policy: LifecycleScriptPolicy;
  logPrefix: string;
  message: string;
  result?: LifecycleScriptExecutionResult;
  error?: unknown;
}): LifecycleScriptCoordinatorResult {
  const outputTail =
    result?.kind === 'exited' && result.outputTail
      ? redactDiagnosticLog(result.outputTail)
      : undefined;

  if (policy.logFailure) {
    log.error(`${logPrefix}: ${type} script failed`, {
      sessionId,
      locationId,
      error: message,
      exitCode: result?.kind === 'exited' ? result.exitCode : undefined,
      signal: result?.kind === 'exited' ? result.signal : undefined,
      outputTail,
    });
  }

  events.emit(lifecycleScriptStatusChannel, {
    locationId,
    sessionId,
    type,
    origin,
    status: 'failed',
    message,
    surfaceFailure: policy.surfaceFailure,
    ...(result?.kind === 'exited'
      ? {
          exitCode: result.exitCode,
          signal: result.signal,
        }
      : {}),
  });

  const failure = { kind: 'failed' as const, message, result };
  if (policy.continueOnFailure) return failure;
  throw error ?? new Error(message);
}
