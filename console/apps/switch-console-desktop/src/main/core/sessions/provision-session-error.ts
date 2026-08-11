import type { ProvisionStep } from '@shared/core/sessions/sessionEvents';
import { TimeoutSignal } from '../locations/utils';

export const SESSION_TIMEOUT_MS = 600_000;
export const TEARDOWN_SCRIPT_WAIT_MS = 10_000;

export type ProvisionSessionError =
  | { type: 'timeout'; message: string; timeout: number; step: ProvisionStep | null }
  | { type: 'error'; message: string };

export type TeardownSessionError =
  | { type: 'timeout'; message: string; timeout: number }
  | { type: 'error'; message: string };

export function toProvisionError(
  e: unknown,
  step: ProvisionStep | null = null
): ProvisionSessionError {
  if (isProvisionSessionError(e)) return e;
  if (e instanceof TimeoutSignal)
    return { type: 'timeout', message: e.message, timeout: e.ms, step };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

export function toTeardownError(e: unknown): TeardownSessionError {
  if (e instanceof TimeoutSignal) return { type: 'timeout', message: e.message, timeout: e.ms };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

export function isProvisionSessionError(e: unknown): e is ProvisionSessionError {
  if (!e || typeof e !== 'object' || !('type' in e)) return false;
  const type = (e as { type?: string }).type;
  return type === 'timeout' || type === 'error';
}

export function formatTeardownSessionError(error: TeardownSessionError): string {
  switch (error.type) {
    case 'timeout':
      return error.message;
    case 'error':
      return error.message;
  }
}

export function formatProvisionSessionError(error: ProvisionSessionError): string {
  switch (error.type) {
    case 'timeout':
      return error.step ? `${error.message} (step: ${error.step})` : error.message;
    case 'error':
      return error.message;
  }
}
