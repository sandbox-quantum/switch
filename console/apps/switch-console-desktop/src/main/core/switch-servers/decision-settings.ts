import {
  clearDecisionSettings,
  fetchDecisionSettings,
  GatewayError,
  testDecisionSettings,
  updateDecisionSettings,
} from '@main/core/switch-servers/gateway-client';
import type {
  ClearDecisionSettingsResult,
  DecisionSettingsInput,
  DecisionTestInput,
  FetchDecisionSettingsResult,
  SwitchServer,
  TestDecisionSettingsResult,
  UpdateDecisionSettingsResult,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Load the decision routing settings of the workspace the session selects,
 * mapping recoverable gateway failures the way Switch Trust's settings do: a
 * member who isn't the workspace's admin gets `forbidden` rather than a
 * thrown error, so the section can say why.
 *
 * The caller selects the workspace (`withReachableWorkspaceSession`); these
 * routes answer for whichever workspace the session names.
 */
export async function fetchDecisionSettingsFromServer(
  server: SwitchServer
): Promise<FetchDecisionSettingsResult> {
  try {
    return { kind: 'loaded', settings: await fetchDecisionSettings(server) };
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'http' && cause.status === 404) {
      return { kind: 'unsupported' };
    }
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/**
 * Save the selected workspace's decision settings. A refusal of the values
 * (a threshold out of range, a URL that isn't http(s), Bedrock the server
 * doesn't allow) is `invalid` with the gateway's own sentence; an unexpected
 * 500 still throws, since it is a bug rather than a form error.
 */
export async function updateDecisionSettingsOnServer(
  server: SwitchServer,
  input: DecisionSettingsInput
): Promise<UpdateDecisionSettingsResult> {
  try {
    return { kind: 'saved', settings: await updateDecisionSettings(server, input) };
  } catch (cause) {
    const invalid = invalidResult(cause);
    if (invalid) return invalid;
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/** Return the selected workspace to the server default, answering with the
 * settings as they now stand. */
export async function clearDecisionSettingsOnServer(
  server: SwitchServer
): Promise<ClearDecisionSettingsResult> {
  try {
    return { kind: 'cleared', settings: await clearDecisionSettings(server) };
  } catch (cause) {
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/** Run one sample decision against unsaved values, or the server default. A
 * decision that failed is `tested` with the reason in its outcome; only a
 * refused request is not. */
export async function testDecisionSettingsOnServer(
  server: SwitchServer,
  input: DecisionTestInput
): Promise<TestDecisionSettingsResult> {
  try {
    return { kind: 'tested', outcome: await testDecisionSettings(server, input) };
  } catch (cause) {
    const invalid = invalidResult(cause);
    if (invalid) return invalid;
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/**
 * A 400 or 422, with the gateway's explanation. FastAPI's own validation
 * answers with a list of `{loc, msg}` rather than a sentence, so those are
 * joined: "Input should be less than or equal to 1" reads better in a form
 * than the status line and raw JSON.
 */
function invalidResult(cause: unknown): { kind: 'invalid'; message: string } | null {
  if (!(cause instanceof GatewayError) || cause.kind !== 'http') return null;
  if (cause.status !== 400 && cause.status !== 422) return null;
  return {
    kind: 'invalid',
    message: cause.detail ?? validationMessages(cause.body) ?? cause.message,
  };
}

function validationMessages(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (!Array.isArray(parsed.detail)) return null;
    const messages = parsed.detail
      .map((item: unknown) => fieldMessage(item))
      .filter((message): message is string => message !== null);
    return messages.length > 0 ? messages.join('; ') : null;
  } catch {
    return null;
  }
}

function fieldMessage(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const { loc, msg } = item as { loc?: unknown; msg?: unknown };
  if (typeof msg !== 'string') return null;
  const field = Array.isArray(loc) ? loc.filter((part) => part !== 'body').at(-1) : undefined;
  return typeof field === 'string' ? `${field}: ${msg}` : msg;
}

/** The failure cases every decision settings call can produce, all behind the
 * same workspace-admin gate. */
function recoverableResult(
  cause: unknown
): { kind: 'unauthenticated' } | { kind: 'forbidden' } | { kind: 'error'; message: string } | null {
  if (!(cause instanceof GatewayError)) return null;
  if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
  if (cause.kind === 'network') return { kind: 'error', message: cause.message };
  if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
  return null;
}
